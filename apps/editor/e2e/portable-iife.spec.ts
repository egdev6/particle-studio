import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import { expect, test, type Page } from "@playwright/test";

import { genuineIifeProvider } from "../../../packages/export/tests/iife-test-support.js";
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
const { buildApprovedIifeVirtualMap } = await import(
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
    documentId: "iife-browser-document",
    revisionId: "iife-browser-revision",
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

async function iifeMap(
  document: SceneDocumentV1,
  assets: readonly ContentAddressedAsset[] = [],
) {
  return buildApprovedIifeVirtualMap({
    approval: await approval(document, assets),
    assets: assetPort(assets),
    runtimeGraphProvider: await buildGenuineCanvasRuntimeProvider(),
    iifeBundleProvider: genuineIifeProvider(),
  });
}

async function serveVirtualMap(
  page: Page,
  prefix: string,
  files: VirtualFileMap,
  options: {
    readonly tamperAsset?: boolean;
    readonly missingAsset?: boolean;
  } = {},
): Promise<string[]> {
  const requests: string[] = [];
  await page.route(`**${prefix}/**`, async (route) => {
    const requestUrl = new URL(route.request().url());
    const path = requestUrl.pathname.slice(prefix.length + 1);
    requests.push(requestUrl.pathname);
    const source = files.get(path);
    if (!source || (options.missingAsset && path.startsWith("assets/"))) {
      return route.fulfill({ status: 404, body: "missing" });
    }
    const bytes = source.slice();
    if (options.tamperAsset && path.startsWith("assets/")) bytes[0] ^= 0xff;
    return route.fulfill({
      status: 200,
      contentType: path.startsWith("assets/") ? "image/png" : "text/javascript",
      body: Buffer.from(bytes),
    });
  });
  return requests;
}

async function loadClassicScript(page: Page, source: string): Promise<void> {
  await page.evaluate(
    (scriptSource) =>
      new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = scriptSource;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("classic script failed"));
        document.head.append(script);
      }),
    source,
  );
}

test("installs the isolated classic API and keeps zero-asset mounts explicit and independent", async ({
  page,
}) => {
  const exported = await iifeMap(structuredClone(FIRST_SLICE_DOCUMENT));
  const requests = await serveVirtualMap(
    page,
    "/portable-iife-zero",
    exported.files,
  );
  await page.goto("/");
  await loadClassicScript(page, "/portable-iife-zero/particle-studio.iife.js");

  const observed = await page.evaluate(async () => {
    const calls: string[] = [];
    const original = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (...args) {
      calls.push(args.join(","));
      return original.apply(this, args);
    };
    const api = (
      globalThis as typeof globalThis & {
        ParticleStudio: { mount(target: Element): unknown };
      }
    ).ParticleStudio;
    const target = document.createElement("div");
    target.append(document.createElement("span"));
    document.body.append(target);
    const first = api.mount(target) as {
      ready: Promise<void>;
      renderAt(timeUs: number): { state: { timeUs: number } };
      destroy(): void;
    };
    const second = api.mount(target) as typeof first;
    const canvasCountBeforeReady = target.querySelectorAll("canvas").length;
    await Promise.all([first.ready, second.ready]);
    const callsBeforeRender = calls.length;
    const firstResult = first.renderAt(0);
    const secondResult = second.renderAt(500_000);
    first.destroy();
    first.destroy();
    const afterDestroy = (() => {
      try {
        first.renderAt(0);
      } catch (error) {
        return (error as Error).message;
      }
    })();
    const secondAfterDestroy = second.renderAt(1_000_000);
    return {
      apiKeys: Object.keys(api),
      apiFrozen: Object.isFrozen(api),
      controllerFrozen: Object.isFrozen(first),
      canvasCountBeforeReady,
      callsBeforeRender,
      calls,
      firstTime: firstResult.state.timeUs,
      secondTime: secondResult.state.timeUs,
      secondAfterDestroy: secondAfterDestroy.state.timeUs,
      afterDestroy,
      remainingCanvases: target.querySelectorAll("canvas").length,
      callerChildRemains: target.querySelectorAll("span").length,
    };
  });

  expect(requests).toEqual(["/portable-iife-zero/particle-studio.iife.js"]);
  expect(observed).toEqual({
    apiKeys: ["mount"],
    apiFrozen: true,
    controllerFrozen: true,
    canvasCountBeforeReady: 2,
    callsBeforeRender: 0,
    calls: ["16,24,120,80", "16,24,120,80", "16,24,120,80"],
    firstTime: 0,
    secondTime: 500_000,
    secondAfterDestroy: 1_000_000,
    afterDestroy: "PARTICLE_STUDIO_DESTROYED",
    remainingCanvases: 1,
    callerChildRemains: 1,
  });
});

test("uses the explicit adjacent asset base, verified bitmap, and genuine Canvas2D draw path", async ({
  page,
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
  const exported = await iifeMap(document, [asset]);
  expect(exported.manifest.embeddedAssetBytes).toBe(0);
  const scriptRequests = await serveVirtualMap(
    page,
    "/portable-iife-script",
    exported.files,
  );
  const assetRequests = await serveVirtualMap(
    page,
    "/portable-iife-assets",
    exported.files,
  );
  await page.goto("/");
  await loadClassicScript(
    page,
    "/portable-iife-script/particle-studio.iife.js",
  );

  const observed = await page.evaluate(async () => {
    const draws: unknown[] = [];
    const closes: number[] = [];
    const drawOriginal = CanvasRenderingContext2D.prototype.drawImage;
    const closeOriginal = ImageBitmap.prototype.close;
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
      return drawOriginal.call(this, source, x, y, width, height);
    };
    ImageBitmap.prototype.close = function () {
      closes.push(1);
      return closeOriginal.call(this);
    };
    const target = document.createElement("div");
    document.body.append(target);
    const controller = (
      globalThis as typeof globalThis & {
        ParticleStudio: {
          mount(
            target: Element,
            options: { assetBaseUrl: string },
          ): {
            ready: Promise<void>;
            renderAt(timeUs: number): {
              state: { timeUs: number };
              commands: { kind: string }[];
            };
            destroy(): void;
          };
        };
      }
    ).ParticleStudio.mount(target, {
      assetBaseUrl: new URL("/portable-iife-assets/", location.href).href,
    });
    await controller.ready;
    const first = controller.renderAt(500_000);
    const second = controller.renderAt(500_000);
    controller.destroy();
    return {
      first: {
        timeUs: first.state.timeUs,
        commands: first.commands.map((command) => command.kind),
      },
      second: {
        timeUs: second.state.timeUs,
        commands: second.commands.map((command) => command.kind),
      },
      draws,
      closes: closes.length,
    };
  });

  expect(scriptRequests).toEqual([
    "/portable-iife-script/particle-studio.iife.js",
  ]);
  expect(assetRequests).toEqual([
    `/portable-iife-assets/assets/${PNG_SHA256.slice(7)}`,
  ]);
  expect(observed).toEqual({
    first: { timeUs: 500_000, commands: ["draw-image"] },
    second: { timeUs: 500_000, commands: ["draw-image"] },
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
    closes: 1,
  });
});

test("rejects non-HTMLElement targets before canvas creation and keeps the installed API usable", async ({
  page,
}) => {
  const exported = await iifeMap(structuredClone(FIRST_SLICE_DOCUMENT));
  await serveVirtualMap(page, "/portable-iife-invalid-target", exported.files);
  await page.goto("/");
  await loadClassicScript(
    page,
    "/portable-iife-invalid-target/particle-studio.iife.js",
  );

  const observed = await page.evaluate(async () => {
    const api = (
      globalThis as typeof globalThis & {
        ParticleStudio: {
          mount(target: HTMLElement): {
            ready: Promise<void>;
            renderAt(timeUs: number): { state: { timeUs: number } };
            destroy(): void;
          };
        };
      }
    ).ParticleStudio;
    const originalCreateElement = document.createElement.bind(document);
    let createdCanvases = 0;
    document.createElement = ((
      tagName: string,
      options?: ElementCreationOptions,
    ) => {
      if (tagName === "canvas") createdCanvases += 1;
      return originalCreateElement(tagName, options);
    }) as typeof document.createElement;
    const errorFor = (target: unknown) => {
      try {
        api.mount(target as HTMLElement);
        return "resolved";
      } catch (error) {
        return (error as Error).message;
      }
    };
    const canvasCountBeforeInvalidTargets =
      document.querySelectorAll("canvas").length;
    const errors = [
      errorFor(null),
      errorFor(document.createElementNS("http://www.w3.org/2000/svg", "svg")),
    ];
    const canvasCountAfterInvalidTargets =
      document.querySelectorAll("canvas").length;
    document.createElement = originalCreateElement;
    const target = document.createElement("div");
    document.body.append(target);
    const controller = api.mount(target);
    await controller.ready;
    const validTimeUs = controller.renderAt(0).state.timeUs;
    controller.destroy();
    return {
      errors,
      createdCanvases,
      canvasCountBeforeInvalidTargets,
      canvasCountAfterInvalidTargets,
      validTimeUs,
    };
  });

  expect(observed).toEqual({
    errors: [
      "PARTICLE_STUDIO_TARGET_INVALID",
      "PARTICLE_STUDIO_TARGET_INVALID",
    ],
    createdCanvases: 0,
    canvasCountBeforeInvalidTargets: 1,
    canvasCountAfterInvalidTargets: 1,
    validTimeUs: 0,
  });
});

test("rejects missing and tampered adjacent assets without drawing", async ({
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
  const exported = await iifeMap(document, [asset]);

  const good = await browser.newPage();
  const defaultRequests = await serveVirtualMap(
    good,
    "/portable-iife-default",
    exported.files,
  );
  await good.goto("/");
  await loadClassicScript(
    good,
    "/portable-iife-default/particle-studio.iife.js",
  );
  const defaultBaseResult = await good.evaluate(async () => {
    let draws = 0;
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      draws += 1;
      return original.apply(this, args);
    };
    const controller = (
      globalThis as typeof globalThis & {
        ParticleStudio: {
          mount(target: HTMLElement): {
            ready: Promise<void>;
            renderAt(timeUs: number): { commands: { kind: string }[] };
            destroy(): void;
          };
        };
      }
    ).ParticleStudio.mount(document.body);
    await controller.ready;
    const rendered = controller.renderAt(0);
    controller.destroy();
    return {
      commands: rendered.commands.map((command) => command.kind),
      draws,
    };
  });
  expect(defaultRequests).toEqual([
    "/portable-iife-default/particle-studio.iife.js",
    `/portable-iife-default/assets/${PNG_SHA256.slice(7)}`,
  ]);
  expect(defaultBaseResult).toEqual({ commands: ["draw-image"], draws: 1 });
  await good.close();

  const run = async (
    prefix: string,
    options: {
      readonly tamperAsset?: boolean;
      readonly missingAsset?: boolean;
    },
  ) => {
    const page = await browser.newPage();
    await serveVirtualMap(page, prefix, exported.files, options);
    await page.goto("/");
    await loadClassicScript(page, `${prefix}/particle-studio.iife.js`);
    const result = await page.evaluate(async () => {
      let draws = 0;
      const original = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        draws += 1;
        return original.apply(this, args);
      };
      const controller = (
        globalThis as typeof globalThis & {
          ParticleStudio: { mount(target: Element): { ready: Promise<void> } };
        }
      ).ParticleStudio.mount(document.body);
      return {
        ready: await controller.ready.then(
          () => "resolved",
          (error: Error) => error.message,
        ),
        draws,
      };
    });
    await page.close();
    return result;
  };

  await expect(
    run("/portable-iife-missing", { missingAsset: true }),
  ).resolves.toEqual({
    ready: "PARTICLE_STUDIO_ASSET_RESPONSE_INVALID",
    draws: 0,
  });
  await expect(
    run("/portable-iife-tampered", { tamperAsset: true }),
  ).resolves.toEqual({
    ready: "PARTICLE_STUDIO_ASSET_HASH_MISMATCH",
    draws: 0,
  });
});

test("destroys held asset loads once and suppresses late completion", async ({
  page,
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
  const exported = await iifeMap(document, [asset]);
  const prefix = "/portable-iife-delayed";
  const expectedAssetPath = `/portable-iife-delayed/assets/${PNG_SHA256.slice(7)}`;
  const requests: string[] = [];
  let requestedAssetUrl: string | undefined;
  let releaseRoute!: () => void;
  let enteredRoute!: () => void;
  let completedRoute!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseRoute = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enteredRoute = resolve;
  });
  const completed = new Promise<void>((resolve) => {
    completedRoute = resolve;
  });
  let fulfillment:
    | { readonly outcome: "fulfilled" }
    | { readonly outcome: "rejected"; readonly message: string }
    | undefined;

  await page.goto("/");
  const expectedAssetUrl = new URL(expectedAssetPath, page.url()).href;
  await page.route(`**${prefix}/**`, async (route) => {
    const requestUrl = new URL(route.request().url());
    const path = requestUrl.pathname.slice(prefix.length + 1);
    requests.push(requestUrl.pathname);
    const source = exported.files.get(path);
    if (!source) return route.fulfill({ status: 404, body: "missing" });
    const response = {
      status: 200,
      contentType: path.startsWith("assets/") ? "image/png" : "text/javascript",
      body: Buffer.from(source.slice()),
    };
    if (requestUrl.href !== expectedAssetUrl) return route.fulfill(response);

    requestedAssetUrl = requestUrl.href;
    enteredRoute();
    await release;
    try {
      await route.fulfill(response);
      fulfillment = { outcome: "fulfilled" };
    } catch (error) {
      fulfillment = {
        outcome: "rejected",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      completedRoute();
    }
  });
  await loadClassicScript(page, `${prefix}/particle-studio.iife.js`);

  await page.evaluate(() => {
    let draws = 0;
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      draws += 1;
      return original.apply(this, args);
    };
    const target = document.createElement("div");
    document.body.append(target);
    const controller = (
      globalThis as typeof globalThis & {
        ParticleStudio: {
          mount(target: Element): {
            ready: Promise<void>;
            renderAt(timeUs: number): unknown;
            destroy(): void;
          };
        };
      }
    ).ParticleStudio.mount(target);
    const beforeReady = (() => {
      try {
        controller.renderAt(0);
      } catch (error) {
        return (error as Error).message;
      }
    })();
    (
      globalThis as typeof globalThis & {
        particleStudioDestroyDuringLoad?: {
          readonly beforeReady: string | undefined;
          readonly controller: typeof controller;
          readonly draws: () => number;
          readonly ready: Promise<string>;
          readonly target: HTMLDivElement;
        };
      }
    ).particleStudioDestroyDuringLoad = {
      beforeReady,
      controller,
      draws: () => draws,
      ready: controller.ready.then(
        () => "resolved",
        (error: Error) => error.message,
      ),
      target,
    };
  });

  await entered;
  await page.evaluate(() => {
    const state = (
      globalThis as typeof globalThis & {
        particleStudioDestroyDuringLoad: {
          controller: { destroy(): void };
        };
      }
    ).particleStudioDestroyDuringLoad;
    state.controller.destroy();
    state.controller.destroy();
  });
  releaseRoute();
  await completed;

  const observed = await page.evaluate(async () => {
    const state = (
      globalThis as typeof globalThis & {
        particleStudioDestroyDuringLoad: {
          readonly beforeReady: string | undefined;
          readonly controller: { renderAt(timeUs: number): unknown };
          readonly draws: () => number;
          readonly ready: Promise<string>;
          readonly target: HTMLDivElement;
        };
      }
    ).particleStudioDestroyDuringLoad;
    const render = (() => {
      try {
        state.controller.renderAt(0);
      } catch (error) {
        return (error as Error).message;
      }
    })();
    return {
      beforeReady: state.beforeReady,
      ready: await state.ready,
      render,
      draws: state.draws(),
      canvasCount: state.target.querySelectorAll("canvas").length,
    };
  });

  expect(requests).toEqual([
    "/portable-iife-delayed/particle-studio.iife.js",
    expectedAssetPath,
  ]);
  expect(requestedAssetUrl).toBe(expectedAssetUrl);
  expect(fulfillment).toEqual({ outcome: "fulfilled" });
  expect(observed).toEqual({
    beforeReady: "PARTICLE_STUDIO_NOT_READY",
    ready: "PARTICLE_STUDIO_DESTROYED",
    render: "PARTICLE_STUDIO_DESTROYED",
    draws: 0,
    canvasCount: 0,
  });
});

test("preserves defined, own-undefined, and inherited-undefined ParticleStudio collisions", async ({
  browser,
}) => {
  const exported = await iifeMap(structuredClone(FIRST_SLICE_DOCUMENT));
  const run = async (
    mode: "defined" | "own-undefined" | "inherited-undefined",
  ) => {
    const page = await browser.newPage();
    const prefix = `/portable-iife-${mode}`;
    await serveVirtualMap(page, prefix, exported.files);
    await page.goto("/");
    const result = await page.evaluate(
      async ({ mode, source }) => {
        const before = Object.keys(globalThis).sort();
        const prior =
          mode === "defined" ? Object.freeze({ prior: true }) : undefined;
        if (mode === "inherited-undefined") {
          Object.defineProperty(
            Object.getPrototypeOf(globalThis),
            "ParticleStudio",
            { value: prior, configurable: true },
          );
        } else {
          Object.defineProperty(globalThis, "ParticleStudio", {
            value: prior,
            configurable: true,
          });
        }
        let error = "";
        window.addEventListener(
          "error",
          (event) => {
            error = event.message;
          },
          { once: true },
        );
        const loaded = await new Promise<boolean>((resolve) => {
          const script = document.createElement("script");
          script.src = source;
          script.onload = () => resolve(true);
          script.onerror = () => resolve(false);
          document.head.append(script);
        });
        return {
          loaded,
          error,
          own: Object.hasOwn(globalThis, "ParticleStudio"),
          valuePreserved: globalThis.ParticleStudio === prior,
          added: Object.keys(globalThis)
            .filter((key) => !before.includes(key))
            .sort(),
        };
      },
      { mode, source: `${prefix}/particle-studio.iife.js` },
    );
    await page.close();
    return result;
  };

  await expect(run("defined")).resolves.toEqual({
    loaded: true,
    error: "Uncaught Error: PARTICLE_STUDIO_GLOBAL_COLLISION",
    own: true,
    valuePreserved: true,
    added: [],
  });
  await expect(run("own-undefined")).resolves.toEqual({
    loaded: true,
    error: "Uncaught Error: PARTICLE_STUDIO_GLOBAL_COLLISION",
    own: true,
    valuePreserved: true,
    added: [],
  });
  await expect(run("inherited-undefined")).resolves.toEqual({
    loaded: true,
    error: "Uncaught Error: PARTICLE_STUDIO_GLOBAL_COLLISION",
    own: false,
    valuePreserved: true,
    added: [],
  });
});
