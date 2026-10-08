import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import { expect, test, type Page } from "@playwright/test";

import {
  genuineIifeProvider,
  genuineSelfContainedRuntimeProvider,
} from "../../../packages/export/tests/iife-test-support.js";
import { selfContainedRuntimeEntrySource } from "../../../packages/export/src/self-contained-runtime-entry.js";
import { buildGenuineCanvasRuntimeProvider } from "../../../packages/export/tests/web-component-test-support.js";

import type { SceneDocumentV1 } from "@particle-studio/scene-document";
import type {
  ApprovalRecord,
  ContentAddressedAsset,
} from "@particle-studio/persistence";

const workspaceRoot = new URL("../../../", import.meta.url);
(globalThis as typeof globalThis & { require?: NodeRequire }).require =
  createRequire(import.meta.url);
execFileSync("npm", ["run", "validator:prepare"], {
  cwd: workspaceRoot,
  stdio: "pipe",
});

const {
  FIRST_SLICE_DOCUMENT,
  createApprovalEnvelope,
  readCanonicalApprovalEvidence,
} = await import("@particle-studio/scene-document");
const { createApprovalRecord, createContentAddressedAsset } = await import(
  "@particle-studio/persistence"
);
const { RUNTIME_VERSION } = await import("@particle-studio/runtime");
const { buildApprovedSelfContainedHtmlVirtualMap } = await import(
  "../../../packages/export/src/index.js"
);

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/VscvDQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_SHA256 =
  "sha256:49e1dad481e94dfab7c9573a9a81d56aa2ca629fe15a3f7a910aa4f47601c00d";

async function approval(
  document: SceneDocumentV1,
  assets: readonly ContentAddressedAsset[],
): Promise<ApprovalRecord> {
  const envelope = await createApprovalEnvelope({
    document,
    runtimeVersion: RUNTIME_VERSION,
    verifiedAssetManifest: assets.map(({ sha256, mimeType, byteLength }) => ({
      sha256,
      mimeType,
      byteLength,
    })),
  });
  const evidence = readCanonicalApprovalEvidence(envelope);
  return createApprovalRecord({
    documentId: "self-contained-html-browser-document",
    revisionId: "self-contained-html-browser-revision",
    approvalEnvelope: envelope,
    snapshotHash: evidence.snapshotHash,
    approvalEnvelopeBytes: evidence.approvalEnvelopeBytes,
    canonicalDocumentBytes: evidence.canonicalDocumentBytes,
    verifiedAssetManifest: evidence.verifiedAssetManifest,
    audit: { approvedAt: 1, actorLabel: "local-human" },
  });
}

function assetPort(assets: readonly ContentAddressedAsset[]) {
  return {
    async readAsset(sha256: string) {
      const asset = assets.find((candidate) => candidate.sha256 === sha256);
      if (!asset) throw new Error("missing asset");
      return asset;
    },
  };
}

async function htmlExport(
  document: SceneDocumentV1,
  assets: readonly ContentAddressedAsset[] = [],
) {
  return buildApprovedSelfContainedHtmlVirtualMap({
    approval: await approval(document, assets),
    assets: assetPort(assets),
    runtimeGraphProvider: await buildGenuineCanvasRuntimeProvider(),
    iifeBundleProvider: genuineIifeProvider(),
  });
}

async function genericHtmlExport(
  document: SceneDocumentV1,
  assets: readonly ContentAddressedAsset[] = [],
) {
  return buildApprovedSelfContainedHtmlVirtualMap({
    approval: await approval(document, assets),
    assets: assetPort(assets),
    selfContainedRuntimeProvider: genuineSelfContainedRuntimeProvider(
      selfContainedRuntimeEntrySource(),
    ),
  });
}

function tamperJsonBinding(
  bytes: Uint8Array,
  id: string,
  change: (value: Record<string, unknown>) => void,
): Uint8Array {
  const html = new TextDecoder().decode(bytes);
  const opening = `<script id="${id}" type="application/json">`;
  const start = html.indexOf(opening);
  const contentStart = start + opening.length;
  const end = html.indexOf("</script>", contentStart);
  if (start === -1 || end === -1) throw new Error("approved binding missing");
  const binding = JSON.parse(html.slice(contentStart, end)) as Record<
    string,
    unknown
  >;
  change(binding);
  return new TextEncoder().encode(
    `${html.slice(0, contentStart)}${JSON.stringify(binding)}${html.slice(end)}`,
  );
}

async function routeHtml(
  page: Page,
  prefix: string,
  bytes: Uint8Array,
): Promise<string[]> {
  const httpRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "http:" || url.protocol === "https:") {
      httpRequests.push(url.href);
    }
  });
  await page.route(`**${prefix}/particle-studio.html`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: Buffer.from(bytes.slice()),
    }),
  );
  return httpRequests;
}

function oneImageDocument(asset: ContentAddressedAsset): SceneDocumentV1 {
  return {
    ...structuredClone(FIRST_SLICE_DOCUMENT),
    rootIds: ["image-1"],
    elements: [
      {
        id: "image-1",
        type: "image",
        asset: { ...asset, intrinsicWidth: 1, intrinsicHeight: 1 },
        x: 2,
        y: 3,
        width: 4,
        height: 5,
        opacity: 1,
      },
    ],
    tracks: [],
  } as SceneDocumentV1;
}

function tamperFirstEmbeddedPng(bytes: Uint8Array): Uint8Array {
  const html = new TextDecoder().decode(bytes);
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)];
  const bundleUrl = scripts[0]?.[1];
  if (!bundleUrl?.startsWith("data:text/javascript;charset=utf-8;base64,")) {
    throw new Error("self-contained bundle script missing");
  }
  const bundleSource = Buffer.from(
    bundleUrl.slice("data:text/javascript;charset=utf-8;base64,".length),
    "base64",
  ).toString("utf-8");
  const png = bundleSource.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
  if (!png?.[1]) throw new Error("embedded PNG URL missing");
  const mutatedPng = Buffer.from(png[1], "base64");
  mutatedPng[0] = mutatedPng[0]! ^ 1;
  const tamperedBundle = bundleSource.replace(
    png[0],
    `data:image/png;base64,${mutatedPng.toString("base64")}`,
  );
  const replacement = `data:text/javascript;charset=utf-8;base64,${Buffer.from(tamperedBundle, "utf-8").toString("base64")}`;
  return new TextEncoder().encode(html.replace(bundleUrl, replacement));
}

test("auto-mounts one zero-image frame without autonomous draws and retains an independent frozen API", async ({
  page,
}) => {
  const exported = await htmlExport(structuredClone(FIRST_SLICE_DOCUMENT));
  expect(exported.files.paths).toEqual(["particle-studio.html"]);
  expect(exported.manifest).toMatchObject({
    adapterName: "html",
    packagingPolicy: "self-contained-data-urls-v1",
    moduleEntry: "particle-studio.html",
    embeddedAssetBytes: 0,
    maxEmbeddedAssetBytes: 10_485_760,
  });
  expect(exported.manifest.fileHashes["particle-studio.html"]).toBeDefined();

  await page.addInitScript(() => {
    const fills: string[] = [];
    let resolveFirstFill!: () => void;
    const firstFill = new Promise<void>((resolve) => {
      resolveFirstFill = resolve;
    });
    const original = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (...args) {
      fills.push(args.join(","));
      resolveFirstFill();
      return original.apply(this, args);
    };
    (
      window as unknown as Window & {
        particleStudioCanvasObservation: {
          readonly fills: string[];
          firstFill: Promise<void>;
        };
      }
    ).particleStudioCanvasObservation = { fills, firstFill };
  });
  const requests = await routeHtml(
    page,
    "/portable-self-contained-zero",
    exported.files.get("particle-studio.html")!,
  );
  await page.goto("/portable-self-contained-zero/particle-studio.html");
  await expect(
    page.locator('[data-particle-studio-export-host="true"] canvas'),
  ).toHaveCount(1);

  const observed = await page.evaluate(async () => {
    const state = (
      window as unknown as Window & {
        particleStudioCanvasObservation: {
          readonly fills: string[];
          firstFill: Promise<void>;
        };
        ParticleStudio: {
          mount(target: HTMLElement): {
            ready: Promise<void>;
            renderAt(timeUs: number): { state: { timeUs: number } };
            destroy(): void;
          };
        };
      }
    ).particleStudioCanvasObservation;
    await state.firstFill;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const host = document.querySelector(
      '[data-particle-studio-export-host="true"]',
    ) as HTMLElement;
    const autoCanvas = host.querySelector("canvas");
    const drawsAfterFrames = state.fills.length;
    const callerHost = document.createElement("div");
    document.body.append(callerHost);
    const controller = globalThis.ParticleStudio.mount(callerHost);
    await controller.ready;
    const explicit = controller.renderAt(500_000);
    controller.destroy();
    return {
      hostId: host.id,
      hostError: host.getAttribute("data-particle-studio-export-error"),
      apiFrozen: Object.isFrozen(globalThis.ParticleStudio),
      apiKeys: Object.keys(globalThis.ParticleStudio),
      initialDraws: drawsAfterFrames,
      fills: state.fills,
      explicitTimeUs: explicit.state.timeUs,
      callerCanvasesAfterDestroy: callerHost.querySelectorAll("canvas").length,
      autoCanvasRetained: host.querySelector("canvas") === autoCanvas,
      autoCanvasCount: host.querySelectorAll("canvas").length,
    };
  });

  expect(requests).toEqual([page.url()]);
  expect(observed).toEqual({
    hostId: "particle-studio-export-host",
    hostError: null,
    apiFrozen: true,
    apiKeys: ["mount"],
    initialDraws: 1,
    fills: ["16,24,120,80", "16,24,120,80"],
    explicitTimeUs: 500_000,
    callerCanvasesAfterDestroy: 0,
    autoCanvasRetained: true,
    autoCanvasCount: 1,
  });
});

test("renders a verified one-image data URL at time zero with no adjacent HTTP(S) requests", async ({
  page,
}) => {
  const asset = createContentAddressedAsset({
    sha256: PNG_SHA256,
    mimeType: "image/png",
    byteLength: PNG.byteLength,
    bytes: new Uint8Array(PNG),
  });
  const exported = await htmlExport(oneImageDocument(asset), [asset]);
  expect(exported.files.paths).toEqual(["particle-studio.html"]);
  expect(exported.manifest.embeddedAssetBytes).toBe(70);

  await page.addInitScript(() => {
    const draws: unknown[] = [];
    let resolveFirstDraw!: () => void;
    const firstDraw = new Promise<void>((resolve) => {
      resolveFirstDraw = resolve;
    });
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (
      source,
      x,
      y,
      width,
      height,
    ) {
      draws.push({
        source: source.constructor.name,
        width: (source as ImageBitmap).width,
        height: (source as ImageBitmap).height,
        x,
        y,
        drawWidth: width,
        drawHeight: height,
      });
      resolveFirstDraw();
      return original.call(this, source, x, y, width, height);
    };
    (
      window as unknown as Window & {
        particleStudioImageObservation: {
          readonly draws: unknown[];
          firstDraw: Promise<void>;
        };
      }
    ).particleStudioImageObservation = { draws, firstDraw };
  });
  const requests = await routeHtml(
    page,
    "/portable-self-contained-image",
    exported.files.get("particle-studio.html")!,
  );
  await page.goto("/portable-self-contained-image/particle-studio.html");
  const observed = await page.evaluate(async () => {
    const state = (
      window as unknown as Window & {
        particleStudioImageObservation: {
          readonly draws: unknown[];
          firstDraw: Promise<void>;
        };
      }
    ).particleStudioImageObservation;
    await state.firstDraw;
    const host = document.querySelector(
      '[data-particle-studio-export-host="true"]',
    ) as HTMLElement;
    return {
      hostError: host.getAttribute("data-particle-studio-export-error"),
      draws: state.draws,
    };
  });

  expect(requests).toEqual([page.url()]);
  expect(observed).toEqual({
    hostError: null,
    draws: [
      {
        source: "ImageBitmap",
        width: 1,
        height: 1,
        x: 2,
        y: 3,
        drawWidth: 4,
        drawHeight: 5,
      },
    ],
  });
});

test("fails closed when generic approval evidence or asset metadata is tampered before drawing", async ({
  page,
}) => {
  const asset = createContentAddressedAsset({
    sha256: PNG_SHA256,
    mimeType: "image/png",
    byteLength: PNG.byteLength,
    bytes: new Uint8Array(PNG),
  });
  const exported = await genericHtmlExport(oneImageDocument(asset), [asset]);
  const original = exported.files.get("particle-studio.html")!;
  const evidenceTampered = tamperJsonBinding(
    original,
    "particle-studio-approved-envelope",
    (binding) => {
      (
        (binding.envelope as Record<string, unknown>).document as Record<
          string,
          unknown
        >
      ).durationUs = 999;
    },
  );
  const metadataTampered = tamperJsonBinding(
    original,
    "particle-studio-approved-assets",
    (binding) => {
      (binding[0] as Record<string, unknown>).intrinsicWidth = 2;
    },
  );

  await page.addInitScript(() => {
    const draws: unknown[] = [];
    const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      draws.push(args.length);
      return originalDrawImage.apply(this, args);
    };
    (
      window as unknown as Window & { particleStudioGenericDraws: unknown[] }
    ).particleStudioGenericDraws = draws;
  });
  for (const [prefix, bytes] of [
    ["/portable-generic-evidence-tampered", evidenceTampered],
    ["/portable-generic-metadata-tampered", metadataTampered],
  ] as const) {
    const requests = await routeHtml(page, prefix, bytes);
    await page.goto(`${prefix}/particle-studio.html`);
    await expect(
      page.locator('[data-particle-studio-export-host="true"]'),
    ).toHaveAttribute(
      "data-particle-studio-export-error",
      "PARTICLE_STUDIO_APPROVED_BINDING_INVALID",
    );
    expect(requests).toEqual([page.url()]);
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as Window & {
              particleStudioGenericDraws: unknown[];
            }
          ).particleStudioGenericDraws.length,
      ),
    ).toBe(0);
  }
});

test("fails closed when nested embedded image bytes are tampered without changing metadata", async ({
  page,
}) => {
  const asset = createContentAddressedAsset({
    sha256: PNG_SHA256,
    mimeType: "image/png",
    byteLength: PNG.byteLength,
    bytes: new Uint8Array(PNG),
  });
  const exported = await htmlExport(oneImageDocument(asset), [asset]);
  const tampered = tamperFirstEmbeddedPng(
    exported.files.get("particle-studio.html")!,
  );

  await page.addInitScript(() => {
    const draws: unknown[] = [];
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      draws.push(args.length);
      return original.apply(this, args);
    };
    (
      window as unknown as Window & { particleStudioImageDraws: unknown[] }
    ).particleStudioImageDraws = draws;
  });
  const requests = await routeHtml(
    page,
    "/portable-self-contained-tampered",
    tampered,
  );
  await page.goto("/portable-self-contained-tampered/particle-studio.html");
  const host = page.locator('[data-particle-studio-export-host="true"]');
  await expect(host).toHaveAttribute(
    "data-particle-studio-export-error",
    "PARTICLE_STUDIO_ASSET_HASH_MISMATCH",
  );

  expect(requests).toEqual([page.url()]);
  await expect(
    page.locator('[data-particle-studio-export-host="true"] canvas'),
  ).toHaveCount(1);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as Window & { particleStudioImageDraws: unknown[] })
          .particleStudioImageDraws.length,
    ),
  ).toBe(0);
});
