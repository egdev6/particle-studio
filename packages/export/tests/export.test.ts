import { execFileSync, spawn } from "node:child_process";
import { runInNewContext } from "node:vm";
import { rolldown } from "rolldown";
import { beforeAll, describe, expect, it } from "vitest";

import { genuineIifeProvider } from "./iife-test-support.js";

import type { SceneDocumentV1 } from "@particle-studio/scene-document";
import type {
  ApprovalRecord,
  ContentAddressedAsset,
} from "@particle-studio/persistence";
import type { EvaluationResult } from "@particle-studio/runtime";
import type {
  PortableIifeBundle,
  PortableIifeBundleInput,
  PortableIifeBundleProvider,
  PortableRuntimeGraph,
  PortableRuntimeGraphProvider,
  PortableVirtualModule,
} from "../src/index.js";

const workspaceRoot = new URL("../../../", import.meta.url);
const prepareValidator = () => {
  execFileSync("npm", ["run", "validator:prepare"], {
    cwd: workspaceRoot,
    stdio: "pipe",
  });
};

prepareValidator();

const {
  FIRST_SLICE_DOCUMENT,
  createApprovalEnvelope,
  readCanonicalApprovalEvidence,
} = await import("@particle-studio/scene-document");
const { createApprovalRecord, createContentAddressedAsset } = await import(
  "@particle-studio/persistence"
);
const { evaluateScene, RUNTIME_VERSION } = await import(
  "@particle-studio/runtime"
);
const {
  buildApprovedEsmVirtualMap,
  buildApprovedWebComponentVirtualMap,
  buildApprovedIifeVirtualMap,
  buildApprovedSelfContainedHtmlVirtualMap,
  selfContainedRuntimeEntrySource,
} = await import("../src/index.js");

beforeAll(prepareValidator);

const platform = globalThis as unknown as {
  readonly crypto: {
    readonly subtle: {
      digest(name: string, data: Uint8Array): Promise<ArrayBuffer>;
    };
  };
};

async function hash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await platform.crypto.subtle.digest("SHA-256", bytes),
  );
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function module(path: string, source: string) {
  const bytes = new TextEncoder().encode(source);
  return { path, bytes, sha256: await hash(bytes) };
}

async function graph(
  files?: readonly Awaited<ReturnType<typeof module>>[],
  entryPath = "runtime/entry.js",
): Promise<PortableRuntimeGraph> {
  return {
    entryPath,
    files: files ?? [
      await module(
        "runtime/engine.js",
        "export function evaluateScene(document, timeUs) { return { document, timeUs }; }\n",
      ),
      await module(
        "runtime/entry.js",
        "export { evaluateScene } from './engine.js';\n",
      ),
    ],
  };
}

function provider(
  ...graphs: readonly PortableRuntimeGraph[]
): PortableRuntimeGraphProvider {
  let index = 0;
  return {
    async provide() {
      const result = graphs[Math.min(index, graphs.length - 1)]!;
      index += 1;
      return result;
    },
  };
}

async function approval(
  document: SceneDocumentV1 = structuredClone(FIRST_SLICE_DOCUMENT),
  assets: readonly ContentAddressedAsset[] = [],
  runtimeVersion = RUNTIME_VERSION,
): Promise<ApprovalRecord> {
  const envelope = await createApprovalEnvelope({
    document,
    runtimeVersion,
    verifiedAssetManifest: assets.map(({ sha256, mimeType, byteLength }) => ({
      sha256,
      mimeType,
      byteLength,
    })),
  });
  const evidence = readCanonicalApprovalEvidence(envelope);
  return createApprovalRecord({
    documentId: "document-1",
    revisionId: "revision-1",
    approvalEnvelope: envelope,
    snapshotHash: evidence.snapshotHash,
    approvalEnvelopeBytes: evidence.approvalEnvelopeBytes,
    canonicalDocumentBytes: evidence.canonicalDocumentBytes,
    verifiedAssetManifest: evidence.verifiedAssetManifest,
    audit: { approvedAt: 1, actorLabel: "local-human" },
  });
}

function assetsByHash(assets: readonly ContentAddressedAsset[]) {
  return {
    async readAsset(sha256: string) {
      const asset = assets.find((candidate) => candidate.sha256 === sha256);
      if (!asset) throw new Error("missing");
      return asset;
    },
  };
}

async function buildGenuineRuntimeGraph(): Promise<PortableRuntimeGraph> {
  const bridgeId = "virtual:particle-studio-runtime-bridge";
  const bundle = await rolldown({
    input: { entry: bridgeId },
    external: [],
    treeshake: false,
    plugins: [
      {
        name: "particle-studio-runtime-bridge",
        resolveId(source) {
          return source === bridgeId ? bridgeId : null;
        },
        load(identifier) {
          return identifier === bridgeId
            ? "export { evaluateScene } from '@particle-studio/runtime';\nexport { renderCommands } from '@particle-studio/renderer-canvas2d';\n"
            : null;
        },
      },
    ],
  });
  try {
    const generated = await bundle.generate({
      format: "es",
      preserveModules: true,
      entryFileNames: "entry.js",
      chunkFileNames: "chunks/[name]-[hash].js",
      assetFileNames: "assets/[name]-[hash][extname]",
      sourcemap: false,
    });
    const files = [] as Array<Awaited<ReturnType<typeof module>>>;
    for (const output of generated.output) {
      if (output.type !== "chunk" || !output.fileName.endsWith(".js")) {
        throw new Error("unexpected Rolldown output");
      }
      files.push(await module(`runtime/${output.fileName}`, output.code));
    }
    const entry = files.find((file) => file.path === "runtime/entry.js");
    if (!entry) throw new Error("Rolldown entry missing");
    return {
      entryPath: entry.path,
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
    };
  } finally {
    await bundle.close();
  }
}

async function genuineRuntimeProvider(): Promise<PortableRuntimeGraphProvider> {
  const first = await buildGenuineRuntimeGraph();
  const second = await buildGenuineRuntimeGraph();
  expect(first).toEqual(second);
  return provider(first, second);
}

async function executeEmittedEntry(
  files: ReturnType<typeof buildApprovedEsmVirtualMap> extends Promise<
    infer Result
  >
    ? Result extends { readonly files: infer Map }
      ? Map
      : never
    : never,
  moduleEntry: string,
  times: readonly number[],
  resolverTokens: Readonly<Record<string, object>> = {},
) {
  const payload = JSON.stringify({
    files: files
      .entries()
      .map(([path, bytes]) => [path, Buffer.from(bytes).toString("base64")]),
    moduleEntry,
    times,
    resolverTokens,
  });
  const runner = String.raw`
    import vm from "node:vm";
    const input = JSON.parse(await (async () => { let value = ""; for await (const chunk of process.stdin) value += chunk; return value; })());
    const files = new Map(input.files.map(([path, bytes]) => [path, Buffer.from(bytes, "base64").toString("utf8")]));
const resolve = (source, specifier) => {
          if (
            (!specifier.startsWith("./") && !specifier.startsWith("../")) ||
            /[\u0000-\u001f\u007f\\%?#:]/.test(specifier) ||
            /\s/.test(specifier)
          ) throw new Error("invalid virtual module specifier");
          const parts = source.split("/").slice(0, -1);
          const segments = specifier.split("/");
if (
            segments.some((segment) => segment === "") ||
            [".", ".."].includes(segments[segments.length - 1])
          ) {
            throw new Error("invalid virtual module specifier");
          }
          for (const segment of segments) {
if (segment === ".") continue;
            if (segment === "..") {
              if (parts.length === 0) throw new Error("invalid virtual module specifier");
              parts.pop();
            } else {
              parts.push(segment);
            }
      }
      return parts.join("/");
    };
    const context = vm.createContext({ structuredClone, TextEncoder, TextDecoder, crypto });
    const modules = new Map();
    const moduleFor = (path) => {
      if (modules.has(path)) return modules.get(path);
      const source = files.get(path);
      if (source === undefined) throw new Error("missing virtual module " + path);
      const created = new vm.SourceTextModule(source, {
        context,
        identifier: path,
        importModuleDynamically: async (specifier, referencingModule) => {
          const target = moduleFor(resolve(referencingModule.identifier, specifier));
          if (target.status === "unlinked") await target.link(linker);
          if (target.status !== "evaluated") await target.evaluate();
          return target;
        },
      });
      modules.set(path, created);
      return created;
    };
    const linker = async (specifier, referencingModule) => moduleFor(resolve(referencingModule.identifier, specifier));
    const entry = moduleFor(input.moduleEntry);
    await entry.link(linker);
        await entry.evaluate();
        const imageResolver = {
          resolve(reference) {
            const token = input.resolverTokens[reference.sha256];
            return token === undefined ? undefined : { handle: token, ...reference };
          },
        };
        console.log(JSON.stringify({
          document: entry.namespace.approvedDocument,
          evaluations: input.times.map((time) =>
            entry.namespace.evaluateAt(time, Object.keys(input.resolverTokens).length === 0
              ? undefined
              : { imageResolver }),
          ),
        }));
  `;
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-vm-modules", "--input-type=module", "-e", runner],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      errors += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(output) : reject(new Error(errors)),
    );
    child.stdin.end(payload);
  });
  return JSON.parse(stdout) as {
    readonly document: SceneDocumentV1;
    readonly evaluations: readonly EvaluationResult[];
  };
}

describe("approved ESM virtual export", () => {
  it("rejects a structural approval copy before provider output can escape", async () => {
    let providerCalls = 0;
    await expect(
      buildApprovedEsmVirtualMap({
        approval: {},
        assets: { readAsset: async () => ({}) as ContentAddressedAsset },
        runtimeGraphProvider: {
          provide: async () => {
            providerCalls += 1;
            return graph();
          },
        },
      }),
    ).rejects.toThrow("EXPORT_APPROVAL_INVALID");
    expect(providerCalls).toBe(0);
    const genuine = await approval();
    await expect(
      buildApprovedEsmVirtualMap({
        approval: { ...genuine, snapshotHash: `sha256:${"0".repeat(64)}` },
        assets: assetsByHash([]),
        runtimeGraphProvider: provider(await graph()),
      }),
    ).rejects.toThrow("EXPORT_APPROVAL_INVALID");
  });

  it("revalidates current runtime evidence and atomically finalizes a deterministic canonical graph", async () => {
    const approved = await approval();
    const runtime = await graph();
    const first = await buildApprovedEsmVirtualMap({
      approval: approved,
      assets: assetsByHash([]),
      runtimeGraphProvider: provider(runtime, runtime),
    });
    const second = await buildApprovedEsmVirtualMap({
      approval: approved,
      assets: assetsByHash([]),
      runtimeGraphProvider: provider(runtime, runtime),
    });

    expect(first.files.paths).toEqual([
      "generated/approved-document.js",
      "generated/approved-entry.js",
      "manifest.json",
      "runtime/engine.js",
      "runtime/entry.js",
      "scene-document.json",
    ]);
    expect(first.files.entries()).toEqual(second.files.entries());
    expect(first.manifest).toEqual(second.manifest);
    expect(first.manifest).toMatchObject({
      snapshotHash: approved.snapshotHash,
      schemaVersion: 1,
      embeddedAssetBytes: 0,
      canonicalizationVersion: "jcs-1",
      runtimeVersion: RUNTIME_VERSION,
      assetHashes: [],
      adapterName: "esm",
      packagingPolicy: "adjacent-assets-v1",
      moduleEntry: "generated/approved-entry.js",
    });
    for (const [path, expectedHash] of Object.entries(
      first.manifest.fileHashes,
    )) {
      expect(await hash(first.files.get(path)!)).toBe(expectedHash);
    }
    expect(first.files.get("manifest.json")).toEqual(
      new TextEncoder().encode(JSON.stringify(first.manifest)),
    );
    expect(first.files.get("manifest.json")).not.toHaveProperty(
      "fileHashes.manifest.json",
    );

    const returned = first.files.get("runtime/entry.js")!;
    returned[0] = 0;
    expect(first.files.get("runtime/entry.js")![0]).not.toBe(0);
    expect(Object.isFrozen(first.files.paths)).toBe(true);
    expect(() => (first.document.elements[0]!.opacity = 0)).toThrow(TypeError);
    expect(first.document.elements[0]!.opacity).toBe(1);
    for (const timeUs of [0, 250_000, 500_000, 1_000_000]) {
      expect(first.evaluateAt(timeUs)).toEqual(
        evaluateScene(FIRST_SLICE_DOCUMENT, timeUs),
      );
    }
  });

  it("rejects stale runtime authority and reread asset absence, metadata, length, and SHA mismatches", async () => {
    const runtime = await graph();
    await expect(
      buildApprovedEsmVirtualMap({
        approval: await approval(
          structuredClone(FIRST_SLICE_DOCUMENT),
          [],
          "runtime-old",
        ),
        assets: assetsByHash([]),
        runtimeGraphProvider: provider(runtime, runtime),
      }),
    ).rejects.toThrow("EXPORT_APPROVAL_RUNTIME_VERSION_MISMATCH");

    const bytes = new Uint8Array([1, 2, 3]);
    const validAsset = createContentAddressedAsset({
      sha256: await hash(bytes),
      mimeType: "image/png",
      byteLength: bytes.byteLength,
      bytes,
    });
    const imageDocument = {
      ...structuredClone(FIRST_SLICE_DOCUMENT),
      rootIds: ["image-1"],
      elements: [
        {
          id: "image-1",
          type: "image",
          asset: {
            sha256: validAsset.sha256,
            mimeType: validAsset.mimeType,
            byteLength: validAsset.byteLength,
            intrinsicWidth: 1,
            intrinsicHeight: 1,
          },
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          opacity: 1,
        },
      ],
      tracks: [],
    } as SceneDocumentV1;
    const approved = await approval(imageDocument, [validAsset]);
    for (const [asset, code] of [
      [undefined, "EXPORT_ASSET_UNAVAILABLE"],
      [
        createContentAddressedAsset({
          sha256: validAsset.sha256,
          mimeType: "image/jpeg",
          byteLength: bytes.byteLength,
          bytes,
        }),
        "EXPORT_ASSET_MISMATCH",
      ],
      [
        createContentAddressedAsset({
          sha256: validAsset.sha256,
          mimeType: "image/png",
          byteLength: 2,
          bytes: new Uint8Array([1, 2]),
        }),
        "EXPORT_ASSET_MISMATCH",
      ],
      [
        createContentAddressedAsset({
          sha256: validAsset.sha256,
          mimeType: "image/png",
          byteLength: bytes.byteLength,
          bytes: new Uint8Array([9, 9, 9]),
        }),
        "EXPORT_ASSET_MISMATCH",
      ],
    ] as const) {
      await expect(
        buildApprovedEsmVirtualMap({
          approval: approved,
          assets: asset ? assetsByHash([asset]) : assetsByHash([]),
          runtimeGraphProvider: provider(runtime, runtime),
        }),
      ).rejects.toThrow(code);
    }
  });

  it("validates provider path, declaration, graph closure, hashes, and repeat stability before finalization", async () => {
    const approved = await approval();
    const valid = await graph();
    const cases: Array<[string, PortableRuntimeGraphProvider, string]> = [
      [
        "provider failure",
        {
          provide: async () =>
            Promise.reject(new Error("build authority unavailable")),
        },
        "EXPORT_GRAPH_PROVIDER_FAILED",
      ],
      [
        "missing declared import",
        provider(
          await graph([
            await module("runtime/entry.js", "import './missing.js';\n"),
          ]),
        ),
        "EXPORT_GRAPH_INVALID",
      ],
      [
        "bare import",
        provider(
          await graph([
            await module("runtime/entry.js", "import 'external';\n"),
          ]),
        ),
        "EXPORT_GRAPH_INVALID",
      ],
      [
        "unreachable declared file",
        provider(
          await graph([
            await module("runtime/entry.js", "export const entry = true;\n"),
            await module("runtime/unused.js", "export const unused = true;\n"),
          ]),
        ),
        "EXPORT_GRAPH_INVALID",
      ],
      [
        "duplicate path",
        provider(
          await graph([
            await module("runtime/entry.js", "export const first = true;\n"),
            await module("runtime/entry.js", "export const second = true;\n"),
          ]),
        ),
        "EXPORT_GRAPH_INVALID",
      ],
      [
        "escaping path",
        provider(
          await graph(
            [await module("../entry.js", "export {};\n")],
            "../entry.js",
          ),
        ),
        "EXPORT_GRAPH_INVALID",
      ],
      [
        "hash mismatch",
        provider({
          entryPath: "runtime/entry.js",
          files: [
            {
              ...(await module("runtime/entry.js", "export {};\n")),
              sha256: "sha256:bad",
            },
          ],
        }),
        "EXPORT_GRAPH_INVALID",
      ],
      [
        "unstable output",
        provider(
          valid,
          await graph([
            await module("runtime/entry.js", "export const changed = true;\n"),
          ]),
        ),
        "EXPORT_GRAPH_UNSTABLE",
      ],
    ];
    for (const [, runtimeGraphProvider, code] of cases) {
      await expect(
        buildApprovedEsmVirtualMap({
          approval: approved,
          assets: assetsByHash([]),
          runtimeGraphProvider,
        }),
      ).rejects.toThrow(code);
    }
  });

  it("rejects non-native declared paths and import specifiers atomically", async () => {
    const approved = await approval();
    const rejectedDeclaredPaths = [
      "runtime//entry.js",
      "runtime/entry.js/",
      "runtime/\u0000entry.js",
      "runtime/entry\u007f.js",
    ];
    for (const path of rejectedDeclaredPaths) {
      let calls = 0;
      await expect(
        buildApprovedEsmVirtualMap({
          approval: approved,
          assets: assetsByHash([]),
          runtimeGraphProvider: {
            async provide() {
              calls += 1;
              return graph(
                [
                  await module(
                    path,
                    "export function evaluateScene(document, timeUs) { return { document, timeUs }; }\n",
                  ),
                ],
                path,
              );
            },
          },
        }),
      ).rejects.toThrow("EXPORT_GRAPH_INVALID");
      expect(calls).toBe(1);
    }

    const rejectedImports = [
      [
        "static doubled separator",
        "./foo//engine.js",
        "import './foo//engine.js'; export function evaluateScene(document, timeUs) { return { document, timeUs }; }\n",
        "runtime/foo/engine.js",
      ],
      [
        "re-export trailing separator",
        "./foo/engine.js/",
        "export { value } from './foo/engine.js/'; export function evaluateScene(document, timeUs) { return { document, timeUs }; }\n",
        "runtime/foo/engine.js",
      ],
      [
        "literal dynamic escaped NUL",
        "./engine\\x00.js",
        "export const load = () => import('./engine\\x00.js'); export function evaluateScene(document, timeUs) { return { document, timeUs }; }\n",
        "runtime/engine\u0000.js",
      ],
      [
        "static raw NUL",
        "./engine\u0000.js",
        "import './engine\u0000.js'; export function evaluateScene(document, timeUs) { return { document, timeUs }; }\n",
        "runtime/engine\u0000.js",
      ],
    ] as const;
    for (const [, specifier, source, target] of rejectedImports) {
      let calls = 0;
      await expect(
        buildApprovedEsmVirtualMap({
          approval: approved,
          assets: assetsByHash([]),
          runtimeGraphProvider: {
            async provide() {
              calls += 1;
              return graph([
                await module(target, "export const value = true;\n"),
                await module("runtime/entry.js", source),
              ]);
            },
          },
        }),
      ).rejects.toThrow("EXPORT_GRAPH_INVALID");
      expect(calls).toBe(1);
      expect(specifier).toBeTruthy();
    }
  });

  it("rejects terminal dot segments without finalizing a virtual map", async () => {
    const approved = await approval();
    const terminalSpecifiers = [
      [
        "static terminal dot",
        "./foo/.",
        "import './foo/.'; export function evaluateScene(document, timeUs) { return { document, timeUs }; }\n",
        "runtime/foo",
      ],
      [
        "static terminal dot-dot",
        "./foo/..",
        "import './foo/..'; export function evaluateScene(document, timeUs) { return { document, timeUs }; }\n",
        "runtime",
      ],
      [
        "re-export terminal dot",
        "./foo/.",
        "export { value } from './foo/.'; export function evaluateScene(document, timeUs) { return { document, timeUs }; }\n",
        "runtime/foo",
      ],
      [
        "re-export terminal dot-dot",
        "./foo/..",
        "export { value } from './foo/..'; export function evaluateScene(document, timeUs) { return { document, timeUs }; }\n",
        "runtime",
      ],
      [
        "literal dynamic terminal dot",
        "./foo/.",
        "export const load = () => import('./foo/.'); export function evaluateScene(document, timeUs) { return { document, timeUs }; }\n",
        "runtime/foo",
      ],
      [
        "literal dynamic terminal dot-dot",
        "./foo/..",
        "export const load = () => import('./foo/..'); export function evaluateScene(document, timeUs) { return { document, timeUs }; }\n",
        "runtime",
      ],
    ] as const;
    const outcomes = await Promise.all(
      terminalSpecifiers.map(async ([, specifier, source, target]) => {
        let calls = 0;
        let escaped = false;
        await buildApprovedEsmVirtualMap({
          approval: approved,
          assets: assetsByHash([]),
          runtimeGraphProvider: {
            async provide() {
              calls += 1;
              return graph([
                await module(target, "export const value = true;\n"),
                await module("runtime/entry.js", source),
              ]);
            },
          },
        }).then(
          () => {
            escaped = true;
          },
          (error: unknown) => {
            expect(error).toHaveProperty("message", "EXPORT_GRAPH_INVALID");
          },
        );
        return { specifier, calls, escaped };
      }),
    );
    expect(outcomes).toEqual(
      terminalSpecifiers.map(([, specifier]) => ({
        specifier,
        calls: 1,
        escaped: false,
      })),
    );

    const validInternalNormalization = await graph([
      await module(
        "runtime/engine.js",
        "export function evaluateScene(document, timeUs) { return { document, timeUs }; }\n",
      ),
      await module(
        "runtime/entry.js",
        "export { evaluateScene } from './foo/../engine.js'; export { evaluateScene as parentEvaluateScene } from './foo/entry.js';\n",
      ),
      await module(
        "runtime/foo/entry.js",
        "export { evaluateScene } from '../engine.js';\n",
      ),
    ]);
    await expect(
      buildApprovedEsmVirtualMap({
        approval: approved,
        assets: assetsByHash([]),
        runtimeGraphProvider: provider(
          validInternalNormalization,
          validInternalNormalization,
        ),
      }),
    ).resolves.toMatchObject({
      manifest: { moduleEntry: "generated/approved-entry.js" },
    });
  });

  it("rejects a provider collision with the generated adapter path", async () => {
    const runtime = await graph(
      [
        await module(
          "generated/approved-entry.js",
          "export function evaluateScene() {}\n",
        ),
      ],
      "generated/approved-entry.js",
    );
    await expect(
      buildApprovedEsmVirtualMap({
        approval: await approval(),
        assets: assetsByHash([]),
        runtimeGraphProvider: provider(runtime, runtime),
      }),
    ).rejects.toThrow("EXPORT_GRAPH_INVALID");
  });

  it("preserves zero and one-image evaluation semantics at fixed times with equivalent verified resolvers", async () => {
    const bytes = new Uint8Array([11, 12, 13]);
    const asset = createContentAddressedAsset({
      sha256: await hash(bytes),
      mimeType: "image/png",
      byteLength: bytes.byteLength,
      bytes,
    });
    const document = {
      ...structuredClone(FIRST_SLICE_DOCUMENT),
      rootIds: ["image-1", "shape-1"],
      elements: [
        {
          id: "image-1",
          type: "image",
          asset: {
            sha256: asset.sha256,
            mimeType: asset.mimeType,
            byteLength: asset.byteLength,
            intrinsicWidth: 4,
            intrinsicHeight: 3,
          },
          x: 1,
          y: 2,
          width: 4,
          height: 3,
          opacity: 1,
        },
        structuredClone(FIRST_SLICE_DOCUMENT.elements[0]),
      ],
    } as SceneDocumentV1;
    const runtime = await graph();
    const exported = await buildApprovedEsmVirtualMap({
      approval: await approval(document, [asset]),
      assets: assetsByHash([asset]),
      runtimeGraphProvider: provider(runtime, runtime),
    });
    expect(exported.manifest.assetHashes).toEqual([asset.sha256]);
    expect(exported.files.get(`assets/${asset.sha256.slice(7)}`)).toEqual(
      bytes,
    );
    const previewHandle = { kind: "verified-token" };
    const exportHandle = { kind: "verified-token" };
    const previewResolver = {
      resolve: (reference: (typeof document.elements)[0]["asset"]) => ({
        handle: previewHandle,
        ...reference,
      }),
    };
    const exportResolver = {
      resolve: (reference: (typeof document.elements)[0]["asset"]) => ({
        handle: exportHandle,
        ...reference,
      }),
    };
    for (const timeUs of [0, 500_000, 1_000_000]) {
      expect(
        exported.evaluateAt(timeUs, { imageResolver: exportResolver }),
      ).toEqual(
        evaluateScene(document, timeUs, { imageResolver: previewResolver }),
      );
    }
  });

  it("fails closed on parser and module-URL graph bypasses", async () => {
    const approved = await approval();
    const rejectedSources = [
      ["./%2e%2e/escaped.js", "import './%2e%2e/escaped.js';\n"],
      ["./engine.js?cache=1", "import './engine.js?cache=1';\n"],
      ["./engine.js#fragment", "import './engine.js#fragment';\n"],
      ["./engine.js?cache=1", "export { value } from './engine.js?cache=1';\n"],
      [
        "./engine.js",
        "const load = () => import(`./engine.js`); export { load };\n",
      ],
      [
        "./engine.js",
        "const load = () => import('./' + 'engine.js'); export { load };\n",
      ],
    ] as const;
    for (const [specifier, source] of rejectedSources) {
      const target = specifier.slice(2);
      const runtime = await graph([
        await module(`runtime/${target}`, "export const value = true;\n"),
        await module("runtime/entry.js", source),
      ]);
      await expect(
        buildApprovedEsmVirtualMap({
          approval: approved,
          assets: assetsByHash([]),
          runtimeGraphProvider: provider(runtime, runtime),
        }),
      ).rejects.toThrow("EXPORT_GRAPH_INVALID");
    }
  });

  it("accepts static imports when regular-expression text resembles a dynamic import", async () => {
    const runtime = await graph([
      await module("runtime/engine.js", "export const value = true;\n"),
      await module(
        "runtime/entry.js",
        "import { value } from './engine.js'; const pattern = /import\\(['\"]external['\"]\\)/; export { pattern, value }; export function evaluateScene(document, timeUs) { return { document, timeUs }; }\n",
      ),
    ]);
    await expect(
      buildApprovedEsmVirtualMap({
        approval: await approval(),
        assets: assetsByHash([]),
        runtimeGraphProvider: provider(runtime, runtime),
      }),
    ).resolves.toMatchObject({
      manifest: { moduleEntry: "generated/approved-entry.js" },
    });
  });

  it("binds the generated adapter to a genuine Rolldown runtime closure", async () => {
    const times = [0, 250_000, 500_000, 1_000_000];
    const exported = await buildApprovedEsmVirtualMap({
      approval: await approval(),
      assets: assetsByHash([]),
      runtimeGraphProvider: await genuineRuntimeProvider(),
    });
    expect(exported.manifest.moduleEntry).toBe("generated/approved-entry.js");
    expect(
      new TextDecoder().decode(
        exported.files.get("generated/approved-entry.js")!,
      ),
    ).toContain("evaluateScene");
    expect(exported.files.get("generated/approved-document.js")).toBeDefined();
    const executed = await executeEmittedEntry(
      exported.files,
      exported.manifest.moduleEntry,
      times,
    );
    expect(executed.document).toEqual(FIRST_SLICE_DOCUMENT);
    expect(executed.evaluations).toEqual(
      times.map((timeUs) => evaluateScene(FIRST_SLICE_DOCUMENT, timeUs)),
    );
  });

  it("repeats genuine one-image builds and preserves token-resolved runtime parity", async () => {
    const callerBytes = new Uint8Array([21, 22, 23]);
    const asset = createContentAddressedAsset({
      sha256: await hash(callerBytes),
      mimeType: "image/png",
      byteLength: callerBytes.byteLength,
      bytes: callerBytes,
    });
    const document = {
      ...structuredClone(FIRST_SLICE_DOCUMENT),
      rootIds: ["image-1"],
      elements: [
        {
          id: "image-1",
          type: "image",
          asset: {
            sha256: asset.sha256,
            mimeType: asset.mimeType,
            byteLength: asset.byteLength,
            intrinsicWidth: 2,
            intrinsicHeight: 2,
          },
          x: 1,
          y: 2,
          width: 2,
          height: 2,
          opacity: 1,
        },
      ],
      tracks: [],
    } as SceneDocumentV1;
    const [runtimeOne, runtimeTwo] = await Promise.all([
      buildGenuineRuntimeGraph(),
      buildGenuineRuntimeGraph(),
    ]);
    expect(runtimeOne).toEqual(runtimeTwo);
    const approved = await approval(document, [asset]);
    const first = await buildApprovedEsmVirtualMap({
      approval: approved,
      assets: assetsByHash([asset]),
      runtimeGraphProvider: provider(runtimeOne, runtimeOne),
    });
    const second = await buildApprovedEsmVirtualMap({
      approval: approved,
      assets: assetsByHash([asset]),
      runtimeGraphProvider: provider(runtimeTwo, runtimeTwo),
    });
    const savedEntries = first.files.entries();
    const savedManifest = structuredClone(first.manifest);
    callerBytes[0] = 0;
    runtimeOne.files[0]!.bytes[0] = 0;
    runtimeOne.files[0]!.sha256 = `sha256:${"0".repeat(64)}`;
    first.files.get(`assets/${asset.sha256.slice(7)}`)![0] = 0;
    expect(first.files.entries()).toEqual(savedEntries);
    expect(first.manifest).toEqual(savedManifest);
    expect(first.files.entries()).toEqual(second.files.entries());
    const token = {
      sha256: asset.sha256,
      mimeType: asset.mimeType,
      byteLength: asset.byteLength,
    };
    const times = [0, 500_000, 1_000_000];
    const executed = await executeEmittedEntry(
      first.files,
      first.manifest.moduleEntry,
      times,
      { [asset.sha256]: token },
    );
    const hostResolver = {
      resolve: (reference: (typeof document.elements)[0]["asset"]) => ({
        handle: { ...token },
        ...reference,
      }),
    };
    expect(executed.document).toEqual(document);
    expect(executed.evaluations).toEqual(
      times.map((timeUs) =>
        evaluateScene(document, timeUs, { imageResolver: hostResolver }),
      ),
    );
  });
});

describe("approved IIFE virtual export", () => {
  it("builds a deterministic zero-asset classic bundle with the canonical ESM graph retained", async () => {
    const approved = await approval();
    const exported = await buildApprovedIifeVirtualMap({
      approval: approved,
      assets: assetsByHash([]),
      runtimeGraphProvider: await genuineRuntimeProvider(),
      iifeBundleProvider: genuineIifeProvider(),
    });
    expect(exported.files.paths).toContain("particle-studio.iife.js");
    expect(exported.files.paths).toContain("generated/approved-iife-entry.js");
    expect(exported.files.paths).toContain(
      "generated/approved-browser-controller.js",
    );
    expect(exported.manifest).toMatchObject({
      adapterName: "iife",
      packagingPolicy: "adjacent-assets-v1",
      moduleEntry: "particle-studio.iife.js",
      embeddedAssetBytes: 0,
    });
    for (const [path, expectedHash] of Object.entries(
      exported.manifest.fileHashes,
    )) {
      expect(await hash(exported.files.get(path)!)).toBe(expectedHash);
    }
    const bytes = exported.files.get("particle-studio.iife.js")!;
    const context: Record<string, unknown> = {
      TextEncoder,
      TextDecoder,
      crypto,
      URL,
      document: {
        currentScript: { src: "https://example.test/particle-studio.iife.js" },
      },
    };
    context.globalThis = context;
    const globalsBefore = Object.keys(context).sort();
    runInNewContext(new TextDecoder().decode(bytes), context);
    expect(Object.keys(context).sort()).toEqual(
      [...globalsBefore, "ParticleStudio"].sort(),
    );
    expect(Object.keys(context.ParticleStudio as object)).toEqual(["mount"]);
    expect(Object.isFrozen(context.ParticleStudio)).toBe(true);

    const prior = Object.freeze({ prior: true });
    const collision: Record<string, unknown> = {
      TextEncoder,
      TextDecoder,
      crypto,
      URL,
      ParticleStudio: prior,
      document: {
        currentScript: { src: "https://example.test/particle-studio.iife.js" },
      },
    };
    collision.globalThis = collision;
    expect(() =>
      runInNewContext(new TextDecoder().decode(bytes), collision),
    ).toThrow("PARTICLE_STUDIO_GLOBAL_COLLISION");
    expect(collision.ParticleStudio).toBe(prior);
  });

  it("rejects an own undefined ParticleStudio property without replacing it", async () => {
    const exported = await buildApprovedIifeVirtualMap({
      approval: await approval(),
      assets: assetsByHash([]),
      runtimeGraphProvider: await genuineRuntimeProvider(),
      iifeBundleProvider: genuineIifeProvider(),
    });
    const collision: Record<string, unknown> = {
      TextEncoder,
      TextDecoder,
      crypto,
      URL,
      document: {
        currentScript: { src: "https://example.test/particle-studio.iife.js" },
      },
    };
    Object.defineProperty(collision, "ParticleStudio", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    collision.globalThis = collision;
    expect(() =>
      runInNewContext(
        new TextDecoder().decode(
          exported.files.get("particle-studio.iife.js")!,
        ),
        collision,
      ),
    ).toThrow("PARTICLE_STUDIO_GLOBAL_COLLISION");
    expect(Object.hasOwn(collision, "ParticleStudio")).toBe(true);
    expect(collision.ParticleStudio).toBeUndefined();
  });

  it("rejects provider failures, malformed module facades, unstable bytes, and reserved graph collisions atomically", async () => {
    const approved = await approval();
    const runtime = await graph([
      await module(
        "runtime/entry.js",
        "export function evaluateScene() {}\nexport function renderCommands() {}\n",
      ),
    ]);
    const bundle = async (
      source: string,
      changes: Record<string, unknown> = {},
    ) => {
      const bytes = new TextEncoder().encode(source);
      return {
        path: "particle-studio.iife.js",
        bytes,
        sha256: await hash(bytes),
        globalName: "ParticleStudio",
        ...changes,
      };
    };
    const valid = await bundle(
      "globalThis.ParticleStudio = Object.freeze({ mount() {} });\n",
    );
    const malformed: Array<[string, PortableIifeBundleProvider]> = [
      [
        "provider failure",
        { provide: async () => Promise.reject(new Error("unavailable")) },
      ],
      [
        "wrong path",
        {
          provide: async () =>
            ({ ...valid, path: "other.js" }) as PortableIifeBundle,
        },
      ],
      [
        "wrong global",
        {
          provide: async () =>
            ({ ...valid, globalName: "Other" }) as PortableIifeBundle,
        },
      ],
      [
        "bad hash",
        { provide: async () => ({ ...valid, sha256: "sha256:bad" }) },
      ],
      [
        "empty bytes",
        { provide: async () => ({ ...valid, bytes: new Uint8Array() }) },
      ],
      ["static import", { provide: async () => bundle("import 'outside';") }],
      [
        "export facade",
        { provide: async () => bundle("export const mount = () => {};") },
      ],
      [
        "import meta",
        { provide: async () => bundle("console.log(import.meta.url);") },
      ],
    ];
    for (const [name, iifeBundleProvider] of malformed) {
      await expect(
        buildApprovedIifeVirtualMap({
          approval: approved,
          assets: assetsByHash([]),
          runtimeGraphProvider: provider(runtime, runtime),
          iifeBundleProvider,
        }),
        name,
      ).rejects.toThrow(
        name === "provider failure"
          ? "EXPORT_IIFE_PROVIDER_FAILED"
          : "EXPORT_IIFE_INVALID",
      );
    }
    await expect(
      buildApprovedIifeVirtualMap({
        approval: approved,
        assets: assetsByHash([]),
        runtimeGraphProvider: provider(runtime, runtime),
        iifeBundleProvider: {
          provide: (() => {
            let calls = 0;
            return () =>
              calls++ === 0
                ? valid
                : bundle("globalThis.ParticleStudio = {};\n");
          })(),
        },
      }),
    ).rejects.toThrow("EXPORT_IIFE_UNSTABLE");
    const collision = await graph(
      [
        await module(
          "generated/approved-iife-entry.js",
          "export function evaluateScene() {}\nexport function renderCommands() {}\n",
        ),
      ],
      "generated/approved-iife-entry.js",
    );
    let calls = 0;
    await expect(
      buildApprovedIifeVirtualMap({
        approval: approved,
        assets: assetsByHash([]),
        runtimeGraphProvider: provider(collision, collision),
        iifeBundleProvider: {
          provide: async () => {
            calls += 1;
            return valid;
          },
        },
      }),
    ).rejects.toThrow("EXPORT_GRAPH_INVALID");
    expect(calls).toBe(0);
  });

  it("keeps adjacent image bytes and provider inputs isolated across deterministic genuine builds", async () => {
    const bytes = new Uint8Array([21, 22, 23]);
    const asset = createContentAddressedAsset({
      sha256: await hash(bytes),
      mimeType: "image/png",
      byteLength: bytes.byteLength,
      bytes,
    });
    const document = {
      ...structuredClone(FIRST_SLICE_DOCUMENT),
      rootIds: ["image-1"],
      elements: [
        {
          id: "image-1",
          type: "image",
          asset: { ...asset, intrinsicWidth: 1, intrinsicHeight: 1 },
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          opacity: 1,
        },
      ],
      tracks: [],
    } as SceneDocumentV1;
    const observed: PortableIifeBundleInput[] = [];
    const authority = genuineIifeProvider();
    const mutatingProvider: PortableIifeBundleProvider = {
      async provide(input) {
        const output = await authority.provide(input);
        observed.push(input);
        (input.files as PortableVirtualModule[]).reverse();
        input.files[0]!.bytes[0] ^= 0xff;
        return output;
      },
    };
    const [first, second] = await Promise.all([
      buildApprovedIifeVirtualMap({
        approval: await approval(document, [asset]),
        assets: assetsByHash([asset]),
        runtimeGraphProvider: await genuineRuntimeProvider(),
        iifeBundleProvider: mutatingProvider,
      }),
      buildApprovedIifeVirtualMap({
        approval: await approval(document, [asset]),
        assets: assetsByHash([asset]),
        runtimeGraphProvider: await genuineRuntimeProvider(),
        iifeBundleProvider: genuineIifeProvider(),
      }),
    ]);
    expect(observed).toHaveLength(2);
    expect(observed[0]).not.toBe(observed[1]);
    expect(first.files.entries()).toEqual(second.files.entries());
    expect(first.files.get(`assets/${asset.sha256.slice(7)}`)).toEqual(bytes);
    expect(first.manifest.embeddedAssetBytes).toBe(0);
    const returned = first.files.get("particle-studio.iife.js")!;
    returned[0] ^= 0xff;
    expect(first.files.get("particle-studio.iife.js")).not.toEqual(returned);
  }, 20_000);
});

describe("approved Web Component virtual export", () => {
  it("requires the genuine evaluator and Canvas renderer before atomically emitting an adjacent-asset component", async () => {
    const bytes = new Uint8Array([21, 22, 23]);
    const asset = createContentAddressedAsset({
      sha256: await hash(bytes),
      mimeType: "image/png",
      byteLength: bytes.byteLength,
      bytes,
    });
    const document = {
      ...structuredClone(FIRST_SLICE_DOCUMENT),
      rootIds: ["image-1"],
      elements: [
        {
          id: "image-1",
          type: "image",
          asset: {
            sha256: asset.sha256,
            mimeType: asset.mimeType,
            byteLength: asset.byteLength,
            intrinsicWidth: 1,
            intrinsicHeight: 1,
          },
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          opacity: 1,
        },
      ],
      tracks: [],
    } as SceneDocumentV1;
    const runtime = await graph([
      await module(
        "runtime/entry.js",
        "export function evaluateScene() {}\nexport function renderCommands() {}\n",
      ),
    ]);
    const first = await buildApprovedWebComponentVirtualMap({
      approval: await approval(document, [asset]),
      assets: assetsByHash([asset]),
      runtimeGraphProvider: provider(runtime, runtime),
    });
    const second = await buildApprovedWebComponentVirtualMap({
      approval: await approval(document, [asset]),
      assets: assetsByHash([asset]),
      runtimeGraphProvider: provider(runtime, runtime),
    });

    expect(first.files.entries()).toEqual(second.files.entries());
    expect(Object.isFrozen(first.manifest)).toBe(true);
    expect(
      () =>
        ((first.manifest as { embeddedAssetBytes: number }).embeddedAssetBytes =
          1),
    ).toThrow(TypeError);
    expect(first.manifest).toMatchObject({
      adapterName: "web-component",
      embeddedAssetBytes: 0,
      packagingPolicy: "adjacent-assets-v1",
      moduleEntry: "web-component.js",
    });
    expect(first.files.get(`assets/${asset.sha256.slice(7)}`)).toEqual(bytes);
    const wrapper = new TextDecoder().decode(
      first.files.get("web-component.js")!,
    );
    expect(wrapper).not.toContain("data:");
    expect(wrapper).not.toContain(Buffer.from(bytes).toString("base64"));
    for (const [path, expectedHash] of Object.entries(
      first.manifest.fileHashes,
    )) {
      expect(await hash(first.files.get(path)!)).toBe(expectedHash);
    }

    const callerCopy = first.files.get(`assets/${asset.sha256.slice(7)}`)!;
    callerCopy[0] = 0;
    expect(first.files.get(`assets/${asset.sha256.slice(7)}`)).toEqual(bytes);

    const evaluatorOnly = await graph();
    const collision = await graph(
      [
        await module(
          "web-component.js",
          "export function evaluateScene() {}\nexport function renderCommands() {}\n",
        ),
      ],
      "web-component.js",
    );
    for (const rejected of [evaluatorOnly, collision]) {
      await expect(
        buildApprovedWebComponentVirtualMap({
          approval: await approval(),
          assets: assetsByHash([]),
          runtimeGraphProvider: provider(rejected, rejected),
        }),
      ).rejects.toThrow("EXPORT_GRAPH_INVALID");
    }

    const genuine = await buildApprovedWebComponentVirtualMap({
      approval: await approval(),
      assets: assetsByHash([]),
      runtimeGraphProvider: await genuineRuntimeProvider(),
    });
    expect(genuine.files.get("web-component.js")).toBeDefined();
    expect(genuine.files.get("generated/approved-assets.js")).toBeDefined();
  });
});

describe("approved self-contained HTML virtual export", () => {
  const fakeIifeProvider = (
    source = "globalThis.ParticleStudio = Object.freeze({ mount() { return Object.freeze({ ready: Promise.resolve(), renderAt() {} }); } });\n",
  ): PortableIifeBundleProvider => ({
    async provide() {
      const bytes = new TextEncoder().encode(source);
      return {
        path: "particle-studio.iife.js",
        bytes,
        sha256: await hash(bytes),
        globalName: "ParticleStudio",
      };
    },
  });
  const minimalRuntime = async () =>
    graph([
      await module(
        "runtime/entry.js",
        "export function evaluateScene() {}\nexport function renderCommands() {}\n",
      ),
    ]);
  const oneImage = async (bytes: Uint8Array) => {
    const asset = createContentAddressedAsset({
      sha256: await hash(bytes),
      mimeType: "image/png",
      byteLength: bytes.byteLength,
      bytes,
    });
    const document = {
      ...structuredClone(FIRST_SLICE_DOCUMENT),
      rootIds: ["image-1"],
      elements: [
        {
          id: "image-1",
          type: "image",
          asset: { ...asset, intrinsicWidth: 1, intrinsicHeight: 1 },
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          opacity: 1,
        },
      ],
      tracks: [],
    } as SceneDocumentV1;
    return { asset, document, approval: await approval(document, [asset]) };
  };
  const decodedDataUrl = (url: string) => {
    const encoded = url.slice(url.indexOf(",") + 1);
    return new Uint8Array(
      [...atob(encoded)].map((character) => character.charCodeAt(0)),
    );
  };

  it("builds a one-file immutable zero-asset HTML export", async () => {
    const approved = await approval();
    const exported = await buildApprovedSelfContainedHtmlVirtualMap({
      approval: approved,
      assets: assetsByHash([]),
      runtimeGraphProvider: await genuineRuntimeProvider(),
      iifeBundleProvider: genuineIifeProvider(),
    });
    expect(exported.files.paths).toEqual(["particle-studio.html"]);
    expect(exported.manifest).toMatchObject({
      adapterName: "html",
      packagingPolicy: "self-contained-data-urls-v1",
      moduleEntry: "particle-studio.html",
      embeddedAssetBytes: 0,
      maxEmbeddedAssetBytes: 10_485_760,
    });
    expect(exported.manifest.fileHashes).toEqual({
      "particle-studio.html": await hash(
        exported.files.get("particle-studio.html")!,
      ),
    });
    const html = new TextDecoder().decode(
      exported.files.get("particle-studio.html")!,
    );
    const bundleUrl = html.match(/<script src="([^"]+)"><\/script>/)![1]!;
    const context: Record<string, unknown> = {
      TextEncoder,
      TextDecoder,
      crypto,
      URL,
      document: { currentScript: { src: bundleUrl } },
    };
    context.globalThis = context;
    expect(() =>
      runInNewContext(
        new TextDecoder().decode(decodedDataUrl(bundleUrl)),
        context,
      ),
    ).not.toThrow();
    expect(context.ParticleStudio).toBeDefined();
    expect(Object.isFrozen(exported.manifest)).toBe(true);
    expect(Object.isFrozen(exported.manifest.fileHashes)).toBe(true);
    expect(exported.files.get("manifest.json")).toBeUndefined();
    const returned = exported.files.get("particle-studio.html")!;
    returned[0] ^= 0xff;
    expect(exported.files.get("particle-studio.html")).not.toEqual(returned);
  });

  it("embeds verified image bytes as deterministic MIME data URLs and isolates repeated builds", async () => {
    const fixture = await oneImage(new Uint8Array([1, 2, 3]));
    const runtime = await genuineRuntimeProvider();
    const first = await buildApprovedSelfContainedHtmlVirtualMap({
      approval: fixture.approval,
      assets: assetsByHash([fixture.asset]),
      runtimeGraphProvider: runtime,
      iifeBundleProvider: genuineIifeProvider(),
    });
    const second = await buildApprovedSelfContainedHtmlVirtualMap({
      approval: fixture.approval,
      assets: assetsByHash([fixture.asset]),
      runtimeGraphProvider: await genuineRuntimeProvider(),
      iifeBundleProvider: genuineIifeProvider(),
    });
    const html = new TextDecoder().decode(
      first.files.get("particle-studio.html")!,
    );
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)];
    expect(scripts).toHaveLength(2);
    const bundle = new TextDecoder().decode(decodedDataUrl(scripts[0]![1]!));
    expect(bundle).toContain("data:image/png;base64,AQID");
    expect(first.manifest.embeddedAssetBytes).toBe(3);
    expect(first.files.entries()).toEqual(second.files.entries());
    const copy = first.files.get("particle-studio.html")!;
    copy[0] ^= 0xff;
    expect(first.files.entries()).toEqual(second.files.entries());
  }, 20_000);

  it("accepts exactly 10 MiB and rejects 10 MiB plus one before either provider", async () => {
    const limit = 10_485_760;
    const accepted = await oneImage(new Uint8Array(limit));
    const runtime = await minimalRuntime();
    const embeddedProvider: PortableIifeBundleProvider = {
      async provide(input) {
        const source = new TextDecoder().decode(
          input.files.find(
            (file) => file.path === "generated/approved-assets.js",
          )!.bytes,
        );
        const assets = source.slice(
          source.indexOf("["),
          source.indexOf(";\nexport const approvedCanvas"),
        );
        const bytes = new TextEncoder().encode(
          `const approvedAssets = ${assets};\nglobalThis.ParticleStudio = Object.freeze({ mount() { return Object.freeze({ ready: Promise.resolve(), renderAt() {} }); } });\n`,
        );
        return {
          path: "particle-studio.iife.js",
          bytes,
          sha256: await hash(bytes),
          globalName: "ParticleStudio",
        };
      },
    };
    const exportAtLimit = await buildApprovedSelfContainedHtmlVirtualMap({
      approval: accepted.approval,
      assets: assetsByHash([accepted.asset]),
      runtimeGraphProvider: provider(runtime, runtime),
      iifeBundleProvider: embeddedProvider,
    });
    expect(exportAtLimit.manifest.embeddedAssetBytes).toBe(limit);
    let runtimeCalls = 0;
    let iifeCalls = 0;
    const rejected = await oneImage(new Uint8Array(limit + 1));
    await expect(
      buildApprovedSelfContainedHtmlVirtualMap({
        approval: rejected.approval,
        assets: assetsByHash([rejected.asset]),
        runtimeGraphProvider: {
          async provide() {
            runtimeCalls += 1;
            return runtime;
          },
        },
        iifeBundleProvider: {
          async provide() {
            iifeCalls += 1;
            return await fakeIifeProvider().provide(
              {} as PortableIifeBundleInput,
            );
          },
        },
      }),
    ).rejects.toThrow("EXPORT_EMBEDDED_ASSET_LIMIT_EXCEEDED");
    expect(runtimeCalls).toBe(0);
    expect(iifeCalls).toBe(0);
  }, 30_000);

  it("fails closed for unavailable or tampered assets and existing provider failures", async () => {
    const fixture = await oneImage(new Uint8Array([1, 2, 3]));
    const runtime = await minimalRuntime();
    await expect(
      buildApprovedSelfContainedHtmlVirtualMap({
        approval: fixture.approval,
        assets: assetsByHash([]),
        runtimeGraphProvider: provider(runtime, runtime),
        iifeBundleProvider: fakeIifeProvider(),
      }),
    ).rejects.toThrow("EXPORT_ASSET_UNAVAILABLE");
    const tampered = createContentAddressedAsset({
      ...fixture.asset,
      bytes: new Uint8Array([3, 2, 1]),
    });
    await expect(
      buildApprovedSelfContainedHtmlVirtualMap({
        approval: fixture.approval,
        assets: assetsByHash([tampered]),
        runtimeGraphProvider: provider(runtime, runtime),
        iifeBundleProvider: fakeIifeProvider(),
      }),
    ).rejects.toThrow("EXPORT_ASSET_MISMATCH");
    await expect(
      buildApprovedSelfContainedHtmlVirtualMap({
        approval: await approval(),
        assets: assetsByHash([]),
        runtimeGraphProvider: {
          provide: async () => Promise.reject(new Error("no graph")),
        },
        iifeBundleProvider: fakeIifeProvider(),
      }),
    ).rejects.toThrow("EXPORT_GRAPH_PROVIDER_FAILED");
    await expect(
      buildApprovedSelfContainedHtmlVirtualMap({
        approval: await approval(),
        assets: assetsByHash([]),
        runtimeGraphProvider: provider(runtime, runtime),
        iifeBundleProvider: {
          provide: async () => Promise.reject(new Error("no bundle")),
        },
      }),
    ).rejects.toThrow("EXPORT_IIFE_PROVIDER_FAILED");
  });

  it("encodes raw script-like provider bytes exactly without exposing them in HTML", async () => {
    const source =
      "/* </script><p>not markup</p> */ globalThis.ParticleStudio = Object.freeze({ mount() { return Object.freeze({ ready: Promise.resolve(), renderAt() {} }); } });\n";
    const exported = await buildApprovedSelfContainedHtmlVirtualMap({
      approval: await approval(),
      assets: assetsByHash([]),
      runtimeGraphProvider: provider(
        await minimalRuntime(),
        await minimalRuntime(),
      ),
      iifeBundleProvider: fakeIifeProvider(source),
    });
    const html = new TextDecoder().decode(
      exported.files.get("particle-studio.html")!,
    );
    const bundleUrl = html.match(/<script src="([^"]+)"><\/script>/)![1]!;
    expect(new TextDecoder().decode(decodedDataUrl(bundleUrl))).toBe(source);
    expect(html).not.toContain("/* </script><p>not markup</p> */");
    expect(html).not.toContain("manifest.json");
    expect(html).not.toContain("particle-studio.iife.js");
  });

  it("binds approved snapshots into HTML while the generic runtime provider receives no snapshot graph", async () => {
    const firstFixture = await oneImage(new Uint8Array([1, 2, 3]));
    const firstApproval = firstFixture.approval;
    const secondDocument = {
      ...structuredClone(FIRST_SLICE_DOCUMENT),
      durationUs: FIRST_SLICE_DOCUMENT.durationUs + 1,
    } as SceneDocumentV1;
    const secondApproval = await approval(secondDocument);
    const source =
      "globalThis.ParticleStudio = Object.freeze({ mount() { return Object.freeze({ ready: Promise.resolve(), renderAt() {} }); } });\n";
    const bytes = new TextEncoder().encode(source);
    const calls: unknown[] = [];
    const selfContainedRuntimeProvider = {
      async provide(input?: unknown) {
        calls.push(input);
        return {
          path: "particle-studio.iife.js" as const,
          bytes,
          sha256: await hash(bytes),
          globalName: "ParticleStudio" as const,
        };
      },
    };

    const first = await buildApprovedSelfContainedHtmlVirtualMap({
      approval: firstApproval,
      assets: assetsByHash([firstFixture.asset]),
      selfContainedRuntimeProvider,
    });
    const second = await buildApprovedSelfContainedHtmlVirtualMap({
      approval: secondApproval,
      assets: assetsByHash([]),
      selfContainedRuntimeProvider,
    });

    expect(calls).toEqual([undefined, undefined, undefined, undefined]);
    const firstHtml = new TextDecoder().decode(
      first.files.get("particle-studio.html")!,
    );
    const secondHtml = new TextDecoder().decode(
      second.files.get("particle-studio.html")!,
    );
    const boundJson = (html: string, id: string) => {
      const opening = `<script id="${id}" type="application/json">`;
      const start = html.indexOf(opening);
      const end = html.indexOf("</script>", start + opening.length);
      if (start === -1 || end === -1)
        throw new Error("approved binding missing");
      return JSON.parse(html.slice(start + opening.length, end));
    };
    expect(boundJson(firstHtml, "particle-studio-approved-envelope")).toEqual({
      snapshotHash: firstApproval.snapshotHash,
      envelope: JSON.parse(
        new TextDecoder().decode(firstApproval.approvalEnvelopeBytes),
      ),
    });
    expect(boundJson(secondHtml, "particle-studio-approved-envelope")).toEqual({
      snapshotHash: secondApproval.snapshotHash,
      envelope: JSON.parse(
        new TextDecoder().decode(secondApproval.approvalEnvelopeBytes),
      ),
    });
    expect(firstHtml).not.toContain("particle-studio-approved-document");
    expect(boundJson(firstHtml, "particle-studio-approved-assets")).toEqual([
      expect.objectContaining({
        sha256: firstFixture.asset.sha256,
        mimeType: firstFixture.asset.mimeType,
        byteLength: firstFixture.asset.byteLength,
        path: "data:image/png;base64,AQID",
      }),
    ]);
    expect(firstHtml).not.toEqual(secondHtml);
    expect(first.manifest.snapshotHash).toBe(firstApproval.snapshotHash);
    expect(second.manifest.snapshotHash).toBe(secondApproval.snapshotHash);
    await expect(
      buildApprovedSelfContainedHtmlVirtualMap({
        approval: firstApproval,
        assets: assetsByHash([firstFixture.asset]),
        selfContainedRuntimeProvider: {
          async provide() {
            return {
              ...(await selfContainedRuntimeProvider.provide()),
              sha256: "sha256:bad",
            };
          },
        },
      }),
    ).rejects.toThrow("EXPORT_IIFE_INVALID");
  });

  it("provides a generic browser runtime with no direct build, network, or filesystem authority", () => {
    const source = selfContainedRuntimeEntrySource();
    expect(source).not.toMatch(
      /\b(fetch|XMLHttpRequest|WebAssembly|importScripts)\b/,
    );
    expect(source).not.toMatch(/\b(readFile|writeFile|process|require)\b/);
    expect(source).not.toContain("particle-studio-approved-document");
    expect(source).toContain("particle-studio-approved-envelope");
    expect(source).toContain("createApprovalEnvelope");
    expect(source).toContain("readCanonicalApprovalEvidence");
    expect(source).toContain("particle-studio-approved-assets");
  });
});
