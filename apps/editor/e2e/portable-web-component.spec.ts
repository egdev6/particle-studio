import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import { expect, test, type Page } from "@playwright/test";

import { buildGenuineCanvasRuntimeProvider } from "../../../packages/export/tests/web-component-test-support.js";

import type { SceneDocumentV1 } from "@particle-studio/scene-document";
import type {
  ApprovalRecord,
  ContentAddressedAsset,
} from "@particle-studio/persistence";
import type { VirtualFileMap } from "../../../packages/export/src/index.js";

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
const { buildApprovedWebComponentVirtualMap } = await import(
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
    documentId: "browser-document",
    revisionId: "browser-revision",
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

async function componentMap(
  document: SceneDocumentV1,
  assets: readonly ContentAddressedAsset[] = [],
) {
  return buildApprovedWebComponentVirtualMap({
    approval: await approval(document, assets),
    assets: assetPort(assets),
    runtimeGraphProvider: await buildGenuineCanvasRuntimeProvider(),
  });
}

async function serveVirtualMap(
  page: Page,
  prefix: string,
  files: VirtualFileMap,
  tamperAsset = false,
  delayAssetMs = 0,
) {
  await page.route(`**${prefix}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.slice(
      prefix.length + 1,
    );
    const source = files.get(path);
    if (!source) return route.fulfill({ status: 404, body: "missing" });
    const bytes = source.slice();
    if (delayAssetMs > 0 && path.startsWith("assets/")) {
      await new Promise((resolve) => setTimeout(resolve, delayAssetMs));
    }
    if (tamperAsset && path.startsWith("assets/")) bytes[0] ^= 0xff;
    return route.fulfill({
      status: 200,
      contentType: path.startsWith("assets/") ? "image/png" : "text/javascript",
      body: Buffer.from(bytes),
    });
  });
}

test("loads the zero-asset component and renders only at explicit fixed times", async ({
  page,
}) => {
  const exported = await componentMap(structuredClone(FIRST_SLICE_DOCUMENT));
  await serveVirtualMap(page, "/portable-zero", exported.files);
  await page.goto("/");

  const observed = await page.evaluate(async () => {
    const calls: string[] = [];
    const original = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (...args) {
      calls.push(args.join(","));
      return original.apply(this, args);
    };
    await import("/portable-zero/web-component.js");
    const scene = document.createElement(
      "particle-studio-scene",
    ) as HTMLElement & {
      ready: Promise<void>;
      renderAt(timeUs: number): {
        state: { timeUs: number };
        commands: { kind: string }[];
      };
      timeUs: number;
    };
    document.body.append(scene);
    await scene.ready;
    const first = scene.renderAt(0);
    scene.timeUs = 500_000;
    const canvas = scene.shadowRoot?.querySelector("canvas");
    return {
      tag: scene.tagName.toLowerCase(),
      first: {
        timeUs: first.state.timeUs,
        commands: first.commands.map((command) => command.kind),
      },
      calls,
      canvas: {
        label: canvas?.getAttribute("aria-label"),
        width: canvas?.width,
        height: canvas?.height,
      },
    };
  });

  expect(observed).toEqual({
    tag: "particle-studio-scene",
    first: { timeUs: 0, commands: ["draw-shape"] },
    calls: ["16,24,120,80", "16,24,120,80"],
    canvas: { label: "Particle Studio scene", width: 136, height: 104 },
  });
});

test("verifies one adjacent image before real renderer drawing and fails closed on tampering", async ({
  browser,
}) => {
  const asset = createContentAddressedAsset({
    sha256: PNG_SHA256,
    mimeType: "image/png",
    byteLength: PNG.byteLength,
    bytes: new Uint8Array(PNG),
  });
  const document = {
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
  const exported = await componentMap(document, [asset]);

  const good = await browser.newPage();
  await serveVirtualMap(good, "/portable-image", exported.files);
  await good.goto("/");
  const result = await good.evaluate(async () => {
    const calls: unknown[] = [];
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (
      source,
      x,
      y,
      width,
      height,
    ) {
      calls.push({
        source: source.constructor.name,
        width: (source as ImageBitmap).width,
        height: (source as ImageBitmap).height,
        x,
        y,
        drawWidth: width,
        drawHeight: height,
      });
      return original.call(this, source, x, y, width, height);
    };
    await import("/portable-image/web-component.js");
    const scene = document.createElement(
      "particle-studio-scene",
    ) as HTMLElement & {
      ready: Promise<void>;
      renderAt(timeUs: number): {
        state: { timeUs: number };
        commands: { kind: string; resolved?: unknown }[];
      };
    };
    document.body.append(scene);
    await scene.ready;
    const rendered = scene.renderAt(500_000);
    return {
      timeUs: rendered.state.timeUs,
      commands: rendered.commands.map(({ kind }) => kind),
      calls,
    };
  });
  expect(result).toEqual({
    timeUs: 500_000,
    commands: ["draw-image"],
    calls: [
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
  await good.close();

  const bad = await browser.newPage();
  await serveVirtualMap(bad, "/portable-tampered", exported.files, true);
  await bad.goto("/");
  const failure = await bad.evaluate(async () => {
    let drawCalls = 0;
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      drawCalls += 1;
      return original.apply(this, args);
    };
    await import("/portable-tampered/web-component.js");
    const scene = document.createElement(
      "particle-studio-scene",
    ) as HTMLElement & { ready: Promise<void> };
    const error = new Promise<unknown>((resolve) =>
      scene.addEventListener(
        "particle-studio-error",
        (event) => resolve((event as CustomEvent).detail),
        { once: true },
      ),
    );
    document.body.append(scene);
    const ready = await scene.ready.then(
      () => "resolved",
      (reason: Error) => reason.message,
    );
    return { ready, error: await error, drawCalls };
  });
  expect(failure).toEqual({
    ready: "WEB_COMPONENT_ASSET_HASH_MISMATCH",
    error: { code: "WEB_COMPONENT_ASSET_HASH_MISMATCH" },
    drawCalls: 0,
  });
  await bad.close();

  const disconnected = await browser.newPage();
  await serveVirtualMap(
    disconnected,
    "/portable-disconnect",
    exported.files,
    false,
    50,
  );
  await disconnected.goto("/");
  const cleanup = await disconnected.evaluate(async () => {
    let drawCalls = 0;
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      drawCalls += 1;
      return original.apply(this, args);
    };
    await import("/portable-disconnect/web-component.js");
    const scene = document.createElement(
      "particle-studio-scene",
    ) as HTMLElement & {
      ready: Promise<void>;
      renderAt(timeUs: number): unknown;
    };
    document.body.append(scene);
    scene.remove();
    const ready = await scene.ready.then(
      () => "resolved",
      (reason: Error) => reason.message,
    );
    let render = "resolved";
    try {
      scene.renderAt(0);
    } catch (reason) {
      render = (reason as Error).message;
    }
    return { ready, render, drawCalls };
  });
  expect(cleanup).toEqual({
    ready: "WEB_COMPONENT_DISCONNECTED",
    render: "WEB_COMPONENT_NOT_READY",
    drawCalls: 0,
  });
  await disconnected.close();
});

test("defers asset loading until connection and renews aborted lifecycle state on reconnect", async ({
  browser,
}) => {
  const asset = createContentAddressedAsset({
    sha256: PNG_SHA256,
    mimeType: "image/png",
    byteLength: PNG.byteLength,
    bytes: new Uint8Array(PNG),
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
  const exported = await componentMap(document, [asset]);
  expect(exported.manifest.embeddedAssetBytes).toBe(0);

  const page = await browser.newPage();
  await serveVirtualMap(page, "/portable-reconnect", exported.files, false, 50);
  await page.goto("/");
  const lifecycle = await page.evaluate(async () => {
    let fetches = 0;
    let drawCalls = 0;
    const errors: unknown[] = [];
    const fetchOriginal = window.fetch;
    const drawOriginal = CanvasRenderingContext2D.prototype.drawImage;
    window.fetch = (...args) => {
      fetches += 1;
      return fetchOriginal(...args);
    };
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      drawCalls += 1;
      return drawOriginal.apply(this, args);
    };
    await import("/portable-reconnect/web-component.js");
    const scene = document.createElement(
      "particle-studio-scene",
    ) as HTMLElement & {
      ready: Promise<void>;
      renderAt(timeUs: number): { state: { timeUs: number } };
      timeUs: number;
    };
    scene.timeUs = 500_000;
    scene.addEventListener("particle-studio-error", (event) =>
      errors.push((event as CustomEvent).detail),
    );
    const beforeAppend = fetches;
    const initialReady = scene.ready;
    document.body.append(scene);
    scene.remove();
    const initialOutcome = await initialReady.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    const beforeReconnect = fetches;
    document.body.append(scene);
    const reconnectReady = scene.ready;
    const distinctReady = reconnectReady !== initialReady;
    await reconnectReady;
    const rendered = scene.renderAt(0);
    return {
      beforeAppend,
      beforeReconnect,
      fetches,
      initialOutcome,
      distinctReady,
      errors,
      drawCalls,
      timeUs: rendered.state.timeUs,
    };
  });

  expect(lifecycle).toEqual({
    beforeAppend: 0,
    beforeReconnect: 1,
    fetches: 2,
    initialOutcome: "WEB_COMPONENT_DISCONNECTED",
    distinctReady: true,
    errors: [],
    drawCalls: 2,
    timeUs: 0,
  });
  await page.close();
});
