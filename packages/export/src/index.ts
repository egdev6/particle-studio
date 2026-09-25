import {
  canonicalizeSceneDocument,
  createApprovalEnvelope,
  readCanonicalApprovalEvidence,
  validateSceneDocument,
  type CanonicalSceneDocument,
  type SceneDocumentV1,
  type VerifiedAssetManifestEntry,
} from "@particle-studio/scene-document";
import {
  readApprovalRecordRuntimeVersion,
  validateApprovalRecord,
  type ApprovalRecord,
  type AssetPersistencePort,
  type ContentAddressedAsset,
} from "@particle-studio/persistence";
import {
  ImportType,
  init as initializeModuleLexer,
  parse as parseModule,
} from "es-module-lexer";
import {
  evaluateScene,
  RUNTIME_VERSION,
  type EvaluationOptions,
  type EvaluationResult,
} from "@particle-studio/runtime";

export { selfContainedRuntimeEntrySource } from "./self-contained-runtime-entry.js";

// SAFETY: Node 24 and supported browsers provide these standard Web Platform APIs.
const webPlatform = globalThis as unknown as {
  readonly TextEncoder: new () => { encode(value: string): Uint8Array };
  readonly TextDecoder: new (
    label?: string,
    options?: { readonly fatal?: boolean },
  ) => { decode(input: Uint8Array): string };
  readonly crypto: {
    readonly subtle: {
      digest(name: string, data: Uint8Array): Promise<ArrayBuffer>;
    };
  };
};
const textEncoder = new webPlatform.TextEncoder();
const textDecoder = new webPlatform.TextDecoder("utf-8", { fatal: true });
const SHA256_HEX = "0123456789abcdef";
const MANIFEST_PATH = "manifest.json";
const DOCUMENT_PATH = "scene-document.json";
const GENERATED_DOCUMENT_PATH = "generated/approved-document.js";
const GENERATED_ADAPTER_PATH = "generated/approved-entry.js";
const GENERATED_ASSETS_PATH = "generated/approved-assets.js";
const WEB_COMPONENT_PATH = "web-component.js";
const BROWSER_CONTROLLER_PATH = "generated/approved-browser-controller.js";
const IIFE_ENTRY_PATH = "generated/approved-iife-entry.js";
const IIFE_BUNDLE_PATH = "particle-studio.iife.js";
const IIFE_GLOBAL_NAME = "ParticleStudio" as const;
const HTML_PATH = "particle-studio.html";
const EMBEDDED_ASSET_LIMIT = 10_485_760;
const PACKAGING_POLICY = "adjacent-assets-v1" as const;
const HTML_PACKAGING_POLICY = "self-contained-data-urls-v1" as const;
const ESM_ADAPTER_NAME = "esm" as const;
const WEB_COMPONENT_ADAPTER_NAME = "web-component" as const;
const IIFE_ADAPTER_NAME = "iife" as const;
const HTML_ADAPTER_NAME = "html" as const;
type AdapterName =
  | typeof ESM_ADAPTER_NAME
  | typeof WEB_COMPONENT_ADAPTER_NAME
  | typeof IIFE_ADAPTER_NAME
  | typeof HTML_ADAPTER_NAME;
type PackagingPolicy = typeof PACKAGING_POLICY | typeof HTML_PACKAGING_POLICY;

export type ExportErrorCode =
  | "EXPORT_APPROVAL_INVALID"
  | "EXPORT_APPROVAL_RUNTIME_VERSION_MISMATCH"
  | "EXPORT_APPROVAL_EVIDENCE_MISMATCH"
  | "EXPORT_ASSET_UNAVAILABLE"
  | "EXPORT_ASSET_MISMATCH"
  | "EXPORT_GRAPH_PROVIDER_FAILED"
  | "EXPORT_GRAPH_INVALID"
  | "EXPORT_GRAPH_UNSTABLE"
  | "EXPORT_IIFE_PROVIDER_FAILED"
  | "EXPORT_IIFE_INVALID"
  | "EXPORT_IIFE_UNSTABLE"
  | "EXPORT_EMBEDDED_ASSET_LIMIT_EXCEEDED";

export class ExportError extends Error {
  readonly name = "ExportError";

  constructor(readonly code: ExportErrorCode) {
    super(code);
  }
}

export interface PortableVirtualModule {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface PortableRuntimeGraph {
  readonly entryPath: string;
  readonly files: readonly PortableVirtualModule[];
}

export interface PortableIifeBundleInput {
  readonly files: readonly PortableVirtualModule[];
  readonly entryPath: typeof IIFE_ENTRY_PATH;
  readonly globalName: typeof IIFE_GLOBAL_NAME;
}

export interface PortableIifeBundle {
  readonly path: typeof IIFE_BUNDLE_PATH;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly globalName: typeof IIFE_GLOBAL_NAME;
}

/**
 * Trusted semantic build authority for the single classic-script bundle.
 * Production validates fixed path/global metadata, hash, repeated deterministic bytes, UTF-8,
 * import/export/import.meta freedom, and output shape without executing arbitrary JavaScript.
 * Genuine pinned-provider tests prove those exact bytes install only ParticleStudio and preserve collisions.
 */
export interface PortableIifeBundleProvider {
  provide(input: PortableIifeBundleInput): Promise<PortableIifeBundle>;
}

/** Supplies generated runtime bytes from a trusted build authority. Adapter-specific builders require their shared exports. */
export interface PortableRuntimeGraphProvider {
  provide(): Promise<PortableRuntimeGraph>;
}

export interface VirtualFileMap {
  readonly paths: readonly string[];
  get(path: string): Uint8Array | undefined;
  entries(): readonly (readonly [string, Uint8Array])[];
}

export interface ExportManifest {
  readonly snapshotHash: string;
  readonly schemaVersion: 1;
  readonly canonicalizationVersion: CanonicalSceneDocument["identifier"];
  readonly runtimeVersion: typeof RUNTIME_VERSION;
  readonly assetHashes: readonly string[];
  readonly embeddedAssetBytes: number;
  readonly maxEmbeddedAssetBytes?: number;
  readonly adapterName: AdapterName;
  readonly packagingPolicy: PackagingPolicy;
  readonly moduleEntry: string;
  readonly fileHashes: Readonly<Record<string, string>>;
}

export interface ApprovedEsmVirtualExport {
  readonly files: VirtualFileMap;
  readonly manifest: ExportManifest;
  readonly document: SceneDocumentV1;
  evaluateAt(timeUs: number, options?: EvaluationOptions): EvaluationResult;
}

export interface BuildApprovedEsmVirtualMapInput {
  readonly approval: unknown;
  readonly assets: Pick<AssetPersistencePort, "readAsset">;
  readonly runtimeGraphProvider: PortableRuntimeGraphProvider;
}

export interface ApprovedWebComponentVirtualExport {
  readonly files: VirtualFileMap;
  readonly manifest: ExportManifest;
  readonly document: SceneDocumentV1;
}

export interface BuildApprovedWebComponentVirtualMapInput {
  readonly approval: unknown;
  readonly assets: Pick<AssetPersistencePort, "readAsset">;
  readonly runtimeGraphProvider: PortableRuntimeGraphProvider;
}

export interface ApprovedIifeVirtualExport {
  readonly files: VirtualFileMap;
  readonly manifest: ExportManifest;
  readonly document: SceneDocumentV1;
}

export interface BuildApprovedIifeVirtualMapInput {
  readonly approval: unknown;
  readonly assets: Pick<AssetPersistencePort, "readAsset">;
  readonly runtimeGraphProvider: PortableRuntimeGraphProvider;
  readonly iifeBundleProvider: PortableIifeBundleProvider;
}

/**
 * Trusted build-time provider of the fixed delivery runtime. It receives no
 * approval, document, asset, or virtual-module input: those values are bound
 * only after exporter validation while finalizing the HTML.
 */
export interface PortableSelfContainedRuntimeProvider {
  provide(): Promise<PortableIifeBundle>;
}

export type BuildApprovedSelfContainedHtmlVirtualMapInput =
  | {
      readonly approval: unknown;
      readonly assets: Pick<AssetPersistencePort, "readAsset">;
      readonly selfContainedRuntimeProvider: PortableSelfContainedRuntimeProvider;
      readonly runtimeGraphProvider?: never;
      readonly iifeBundleProvider?: never;
    }
  | (BuildApprovedIifeVirtualMapInput & {
      readonly selfContainedRuntimeProvider?: never;
    });

export interface ApprovedSelfContainedHtmlVirtualExport {
  readonly files: VirtualFileMap;
  readonly manifest: ExportManifest;
  readonly document: SceneDocumentV1;
}

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength &&
  left.every((byte, index) => byte === right[index]);

const cloneBytes = (bytes: Uint8Array) => bytes.slice();

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as object)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await webPlatform.crypto.subtle.digest("SHA-256", bytes),
  );
  let result = "sha256:";
  for (const byte of digest) {
    result += SHA256_HEX[byte >>> 4]! + SHA256_HEX[byte & 15]!;
  }
  return result;
}

function invalid(code: ExportErrorCode): never {
  throw new ExportError(code);
}

function invalidPathCharacters(path: string): boolean {
  return /[\u0000-\u001f\u007f\\%?#:]/.test(path) || /\s/.test(path);
}

function pathSegments(path: string): readonly string[] {
  const segments = path.split("/");
  if (segments.some((segment) => segment === "")) {
    invalid("EXPORT_GRAPH_INVALID");
  }
  return segments;
}

function hasTerminalDotSegment(segments: readonly string[]): boolean {
  const terminal = segments[segments.length - 1]!;
  return terminal === "." || terminal === "..";
}

function canonicalPath(path: unknown): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    invalidPathCharacters(path) ||
    pathSegments(path).some((segment) => segment === "." || segment === "..")
  ) {
    invalid("EXPORT_GRAPH_INVALID");
  }
  return path;
}

function resolveSpecifier(sourcePath: string, specifier: string): string {
  if (
    (!specifier.startsWith("./") && !specifier.startsWith("../")) ||
    invalidPathCharacters(specifier)
  ) {
    invalid("EXPORT_GRAPH_INVALID");
  }
  const segments = pathSegments(specifier);
  if (hasTerminalDotSegment(segments)) invalid("EXPORT_GRAPH_INVALID");
  const resolved = sourcePath.split("/").slice(0, -1);
  for (const segment of segments) {
    if (segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0) invalid("EXPORT_GRAPH_INVALID");
      resolved.pop();
    } else {
      resolved.push(segment);
    }
  }
  return canonicalPath(resolved.join("/"));
}

async function importsForModule(source: string): Promise<readonly string[]> {
  await initializeModuleLexer;
  let imports: ReturnType<typeof parseModule>[0];
  try {
    [imports] = parseModule(source);
  } catch {
    invalid("EXPORT_GRAPH_INVALID");
  }
  const specifiers: string[] = [];
  for (const imported of imports) {
    if (imported.t === ImportType.ImportMeta) continue;
    if (
      (imported.t !== ImportType.Static && imported.t !== ImportType.Dynamic) ||
      imported.n === undefined ||
      imported.a !== -1 ||
      (imported.t === ImportType.Dynamic &&
        !["'", '"'].includes(source[imported.s] ?? ""))
    ) {
      invalid("EXPORT_GRAPH_INVALID");
    }
    specifiers.push(imported.n);
  }
  return specifiers;
}

interface ValidatedGraph {
  readonly entryPath: string;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

async function validateGraph(graph: unknown): Promise<ValidatedGraph> {
  if (graph === null || typeof graph !== "object")
    invalid("EXPORT_GRAPH_INVALID");
  const candidate = graph as Partial<PortableRuntimeGraph>;
  const entryPath = canonicalPath(candidate.entryPath);
  if (!Array.isArray(candidate.files) || candidate.files.length === 0) {
    invalid("EXPORT_GRAPH_INVALID");
  }
  const files = new Map<string, Uint8Array>();
  let previousPath: string | undefined;
  for (const entry of candidate.files) {
    if (entry === null || typeof entry !== "object")
      invalid("EXPORT_GRAPH_INVALID");
    const path = canonicalPath(entry.path);
    if (previousPath !== undefined && previousPath >= path)
      invalid("EXPORT_GRAPH_INVALID");
    previousPath = path;
    if (
      !(entry.bytes instanceof Uint8Array) ||
      typeof entry.sha256 !== "string"
    ) {
      invalid("EXPORT_GRAPH_INVALID");
    }
    const bytes = cloneBytes(entry.bytes);
    if ((await sha256(bytes)) !== entry.sha256) invalid("EXPORT_GRAPH_INVALID");
    files.set(path, bytes);
  }
  if (!files.has(entryPath)) invalid("EXPORT_GRAPH_INVALID");
  const reached = new Set<string>();
  const visit = async (path: string): Promise<void> => {
    if (reached.has(path)) return;
    const bytes = files.get(path);
    if (bytes === undefined) invalid("EXPORT_GRAPH_INVALID");
    let source: string;
    try {
      source = textDecoder.decode(bytes);
    } catch {
      invalid("EXPORT_GRAPH_INVALID");
    }
    reached.add(path);
    for (const specifier of await importsForModule(source)) {
      const target = resolveSpecifier(path, specifier);
      if (!files.has(target)) invalid("EXPORT_GRAPH_INVALID");
      await visit(target);
    }
  };
  await visit(entryPath);

  if (reached.size !== files.size) invalid("EXPORT_GRAPH_INVALID");
  return { entryPath, files };
}

async function requireRuntimeExports(
  graph: ValidatedGraph,
  requiredExports: readonly string[],
): Promise<void> {
  const source = textDecoder.decode(graph.files.get(graph.entryPath)!);
  await initializeModuleLexer;
  try {
    const [, exports] = parseModule(source);
    const names = new Set(exports.map((exported) => exported.n));
    if (requiredExports.some((name) => !names.has(name))) {
      invalid("EXPORT_GRAPH_INVALID");
    }
  } catch (error) {
    if (error instanceof ExportError) throw error;
    invalid("EXPORT_GRAPH_INVALID");
  }
}

function relativeSpecifier(fromPath: string, targetPath: string): string {
  const from = fromPath.split("/").slice(0, -1);
  const target = targetPath.split("/");
  while (from[0] !== undefined && from[0] === target[0]) {
    from.shift();
    target.shift();
  }
  return `${from
    .map(() => "..")
    .concat(target)
    .join("/")}`.replace(/^([^.]|$)/, "./$1");
}

async function generatedAdapterGraph(
  documentBytes: Uint8Array,
  runtime: ValidatedGraph,
): Promise<ValidatedGraph> {
  const documentSource = textDecoder.decode(documentBytes);
  const documentModule = textEncoder.encode(
    `export const approvedDocument = ${documentSource};\n`,
  );
  const adapterModule = textEncoder.encode(
    `import { evaluateScene } from ${JSON.stringify(relativeSpecifier(GENERATED_ADAPTER_PATH, runtime.entryPath))};\n` +
      `import { approvedDocument } from ${JSON.stringify(relativeSpecifier(GENERATED_ADAPTER_PATH, GENERATED_DOCUMENT_PATH))};\n` +
      "export { approvedDocument };\n" +
      "export function evaluateAt(timeUs, options) { return evaluateScene(approvedDocument, timeUs, options); }\n",
  );
  const files = [
    ...[...runtime.files.entries()].map(async ([path, bytes]) => ({
      path,
      bytes,
      sha256: await sha256(bytes),
    })),
    {
      path: GENERATED_DOCUMENT_PATH,
      bytes: documentModule,
      sha256: await sha256(documentModule),
    },
    {
      path: GENERATED_ADAPTER_PATH,
      bytes: adapterModule,
      sha256: await sha256(adapterModule),
    },
  ];
  return validateGraph({
    entryPath: GENERATED_ADAPTER_PATH,
    files: await Promise.all(files).then((entries) =>
      entries.sort((left, right) => left.path.localeCompare(right.path)),
    ),
  });
}

function graphIsEqual(left: ValidatedGraph, right: ValidatedGraph): boolean {
  if (
    left.entryPath !== right.entryPath ||
    left.files.size !== right.files.size
  )
    return false;
  for (const [path, bytes] of left.files) {
    const other = right.files.get(path);
    if (other === undefined || !equalBytes(bytes, other)) return false;
  }
  return true;
}

async function readVerifiedAssets(
  approval: ApprovalRecord,
  assets: Pick<AssetPersistencePort, "readAsset">,
): Promise<readonly [string, Uint8Array][]> {
  const output: [string, Uint8Array][] = [];
  for (const expected of approval.verifiedAssetManifest) {
    let asset: ContentAddressedAsset;
    try {
      asset = await assets.readAsset(expected.sha256);
    } catch {
      invalid("EXPORT_ASSET_UNAVAILABLE");
    }
    if (asset === null || typeof asset !== "object") {
      invalid("EXPORT_ASSET_MISMATCH");
    }
    const bytes = asset.bytes;
    if (
      !(bytes instanceof Uint8Array) ||
      asset.sha256 !== expected.sha256 ||
      asset.mimeType !== expected.mimeType ||
      asset.byteLength !== expected.byteLength ||
      bytes.byteLength !== expected.byteLength ||
      (await sha256(bytes)) !== expected.sha256
    ) {
      invalid("EXPORT_ASSET_MISMATCH");
    }
    output.push([
      `assets/${expected.sha256.slice("sha256:".length)}`,
      cloneBytes(bytes),
    ]);
  }
  return output;
}

function sameManifest(
  left: readonly VerifiedAssetManifestEntry[],
  right: readonly VerifiedAssetManifestEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.sha256 === right[index]?.sha256 &&
        entry.mimeType === right[index]?.mimeType &&
        entry.byteLength === right[index]?.byteLength,
    )
  );
}

async function revalidateApproval(approvalInput: unknown): Promise<{
  approval: ApprovalRecord;
  document: SceneDocumentV1;
  canonicalizationVersion: CanonicalSceneDocument["identifier"];
}> {
  let approval: ApprovalRecord;
  try {
    approval = validateApprovalRecord(approvalInput);
  } catch {
    invalid("EXPORT_APPROVAL_INVALID");
  }
  if (readApprovalRecordRuntimeVersion(approval) !== RUNTIME_VERSION) {
    invalid("EXPORT_APPROVAL_RUNTIME_VERSION_MISMATCH");
  }
  let envelopeValue: unknown;
  let documentValue: unknown;
  try {
    envelopeValue = JSON.parse(
      textDecoder.decode(approval.approvalEnvelopeBytes),
    );
    documentValue = JSON.parse(
      textDecoder.decode(approval.canonicalDocumentBytes),
    );
  } catch {
    invalid("EXPORT_APPROVAL_EVIDENCE_MISMATCH");
  }
  let recreated: Awaited<ReturnType<typeof createApprovalEnvelope>>;
  try {
    const envelope = envelopeValue as Record<string, unknown>;
    recreated = await createApprovalEnvelope({
      document: envelope.document,
      runtimeVersion: envelope.runtimeVersion,
      verifiedAssetManifest: envelope.verifiedAssetManifest,
    });
  } catch {
    invalid("EXPORT_APPROVAL_EVIDENCE_MISMATCH");
  }
  const evidence = readCanonicalApprovalEvidence(recreated);
  if (
    evidence.runtimeVersion !== RUNTIME_VERSION ||
    approval.snapshotHash !== evidence.snapshotHash ||
    !equalBytes(
      approval.approvalEnvelopeBytes,
      evidence.approvalEnvelopeBytes,
    ) ||
    !equalBytes(
      approval.canonicalDocumentBytes,
      evidence.canonicalDocumentBytes,
    ) ||
    !sameManifest(
      approval.verifiedAssetManifest,
      evidence.verifiedAssetManifest,
    )
  ) {
    invalid("EXPORT_APPROVAL_EVIDENCE_MISMATCH");
  }
  const validation = validateSceneDocument(documentValue);
  if (!validation.ok) invalid("EXPORT_APPROVAL_EVIDENCE_MISMATCH");
  const canonical = canonicalizeSceneDocument(validation.value);
  if (!equalBytes(canonical.bytes, approval.canonicalDocumentBytes)) {
    invalid("EXPORT_APPROVAL_EVIDENCE_MISMATCH");
  }
  return {
    approval,
    document: validation.value,
    canonicalizationVersion: canonical.identifier,
  };
}

class StoredVirtualFileMap implements VirtualFileMap {
  readonly #files: ReadonlyMap<string, Uint8Array>;
  readonly paths: readonly string[];

  constructor(files: ReadonlyMap<string, Uint8Array>) {
    this.#files = new Map(
      [...files.entries()].map(([path, bytes]) => [path, cloneBytes(bytes)]),
    );
    this.paths = Object.freeze([...this.#files.keys()].sort());
    Object.freeze(this);
  }

  get(path: string): Uint8Array | undefined {
    const bytes = this.#files.get(path);
    return bytes === undefined ? undefined : cloneBytes(bytes);
  }

  entries(): readonly (readonly [string, Uint8Array])[] {
    return Object.freeze(
      this.paths.map((path) =>
        Object.freeze([path, cloneBytes(this.#files.get(path)!)] as const),
      ),
    );
  }
}

function frozenManifest(manifest: ExportManifest): ExportManifest {
  return Object.freeze({
    ...manifest,
    assetHashes: Object.freeze([...manifest.assetHashes]),
    fileHashes: Object.freeze({ ...manifest.fileHashes }),
  });
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(bytes: Uint8Array): string {
  let encoded = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const first = bytes[offset]!;
    const second = bytes[offset + 1];
    const third = bytes[offset + 2];
    encoded += BASE64_ALPHABET[first >>> 2]!;
    encoded += BASE64_ALPHABET[((first & 3) << 4) | ((second ?? 0) >>> 4)]!;
    encoded +=
      second === undefined
        ? "="
        : BASE64_ALPHABET[((second & 15) << 2) | ((third ?? 0) >>> 6)]!;
    encoded += third === undefined ? "=" : BASE64_ALPHABET[third & 63]!;
  }
  return encoded;
}

function dataUrl(mimeType: string, bytes: Uint8Array): string {
  return `data:${mimeType};base64,${base64(bytes)}`;
}

async function embeddedAssetUrls(
  approval: ApprovalRecord,
  assets: readonly (readonly [string, Uint8Array])[],
): Promise<{
  readonly total: number;
  readonly urlsByHash: ReadonlyMap<string, string>;
}> {
  const bytesByHash = new Map<string, Uint8Array>();
  for (const [path, bytes] of assets) {
    bytesByHash.set(`sha256:${path.slice("assets/".length)}`, bytes);
  }
  const urlsByHash = new Map<string, string>();
  let total = 0;
  for (const asset of approval.verifiedAssetManifest) {
    if (urlsByHash.has(asset.sha256)) continue;
    const bytes = bytesByHash.get(asset.sha256);
    if (bytes === undefined) invalid("EXPORT_ASSET_MISMATCH");
    if (asset.byteLength > EMBEDDED_ASSET_LIMIT - total) {
      invalid("EXPORT_EMBEDDED_ASSET_LIMIT_EXCEEDED");
    }
    total += asset.byteLength;
    urlsByHash.set(asset.sha256, dataUrl(asset.mimeType, bytes));
  }
  return { total, urlsByHash };
}

function autoMountBootstrapBytes(): Uint8Array {
  return textEncoder.encode(`(() => {
  const host = document.querySelector('[data-particle-studio-export-host="true"]');
  const fail = (error) => host?.setAttribute("data-particle-studio-export-error", error instanceof Error ? error.message : "PARTICLE_STUDIO_BOOTSTRAP_FAILED");
  if (!(host instanceof HTMLElement)) { fail(); return; }
  try {
    const controller = globalThis.ParticleStudio.mount(host);
    Promise.resolve(controller.ready).then(() => {
      try { controller.renderAt(0); } catch (error) { fail(error); }
    }, fail);
  } catch (error) { fail(error); }
})();\n`);
}

function htmlJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function selfContainedHtmlBytes(
  bundle: Uint8Array,
  approval: ApprovalRecord,
  assets: readonly BrowserAssetMetadata[],
): Uint8Array {
  const bundleUrl = dataUrl("text/javascript;charset=utf-8", bundle);
  const bootstrapUrl = dataUrl(
    "text/javascript;charset=utf-8",
    autoMountBootstrapBytes(),
  );
  const envelopeJson = htmlJson({
    snapshotHash: approval.snapshotHash,
    envelope: JSON.parse(textDecoder.decode(approval.approvalEnvelopeBytes)),
  });
  const assetsJson = htmlJson(assets);
  return textEncoder.encode(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Particle Studio</title></head>
<body><div id="particle-studio-export-host" data-particle-studio-export-host="true"></div><script id="particle-studio-approved-envelope" type="application/json">${envelopeJson}</script><script id="particle-studio-approved-assets" type="application/json">${assetsJson}</script><script src="${bundleUrl}"></script><script src="${bootstrapUrl}"></script></body>
</html>
`);
}

async function finalizeSelfContainedHtmlVirtualExport(input: {
  readonly approval: ApprovalRecord;
  readonly document: SceneDocumentV1;
  readonly canonicalizationVersion: CanonicalSceneDocument["identifier"];
  readonly bundle: PortableIifeBundle;
  readonly assets: readonly BrowserAssetMetadata[];
  readonly embeddedAssetBytes: number;
}): Promise<ApprovedSelfContainedHtmlVirtualExport> {
  const html = selfContainedHtmlBytes(
    input.bundle.bytes,
    input.approval,
    input.assets,
  );
  const manifest = frozenManifest({
    snapshotHash: input.approval.snapshotHash,
    schemaVersion: input.document.schemaVersion,
    canonicalizationVersion: input.canonicalizationVersion,
    runtimeVersion: RUNTIME_VERSION,
    assetHashes: Object.freeze(
      input.approval.verifiedAssetManifest.map((asset) => asset.sha256).sort(),
    ),
    embeddedAssetBytes: input.embeddedAssetBytes,
    maxEmbeddedAssetBytes: EMBEDDED_ASSET_LIMIT,
    adapterName: HTML_ADAPTER_NAME,
    packagingPolicy: HTML_PACKAGING_POLICY,
    moduleEntry: HTML_PATH,
    fileHashes: { [HTML_PATH]: await sha256(html) },
  });
  const storedDocument = freezeDeep(
    JSON.parse(
      textDecoder.decode(input.approval.canonicalDocumentBytes),
    ) as SceneDocumentV1,
  );
  return Object.freeze({
    files: new StoredVirtualFileMap(new Map([[HTML_PATH, html]])),
    manifest,
    document: Object.freeze(storedDocument),
  });
}

async function readStableRuntimeGraph(
  provider: PortableRuntimeGraphProvider,
  requiredExports: readonly string[],
): Promise<ValidatedGraph> {
  let firstGraph: ValidatedGraph;
  let secondGraph: ValidatedGraph;
  try {
    firstGraph = await validateGraph(await provider.provide());
    secondGraph = await validateGraph(await provider.provide());
  } catch (error) {
    if (error instanceof ExportError) throw error;
    invalid("EXPORT_GRAPH_PROVIDER_FAILED");
  }
  if (!graphIsEqual(firstGraph, secondGraph)) invalid("EXPORT_GRAPH_UNSTABLE");
  await requireRuntimeExports(firstGraph, requiredExports);
  return firstGraph;
}

function rejectReservedProviderPaths(
  graph: ValidatedGraph,
  reservedPaths: readonly string[],
): void {
  for (const path of graph.files.keys()) {
    if (reservedPaths.includes(path) || path.startsWith("assets/")) {
      invalid("EXPORT_GRAPH_INVALID");
    }
  }
}

async function finalizeVirtualMap(input: {
  readonly approval: ApprovalRecord;
  readonly document: SceneDocumentV1;
  readonly canonicalizationVersion: CanonicalSceneDocument["identifier"];
  readonly assets: readonly (readonly [string, Uint8Array])[];
  readonly graph: ValidatedGraph;
  readonly adapterName: AdapterName;
}): Promise<ApprovedWebComponentVirtualExport> {
  const staged = new Map<string, Uint8Array>();
  const stage = (path: string, bytes: Uint8Array) => {
    if (staged.has(path)) invalid("EXPORT_GRAPH_INVALID");
    staged.set(path, cloneBytes(bytes));
  };
  stage(DOCUMENT_PATH, input.approval.canonicalDocumentBytes);
  for (const [path, bytes] of input.assets) stage(path, bytes);
  for (const [path, bytes] of input.graph.files) stage(path, bytes);
  const fileHashes: Record<string, string> = {};
  for (const path of [...staged.keys()].sort()) {
    fileHashes[path] = await sha256(staged.get(path)!);
  }
  const manifest = frozenManifest({
    snapshotHash: input.approval.snapshotHash,
    schemaVersion: input.document.schemaVersion,
    canonicalizationVersion: input.canonicalizationVersion,
    runtimeVersion: RUNTIME_VERSION,
    assetHashes: Object.freeze(
      input.approval.verifiedAssetManifest.map((entry) => entry.sha256).sort(),
    ),
    embeddedAssetBytes: 0,
    adapterName: input.adapterName,
    packagingPolicy: PACKAGING_POLICY,
    moduleEntry: input.graph.entryPath,
    fileHashes,
  });
  stage(MANIFEST_PATH, textEncoder.encode(JSON.stringify(manifest)));
  const storedDocument = freezeDeep(
    JSON.parse(
      textDecoder.decode(input.approval.canonicalDocumentBytes),
    ) as SceneDocumentV1,
  );
  return Object.freeze({
    files: new StoredVirtualFileMap(staged),
    manifest,
    document: Object.freeze(storedDocument),
  });
}

export async function buildApprovedEsmVirtualMap(
  input: BuildApprovedEsmVirtualMapInput,
): Promise<ApprovedEsmVirtualExport> {
  const { approval, document, canonicalizationVersion } =
    await revalidateApproval(input.approval);
  const assets = await readVerifiedAssets(approval, input.assets);
  const firstGraph = await readStableRuntimeGraph(input.runtimeGraphProvider, [
    "evaluateScene",
  ]);
  rejectReservedProviderPaths(firstGraph, [
    MANIFEST_PATH,
    DOCUMENT_PATH,
    GENERATED_DOCUMENT_PATH,
    GENERATED_ADAPTER_PATH,
  ]);
  const combinedGraph = await generatedAdapterGraph(
    approval.canonicalDocumentBytes,
    firstGraph,
  );
  const finalized = await finalizeVirtualMap({
    approval,
    document,
    canonicalizationVersion,
    assets,
    graph: combinedGraph,
    adapterName: ESM_ADAPTER_NAME,
  });
  return Object.freeze({
    ...finalized,
    evaluateAt(timeUs: number, options?: EvaluationOptions): EvaluationResult {
      return evaluateScene(finalized.document, timeUs, options);
    },
  });
}

interface BrowserAssetMetadata {
  readonly path: string;
  readonly sha256: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
}

function browserAssetMetadata(
  document: SceneDocumentV1,
  approval: ApprovalRecord,
  urlsByHash: ReadonlyMap<string, string> = new Map(),
): readonly BrowserAssetMetadata[] {
  const references = document.elements.filter(
    (
      element,
    ): element is Extract<
      SceneDocumentV1["elements"][number],
      { type: "image" }
    > => element.type === "image",
  );
  const output: BrowserAssetMetadata[] = [];
  const seen = new Set<string>();
  for (const expected of approval.verifiedAssetManifest) {
    if (seen.has(expected.sha256)) invalid("EXPORT_ASSET_MISMATCH");
    seen.add(expected.sha256);
    const matches = references.filter(
      (reference) => reference.asset.sha256 === expected.sha256,
    );
    if (
      matches.length === 0 ||
      matches.some(
        (reference) =>
          reference.asset.mimeType !== expected.mimeType ||
          reference.asset.byteLength !== expected.byteLength ||
          reference.asset.intrinsicWidth !== matches[0]!.asset.intrinsicWidth ||
          reference.asset.intrinsicHeight !== matches[0]!.asset.intrinsicHeight,
      )
    ) {
      invalid("EXPORT_ASSET_MISMATCH");
    }
    output.push({
      path:
        urlsByHash.get(expected.sha256) ??
        `assets/${expected.sha256.slice("sha256:".length)}`,
      sha256: expected.sha256,
      mimeType: expected.mimeType,
      byteLength: expected.byteLength,
      intrinsicWidth: matches[0]!.asset.intrinsicWidth,
      intrinsicHeight: matches[0]!.asset.intrinsicHeight,
    });
  }
  if (references.some((reference) => !seen.has(reference.asset.sha256))) {
    invalid("EXPORT_ASSET_MISMATCH");
  }
  return Object.freeze(output);
}

function canvasSize(document: SceneDocumentV1): {
  width: number;
  height: number;
} {
  let width = 1;
  let height = 1;
  for (const element of document.elements) {
    if (element.type === "shape" || element.type === "image") {
      width = Math.max(width, element.x + element.width);
      height = Math.max(height, element.y + element.height);
    } else if (element.type === "line") {
      width = Math.max(width, element.x1, element.x2);
      height = Math.max(height, element.y1, element.y2);
    } else if (element.type === "text") {
      width = Math.max(width, element.x);
      height = Math.max(height, element.y + element.fontSize);
    } else if (element.type === "particle") {
      width = Math.max(width, element.x + element.spread + element.size);
      height = Math.max(height, element.y + element.spread + element.size);
    }
  }
  return {
    width: Math.max(1, Math.ceil(width)),
    height: Math.max(1, Math.ceil(height)),
  };
}

async function browserControllerGraph(
  documentBytes: Uint8Array,
  assets: readonly BrowserAssetMetadata[],
  runtime: ValidatedGraph,
  adapter: "web-component" | "iife",
): Promise<ValidatedGraph> {
  const documentModule = textEncoder.encode(
    `export const approvedDocument = ${textDecoder.decode(documentBytes)};\n`,
  );
  const assetsModule = textEncoder.encode(
    `export const approvedAssets = ${JSON.stringify(assets)};\n` +
      `export const approvedCanvas = ${JSON.stringify(canvasSize(JSON.parse(textDecoder.decode(documentBytes)) as SceneDocumentV1))};\n`,
  );
  const controller =
    textEncoder.encode(`import { evaluateScene, renderCommands } from ${JSON.stringify(relativeSpecifier(BROWSER_CONTROLLER_PATH, runtime.entryPath))};
import { approvedDocument } from ${JSON.stringify(relativeSpecifier(BROWSER_CONTROLLER_PATH, GENERATED_DOCUMENT_PATH))};
import { approvedAssets, approvedCanvas } from ${JSON.stringify(relativeSpecifier(BROWSER_CONTROLLER_PATH, GENERATED_ASSETS_PATH))};

const sha256 = async (bytes) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "sha256:" + [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
const failure = (value) => value instanceof Error ? value : new Error("BROWSER_CONTROLLER_FAILURE");

export function createBrowserController(canvas, assetBaseUrl) {
  let status = "loading";
  let controller = new AbortController();
  let handles = new Map();
  canvas.width = approvedCanvas.width;
  canvas.height = approvedCanvas.height;
  const release = () => { for (const handle of handles.values()) if (typeof handle.close === "function") handle.close(); handles.clear(); };
  const ready = (async () => {
    try {
      for (const asset of approvedAssets) {
        let assetUrl;
        try { assetUrl = new URL(asset.path).href; }
        catch {
          if (!assetBaseUrl) throw new Error("PARTICLE_STUDIO_ASSET_BASE_URL_REQUIRED");
          assetUrl = new URL(asset.path, assetBaseUrl).href;
        }
        const response = await fetch(assetUrl, { signal: controller.signal });
        const responseMime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (!response.ok || responseMime !== asset.mimeType) throw new Error("BROWSER_CONTROLLER_ASSET_RESPONSE_INVALID");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== asset.byteLength || await sha256(bytes) !== asset.sha256) throw new Error("BROWSER_CONTROLLER_ASSET_HASH_MISMATCH");
        const handle = await createImageBitmap(new Blob([bytes], { type: asset.mimeType }));
        if (controller.signal.aborted || handle.width !== asset.intrinsicWidth || handle.height !== asset.intrinsicHeight) {
          handle.close();
          throw new Error(controller.signal.aborted ? "BROWSER_CONTROLLER_DESTROYED" : "BROWSER_CONTROLLER_ASSET_DIMENSIONS_MISMATCH");
        }
        handles.set(asset.sha256, handle);
      }
      if (controller.signal.aborted) throw new Error("BROWSER_CONTROLLER_DESTROYED");
      status = "ready";
    } catch (error) {
      release();
      if (controller.signal.aborted) throw new Error("BROWSER_CONTROLLER_DESTROYED");
      status = "failed";
      throw failure(error);
    }
  })();
  return Object.freeze({
    ready,
    renderAt(timeUs) {
      if (status !== "ready") throw new Error("BROWSER_CONTROLLER_NOT_READY");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("BROWSER_CONTROLLER_CANVAS_UNAVAILABLE");
      const result = evaluateScene(approvedDocument, timeUs, { imageResolver: { resolve: (asset) => {
        const handle = handles.get(asset.sha256);
        return handle === undefined ? undefined : { handle, ...asset };
      } } });
      canvas.width = canvas.width;
      renderCommands(context, result.commands);
      return result;
    },
    destroy() {
      if (status === "destroyed") return;
      status = "destroyed";
      controller.abort();
      release();
    },
  });
}
`);
  const wrapper =
    adapter === "web-component"
      ? textEncoder.encode(`import { createBrowserController } from ${JSON.stringify(relativeSpecifier(WEB_COMPONENT_PATH, BROWSER_CONTROLLER_PATH))};
const tagName = "particle-studio-scene";
const errorEvent = "particle-studio-error";
const errorFor = (value) => value instanceof Error ? value : new Error("WEB_COMPONENT_FAILURE");
if (!customElements.get(tagName)) customElements.define(tagName, class ParticleStudioScene extends HTMLElement {
  static get observedAttributes() { return ["time-us"]; }
  ready; #status = "disconnected"; #connectedOnce = false; #controller; #resolveReady; #rejectReady; #canvas;
  constructor() { super(); const root = this.attachShadow({ mode: "open" }); this.#canvas = document.createElement("canvas"); this.#canvas.setAttribute("aria-label", "Particle Studio scene"); root.append(this.#canvas); this.#renewReady(); }
  #renewReady() { this.ready = new Promise((resolve, reject) => { this.#resolveReady = resolve; this.#rejectReady = reject; }); }
  connectedCallback() { if (this.#status === "loading" || this.#status === "ready") return; if (this.#connectedOnce) this.#renewReady(); this.#connectedOnce = true; this.#status = "loading"; const controller = createBrowserController(this.#canvas, new URL(".", import.meta.url).href); this.#controller = controller; void controller.ready.then(() => { if (this.#controller !== controller) return; this.#status = "ready"; const requested = this.timeUs; if (requested !== undefined) this.renderAt(requested); this.#resolveReady(); }, (error) => { if (this.#controller !== controller || this.#status === "disconnected") return; this.#status = "failed"; this.#rejectReady(this.#report(error)); }); }
  disconnectedCallback() { const wasLoading = this.#status === "loading"; this.#status = "disconnected"; this.#controller?.destroy(); this.#controller = undefined; if (wasLoading) this.#rejectReady(new Error("WEB_COMPONENT_DISCONNECTED")); }
  get timeUs() { const value = this.getAttribute("time-us"); return value === null ? undefined : Number(value); }
  set timeUs(value) { this.setAttribute("time-us", String(value)); }
  attributeChangedCallback(name, previous, value) { if (name !== "time-us" || previous === value || value === null || this.#status !== "ready") return; try { this.renderAt(Number(value)); } catch {} }
  #report(error) { const received = errorFor(error); const reported = received.message.startsWith("BROWSER_CONTROLLER_") ? new Error(received.message.replace("BROWSER_CONTROLLER_", "WEB_COMPONENT_")) : received; if (this.isConnected && this.#status !== "disconnected") this.dispatchEvent(new CustomEvent(errorEvent, { detail: { code: reported.message } })); return reported; }
  renderAt(timeUs) { if (this.#status !== "ready") throw this.#report(new Error("WEB_COMPONENT_NOT_READY")); try { return this.#controller.renderAt(timeUs); } catch (error) { throw this.#report(error); } }
});
`)
      : textEncoder.encode(`import { createBrowserController } from ${JSON.stringify(relativeSpecifier(IIFE_ENTRY_PATH, BROWSER_CONTROLLER_PATH))};
const script = document.currentScript;
const scriptDirectory = (() => {
  try {
    const source = script && typeof script.src === "string" && script.src.length > 0 ? script.src : undefined;
    return source ? new URL(".", source).href : undefined;
  } catch { return undefined; }
})();
if ("ParticleStudio" in globalThis) throw new Error("PARTICLE_STUDIO_GLOBAL_COLLISION");
const publicError = (value) => {
  const received = value instanceof Error ? value : new Error("PARTICLE_STUDIO_FAILURE");
  if (received.message.startsWith("BROWSER_CONTROLLER_")) return new Error(received.message.replace("BROWSER_CONTROLLER_", "PARTICLE_STUDIO_"));
  return received.message.startsWith("PARTICLE_STUDIO_") ? received : new Error("PARTICLE_STUDIO_FAILURE");
};
const mount = (target, options = {}) => {
  if (!(target instanceof HTMLElement)) throw new Error("PARTICLE_STUDIO_TARGET_INVALID");
  const canvas = document.createElement("canvas");
  target.append(canvas);
  const controller = createBrowserController(canvas, options.assetBaseUrl ?? scriptDirectory);
  let destroyed = false;
  return Object.freeze({
    ready: controller.ready.catch((error) => { throw publicError(error); }),
    renderAt: (timeUs) => {
      if (destroyed) throw new Error("PARTICLE_STUDIO_DESTROYED");
      try { return controller.renderAt(timeUs); } catch (error) { throw publicError(error); }
    },
    destroy: () => { if (destroyed) return; destroyed = true; controller.destroy(); canvas.remove(); },
  });
};
globalThis.ParticleStudio = Object.freeze({ mount });
`);
  const entryPath =
    adapter === "web-component" ? WEB_COMPONENT_PATH : IIFE_ENTRY_PATH;
  const files = [
    ...[...runtime.files.entries()].map(async ([path, bytes]) => ({
      path,
      bytes,
      sha256: await sha256(bytes),
    })),
    {
      path: GENERATED_DOCUMENT_PATH,
      bytes: documentModule,
      sha256: await sha256(documentModule),
    },
    {
      path: GENERATED_ASSETS_PATH,
      bytes: assetsModule,
      sha256: await sha256(assetsModule),
    },
    {
      path: BROWSER_CONTROLLER_PATH,
      bytes: controller,
      sha256: await sha256(controller),
    },
    { path: entryPath, bytes: wrapper, sha256: await sha256(wrapper) },
  ];
  return validateGraph({
    entryPath,
    files: await Promise.all(files).then((entries) =>
      entries.sort((left, right) => left.path.localeCompare(right.path)),
    ),
  });
}

/**
 * Source consumed only by the editor's Vite configuration. Rolldown compiles
 * this fixed entry at editor build time; it never receives approval data.
 */
function _legacySelfContainedRuntimeEntrySource(): string {
  return `import { evaluateScene } from "@particle-studio/runtime";
import { renderCommands } from "@particle-studio/renderer-canvas2d";

const bindingError = () => new Error("PARTICLE_STUDIO_APPROVED_BINDING_INVALID");
const readBinding = (id) => {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLScriptElement) || node.type !== "application/json") throw bindingError();
  try { return JSON.parse(node.textContent ?? ""); } catch { throw bindingError(); }
};
const canvasSize = (documentValue) => {
  let width = 1; let height = 1;
  for (const element of documentValue.elements ?? []) {
    if (element.type === "shape" || element.type === "image") { width = Math.max(width, element.x + element.width); height = Math.max(height, element.y + element.height); }
    else if (element.type === "line") { width = Math.max(width, element.x1, element.x2); height = Math.max(height, element.y1, element.y2); }
    else if (element.type === "text") { width = Math.max(width, element.x); height = Math.max(height, element.y + element.fontSize); }
    else if (element.type === "particle") { width = Math.max(width, element.x + element.spread + element.size); height = Math.max(height, element.y + element.spread + element.size); }
  }
  return { width: Math.max(1, Math.ceil(width)), height: Math.max(1, Math.ceil(height)) };
};
const bytesFromDataUrl = (asset) => {
  if (asset === null || typeof asset !== "object" || typeof asset.path !== "string" || typeof asset.mimeType !== "string" || typeof asset.sha256 !== "string" || !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 0 || !Number.isSafeInteger(asset.intrinsicWidth) || !Number.isSafeInteger(asset.intrinsicHeight)) throw bindingError();
  const matched = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(asset.path);
  if (matched === null || matched[1] !== asset.mimeType) throw bindingError();
  let decoded;
  try { decoded = atob(matched[2]); } catch { throw bindingError(); }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
};
const sha256 = async (bytes) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "sha256:" + [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
let approvedDocument; let approvedAssets; let approvedCanvas; let initialError;
try {
  approvedDocument = readBinding("particle-studio-approved-document");
  approvedAssets = readBinding("particle-studio-approved-assets");
  if (approvedDocument === null || typeof approvedDocument !== "object" || !Array.isArray(approvedAssets)) throw bindingError();
  approvedCanvas = canvasSize(approvedDocument);
} catch (error) { initialError = error instanceof Error ? error : bindingError(); }
const createBrowserController = (canvas) => {
  if (initialError) throw initialError;
  let status = "loading"; const controller = new AbortController(); const handles = new Map();
  canvas.width = approvedCanvas.width; canvas.height = approvedCanvas.height;
  const release = () => { for (const handle of handles.values()) if (typeof handle.close === "function") handle.close(); handles.clear(); };
  const ready = (async () => {
    try {
      for (const asset of approvedAssets) {
        const bytes = bytesFromDataUrl(asset);
        if (bytes.byteLength !== asset.byteLength || await sha256(bytes) !== asset.sha256) throw new Error("PARTICLE_STUDIO_ASSET_HASH_MISMATCH");
        const handle = await createImageBitmap(new Blob([bytes], { type: asset.mimeType }));
        if (controller.signal.aborted || handle.width !== asset.intrinsicWidth || handle.height !== asset.intrinsicHeight) { handle.close(); throw new Error(controller.signal.aborted ? "PARTICLE_STUDIO_DESTROYED" : "PARTICLE_STUDIO_ASSET_DIMENSIONS_MISMATCH"); }
        handles.set(asset.sha256, handle);
      }
      if (controller.signal.aborted) throw new Error("PARTICLE_STUDIO_DESTROYED");
      status = "ready";
    } catch (error) { release(); if (controller.signal.aborted) throw new Error("PARTICLE_STUDIO_DESTROYED"); status = "failed"; throw error instanceof Error ? error : new Error("PARTICLE_STUDIO_RUNTIME_FAILURE"); }
  })();
  return Object.freeze({
    ready,
    renderAt(timeUs) {
      if (status !== "ready") throw new Error("PARTICLE_STUDIO_NOT_READY");
      const context = canvas.getContext("2d"); if (!context) throw new Error("PARTICLE_STUDIO_CANVAS_UNAVAILABLE");
      const result = evaluateScene(approvedDocument, timeUs, { imageResolver: { resolve: (asset) => { const handle = handles.get(asset.sha256); return handle === undefined ? undefined : { handle, ...asset }; } } });
      canvas.width = canvas.width; renderCommands(context, result.commands); return result;
    },
    destroy() { if (status === "destroyed") return; status = "destroyed"; controller.abort(); release(); },
  });
};
if ("ParticleStudio" in globalThis) throw new Error("PARTICLE_STUDIO_GLOBAL_COLLISION");
const mount = (target) => {
  if (!(target instanceof HTMLElement)) throw new Error("PARTICLE_STUDIO_TARGET_INVALID");
  const canvas = document.createElement("canvas"); target.append(canvas);
  const controller = createBrowserController(canvas); let destroyed = false;
  return Object.freeze({
    ready: controller.ready,
    renderAt(timeUs) { if (destroyed) throw new Error("PARTICLE_STUDIO_DESTROYED"); return controller.renderAt(timeUs); },
    destroy() { if (destroyed) return; destroyed = true; controller.destroy(); canvas.remove(); },
  });
};
globalThis.ParticleStudio = Object.freeze({ mount });
`;
}

async function webComponentGraph(
  documentBytes: Uint8Array,
  assets: readonly BrowserAssetMetadata[],
  runtime: ValidatedGraph,
): Promise<ValidatedGraph> {
  return browserControllerGraph(
    documentBytes,
    assets,
    runtime,
    "web-component",
  );
}

function iifeProviderInput(graph: ValidatedGraph): PortableIifeBundleInput {
  return {
    entryPath: IIFE_ENTRY_PATH,
    globalName: IIFE_GLOBAL_NAME,
    files: [...graph.files.entries()]
      .map(([path, bytes]) => ({ path, bytes: cloneBytes(bytes), sha256: "" }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  } as PortableIifeBundleInput;
}

async function bundleInputWithHashes(
  graph: ValidatedGraph,
): Promise<PortableIifeBundleInput> {
  const input = iifeProviderInput(graph);
  return {
    ...input,
    files: await Promise.all(
      input.files.map(async (file) => ({
        ...file,
        sha256: await sha256(file.bytes),
      })),
    ),
  };
}

async function validateIifeBundle(value: unknown): Promise<PortableIifeBundle> {
  if (value === null || typeof value !== "object")
    invalid("EXPORT_IIFE_INVALID");
  const candidate = value as Partial<PortableIifeBundle>;
  if (
    candidate.path !== IIFE_BUNDLE_PATH ||
    candidate.globalName !== IIFE_GLOBAL_NAME ||
    !(candidate.bytes instanceof Uint8Array) ||
    candidate.bytes.byteLength === 0 ||
    typeof candidate.sha256 !== "string" ||
    Object.keys(candidate).length !== 4
  ) {
    invalid("EXPORT_IIFE_INVALID");
  }
  const bytes = cloneBytes(candidate.bytes);
  if ((await sha256(bytes)) !== candidate.sha256)
    invalid("EXPORT_IIFE_INVALID");
  let source: string;
  try {
    source = textDecoder.decode(bytes);
    await initializeModuleLexer;
    const [imports, exports] = parseModule(source);
    if (imports.length !== 0 || exports.length !== 0)
      invalid("EXPORT_IIFE_INVALID");
  } catch (error) {
    if (error instanceof ExportError) throw error;
    invalid("EXPORT_IIFE_INVALID");
  }
  return {
    path: IIFE_BUNDLE_PATH,
    bytes,
    sha256: candidate.sha256,
    globalName: IIFE_GLOBAL_NAME,
  };
}

function bundlesAreEqual(
  left: PortableIifeBundle,
  right: PortableIifeBundle,
): boolean {
  return (
    left.path === right.path &&
    left.globalName === right.globalName &&
    left.sha256 === right.sha256 &&
    equalBytes(left.bytes, right.bytes)
  );
}

async function readStableIifeBundle(
  provider: PortableIifeBundleProvider,
  graph: ValidatedGraph,
): Promise<PortableIifeBundle> {
  const provide = async (): Promise<PortableIifeBundle> => {
    let output: unknown;
    try {
      output = await provider.provide(await bundleInputWithHashes(graph));
    } catch {
      invalid("EXPORT_IIFE_PROVIDER_FAILED");
    }
    return validateIifeBundle(output);
  };
  const first = await provide();
  const second = await provide();
  if (!bundlesAreEqual(first, second)) invalid("EXPORT_IIFE_UNSTABLE");
  return first;
}

async function readStableSelfContainedRuntime(
  provider: PortableSelfContainedRuntimeProvider,
): Promise<PortableIifeBundle> {
  const provide = async (): Promise<PortableIifeBundle> => {
    let output: unknown;
    try {
      output = await provider.provide();
    } catch {
      invalid("EXPORT_IIFE_PROVIDER_FAILED");
    }
    return validateIifeBundle(output);
  };
  const first = await provide();
  const second = await provide();
  if (!bundlesAreEqual(first, second)) invalid("EXPORT_IIFE_UNSTABLE");
  return first;
}

export async function buildApprovedWebComponentVirtualMap(
  input: BuildApprovedWebComponentVirtualMapInput,
): Promise<ApprovedWebComponentVirtualExport> {
  const { approval, document, canonicalizationVersion } =
    await revalidateApproval(input.approval);
  const assets = await readVerifiedAssets(approval, input.assets);
  const metadata = browserAssetMetadata(document, approval);
  const runtime = await readStableRuntimeGraph(input.runtimeGraphProvider, [
    "evaluateScene",
    "renderCommands",
  ]);
  rejectReservedProviderPaths(runtime, [
    MANIFEST_PATH,
    DOCUMENT_PATH,
    GENERATED_DOCUMENT_PATH,
    GENERATED_ASSETS_PATH,
    GENERATED_ADAPTER_PATH,
    WEB_COMPONENT_PATH,
  ]);
  const graph = await webComponentGraph(
    approval.canonicalDocumentBytes,
    metadata,
    runtime,
  );
  return finalizeVirtualMap({
    approval,
    document,
    canonicalizationVersion,
    assets,
    graph,
    adapterName: WEB_COMPONENT_ADAPTER_NAME,
  });
}

export async function buildApprovedIifeVirtualMap(
  input: BuildApprovedIifeVirtualMapInput,
): Promise<ApprovedIifeVirtualExport> {
  const { approval, document, canonicalizationVersion } =
    await revalidateApproval(input.approval);
  const assets = await readVerifiedAssets(approval, input.assets);
  const metadata = browserAssetMetadata(document, approval);
  const runtime = await readStableRuntimeGraph(input.runtimeGraphProvider, [
    "evaluateScene",
    "renderCommands",
  ]);
  rejectReservedProviderPaths(runtime, [
    MANIFEST_PATH,
    DOCUMENT_PATH,
    GENERATED_DOCUMENT_PATH,
    GENERATED_ASSETS_PATH,
    GENERATED_ADAPTER_PATH,
    BROWSER_CONTROLLER_PATH,
    IIFE_ENTRY_PATH,
    IIFE_BUNDLE_PATH,
  ]);
  const graph = await browserControllerGraph(
    approval.canonicalDocumentBytes,
    metadata,
    runtime,
    "iife",
  );
  const bundle = await readStableIifeBundle(input.iifeBundleProvider, graph);
  const finalGraph: ValidatedGraph = {
    entryPath: IIFE_BUNDLE_PATH,
    files: new Map([
      ...graph.files.entries(),
      [IIFE_BUNDLE_PATH, cloneBytes(bundle.bytes)],
    ]),
  };
  return finalizeVirtualMap({
    approval,
    document,
    canonicalizationVersion,
    assets,
    graph: finalGraph,
    adapterName: IIFE_ADAPTER_NAME,
  });
}

export async function buildApprovedSelfContainedHtmlVirtualMap(
  input: BuildApprovedSelfContainedHtmlVirtualMapInput,
): Promise<ApprovedSelfContainedHtmlVirtualExport> {
  const { approval, document, canonicalizationVersion } =
    await revalidateApproval(input.approval);
  const assets = await readVerifiedAssets(approval, input.assets);
  const embedded = await embeddedAssetUrls(approval, assets);
  const metadata = browserAssetMetadata(
    document,
    approval,
    embedded.urlsByHash,
  );
  const bundle =
    input.selfContainedRuntimeProvider === undefined
      ? await (async () => {
          const runtime = await readStableRuntimeGraph(
            input.runtimeGraphProvider,
            ["evaluateScene", "renderCommands"],
          );
          rejectReservedProviderPaths(runtime, [
            MANIFEST_PATH,
            DOCUMENT_PATH,
            GENERATED_DOCUMENT_PATH,
            GENERATED_ASSETS_PATH,
            GENERATED_ADAPTER_PATH,
            BROWSER_CONTROLLER_PATH,
            IIFE_ENTRY_PATH,
            IIFE_BUNDLE_PATH,
            HTML_PATH,
          ]);
          const graph = await browserControllerGraph(
            approval.canonicalDocumentBytes,
            metadata,
            runtime,
            "iife",
          );
          return readStableIifeBundle(input.iifeBundleProvider, graph);
        })()
      : await readStableSelfContainedRuntime(
          input.selfContainedRuntimeProvider,
        );
  return finalizeSelfContainedHtmlVirtualExport({
    approval,
    document,
    canonicalizationVersion,
    bundle,
    assets: metadata,
    embeddedAssetBytes: embedded.total,
  });
}
