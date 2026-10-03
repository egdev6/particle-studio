/// <reference types="node" />
import { Buffer } from "node:buffer";
import { expect, test, type Page } from "@playwright/test";
import type { SceneDocumentV1 } from "@particle-studio/scene-document";
import { BROWSER_DOCUMENT, nativeRows } from "../raw-indexeddb-seed.js";

const bytes = Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
const hash = "sha256:431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460";
const asset = { sha256: hash, mimeType: "image/png", byteLength: bytes.length, bytes };
const placement = { x: 180, y: 24, width: 8, height: 8 };
const scene = (): SceneDocumentV1 => ({ schemaVersion: 1, durationUs: 1_000_000, seed: 42, loop: true,
  playbackRange: { startUs: 500_000, endUs: 1_000_000 }, rootIds: ["shape"],
  elements: [{ id: "shape", type: "shape", x: 16, y: 24, width: 120, height: 80, opacity: 1 }],
  tracks: [{ elementId: "shape", property: "opacity", interpolation: "linear", easing: "linear",
    keyframes: [{ timeUs: 0, value: 0.25 }, { timeUs: 1_000_000, value: 0.75 }] }] });
function revision(document: SceneDocumentV1, revisionId: string, sequence: number) {
  const json = JSON.stringify(document, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  const canonicalBytes = Array.from(new TextEncoder().encode(json));
  return { documentId: BROWSER_DOCUMENT, revisionId, sequence, document, canonicalBytes,
    canonicalization: { identifier: "jcs-1", byteLength: canonicalBytes.length } };
}
function orderedRevisionRows(rows: Awaited<ReturnType<typeof nativeRows>>) {
  const revisions = (rows.revisions as ReturnType<typeof revision>[]).slice().sort((left, right) => {
    if (left.documentId !== right.documentId) return left.documentId < right.documentId ? -1 : 1;
    return left.revisionId < right.revisionId ? -1 : left.revisionId > right.revisionId ? 1 : 0;
  });
  return { ...rows, revisions };
}
const pointer = (revisionId: string, sequence: number, kind = "draft") => ({ kind, documentId: BROWSER_DOCUMENT, revisionId, sequence });
const pngButton = (page: Page) => page.getByRole("button", { name: "Import PNG", exact: true });
const jsonButton = (page: Page) => page.getByRole("button", { name: "Import editable JSON" });
const createButton = (page: Page) => page.getByRole("button", { name: "Create blank scene", exact: true });
const blankScene = (): SceneDocumentV1 => ({ schemaVersion: 1, durationUs: 1_000_000,
  playbackRange: { startUs: 0, endUs: 1_000_000 }, loop: true, seed: 42,
  tracks: [], rootIds: ["root"], elements: [{ id: "root", type: "group", childrenIds: [] }] });
async function blankAlpha(page: Page) {
  return page.locator("#scene").evaluate((canvas: HTMLCanvasElement) =>
    Array.from(canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data)
      .filter((_value, index) => index % 4 === 3));
}
async function createBlank(page: Page) {
  await createButton(page).click();
  await expect(page.locator("#status")).toContainText("Rendered imported draft at 0 µs.");
}
// Blank creation has no image hash/decode. Gate the actual native preparation read,
// after its result was captured, without keeping a write transaction alive.
async function holdCreation(page: Page, reject = false) {
  await page.addInitScript((reject) => {
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      const request = get.call(this, key);
      const root = document.documentElement;
      if (this.name !== "pointers" || this.transaction.mode !== "readonly" || root.dataset.hold !== "yes") return request;
      root.dataset.hold = "consumed";
      const intercept = (event: Event) => {
        event.stopImmediatePropagation(); request.removeEventListener("success", intercept, true);
        root.dataset.creation = "pending";
        void (async () => {
          while (root.dataset.settle !== "yes") await new Promise((resolve) => setTimeout(resolve, 10));
          if (reject) Object.defineProperty(request, "error", { value: new DOMException("Preparation fault", "UnknownError") });
          request.dispatchEvent(new Event(reject ? "error" : "success", { cancelable: true }));
          setTimeout(() => { root.dataset.creation = "settled"; }, 0);
        })();
      };
      request.addEventListener("success", intercept, true);
      return request;
    };
  }, reject);
}
async function frame(page: Page) {
  return page.locator("#scene").evaluate((canvas: HTMLCanvasElement) =>
    [60, 181, 188, 240].map((x) => Array.from(canvas.getContext("2d")!.getImageData(x, 25, 1, 1).data)));
}
async function publishJson(page: Page, document = scene()) {
  await page.getByLabel("Editable JSON", { exact: true }).fill(JSON.stringify(document));
  await jsonButton(page).click();
  await expect(page.locator("#status")).toHaveText("Import complete. Rendered imported draft at 500000 µs.");
}
async function open(page: Page) {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("Rendered unpersisted sample at 0 µs.");
}
async function select(page: Page, mimeType = "image/png", input = bytes) {
  await page.getByLabel("PNG file", { exact: true }).setInputFiles({ name: "selected.png", mimeType, buffer: Buffer.from(input) });
}
async function place(page: Page) {
  for (const [key, value] of Object.entries(placement)) await page.getByLabel(`PNG ${key}`, { exact: true }).fill(String(value));
}
async function holdDecode(page: Page, reject = false) {
  await page.addInitScript((reject) => {
    const decode = globalThis.createImageBitmap;
    const identities = new Set<ImageBitmap>();
    const lifetimes: { id: number; closes: number }[] = [];
    globalThis.createImageBitmap = async (image: ImageBitmapSource) => {
      const bitmap = await decode(image);
      if (identities.has(bitmap)) throw new Error("Native decoder reused a bitmap identity");
      identities.add(bitmap);
      const lifetime = { id: lifetimes.length + 1, closes: 0 };
      lifetimes.push(lifetime);
      const root = document.documentElement;
      const record = () => { root.dataset.bitmaps = JSON.stringify(lifetimes); };
      record();
      const close = bitmap.close.bind(bitmap);
      bitmap.close = () => { close(); lifetime.closes += 1; record(); };
      if (root.dataset.hold !== "yes") return bitmap;
      root.dataset.decode = "pending";
      while (root.dataset.settle !== "yes") await new Promise((resolve) => setTimeout(resolve, 10));
      if (reject) { bitmap.close(); throw new Error("Injected PNG decode rejection"); }
      return bitmap;
    };
  }, reject);
}
const hold = (page: Page) => page.locator("html").evaluate((root) => { (root as HTMLElement).dataset.hold = "yes"; });
const settle = (page: Page) => page.locator("html").evaluate((root) => { (root as HTMLElement).dataset.settle = "yes"; });

for (const saved of [false, true]) {
  test(`explicit blank creation is canonical, durable and PNG-usable (saved-only=${saved})`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await holdDecode(page); await open(page);
    if (saved) {
      const row = revision(scene(), "saved-41", 41);
      await nativeRows(page, { revisions: [row], assets: [asset], pointers: [{ documentId: BROWSER_DOCUMENT,
        saved: pointer(row.revisionId, 41, "saved"), draft: null }] });
      await page.reload(); await expect(page.locator("#status")).toContainText("unpersisted sample");
    }
    const before = await nativeRows(page);
    if (!saved) expect(Object.values(before).every((rows) => Array.isArray(rows) && rows.length === 0)).toBe(true);
    await expect(createButton(page)).toBeEnabled();
    expect(await createButton(page).evaluate((button) => button.closest("form"))).toBeNull();
    await page.getByLabel("Editable JSON", { exact: true }).fill("not JSON");
    await createBlank(page);
    const rows = await nativeRows(page);
    const sequence = saved ? 42 : 1;
    const row = (rows.revisions as ReturnType<typeof revision>[]).find((row) => row.sequence === sequence)!;
    expect(row.revisionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(row).toEqual(revision(blankScene(), row.revisionId, sequence));
    expect(orderedRevisionRows(rows)).toEqual(orderedRevisionRows({ ...before, revisions: [...before.revisions as unknown[], row],
      pointers: [{ documentId: BROWSER_DOCUMENT, saved: saved ? pointer("saved-41", 41, "saved") : null,
        draft: pointer(row.revisionId, sequence) }] }));
    expect((await blankAlpha(page)).every((alpha) => alpha === 0)).toBe(true);
    expect(await page.locator("html").getAttribute("data-bitmaps")).toBeNull();
    await expect(createButton(page)).toBeDisabled();
    await createButton(page).dispatchEvent("click"); expect(await nativeRows(page)).toEqual(rows);
    await page.reload(); await expect(page.locator("#status")).toHaveText("Rendered restored draft at 0 µs.");
    expect(await nativeRows(page)).toEqual(rows);
    expect((await blankAlpha(page)).every((alpha) => alpha === 0)).toBe(true);
    await expect(createButton(page)).toBeDisabled();
    await select(page); await place(page); await pngButton(page).click();
    await expect(page.locator("#png-status")).toContainText("PNG import complete");
    const after = await nativeRows(page);
    const next = (after.revisions as ReturnType<typeof revision>[]).find((candidate) => candidate.sequence === sequence + 1)!;
    const id = next.document.elements.at(-1)!.id; expect(id).toMatch(/^image-[a-f0-9-]{36}$/);
    const document = blankScene(); document.rootIds.push(id);
    document.elements.push({ id, type: "image", ...placement, opacity: 1,
      asset: { sha256: hash, mimeType: "image/png", byteLength: bytes.length, intrinsicWidth: 1, intrinsicHeight: 1 } });
    expect(orderedRevisionRows(after)).toEqual(orderedRevisionRows({ ...rows, revisions: [...rows.revisions as unknown[], next], assets: [asset],
      pointers: [{ documentId: BROWSER_DOCUMENT, saved: saved ? pointer("saved-41", 41, "saved") : null,
        draft: pointer(next.revisionId, sequence + 1) }] }));
    expect(next).toEqual(revision(document, next.revisionId, sequence + 1));
    expect(await frame(page)).toEqual([[0, 0, 0, 0], [0, 0, 0, 255], [0, 0, 0, 0], [0, 0, 0, 0]]);
    expect(errors).toEqual([]);
  });
}

for (const during of [false, true]) {
  test(`external winner survives blank creation with no retry/rebase (during preparation=${during})`, async ({ page, context }) => {
    await holdCreation(page); await open(page);
    const previousFrame = await frame(page);
    const other = await context.newPage(); await open(other);
    if (during) {
      await hold(page); await createButton(page).click();
      await expect(page.locator("html")).toHaveAttribute("data-creation", "pending");
      await expect(createButton(page)).toBeDisabled(); await expect(jsonButton(page)).toBeDisabled();
    }
    await publishJson(other); const winner = await nativeRows(other);
    if (during) await settle(page); else await createButton(page).click();
    await expect(page.locator("#status")).toContainText("refresh");
    expect(await nativeRows(page)).toEqual(winner); expect(await frame(page)).toEqual(previousFrame);
    await expect(pngButton(page)).toBeDisabled();
    await createButton(page).click(); await expect(page.locator("#status")).toContainText("refresh");
    expect(await nativeRows(page)).toEqual(winner); expect(await frame(page)).toEqual(previousFrame);
    await other.close();
  });
}

for (const dispose of [false, true]) for (const reject of [false, true]) {
  test(`blank preparation preserves local state through owned settlement (pagehide=${dispose}, reject=${reject})`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await holdCreation(page, reject); await holdDecode(page); await open(page);
    const before = await nativeRows(page); const previousFrame = await frame(page);
    await hold(page); await createButton(page).click();
    await expect(page.locator("html")).toHaveAttribute("data-creation", "pending");
    await expect(jsonButton(page)).toBeDisabled(); await expect(pngButton(page)).toBeDisabled();
    await createButton(page).dispatchEvent("click");
    await page.locator("#json-import").dispatchEvent("submit");
    expect(await nativeRows(page)).toEqual(before); expect(await frame(page)).toEqual(previousFrame);
    if (dispose) await page.evaluate(() => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pagehide")); });
    const markup = () => page.locator("body").evaluate(() => ["#json-import", "#png-import", "#status", "#png-status"]
      .map((selector) => document.querySelector(selector)!.outerHTML).concat(
        Array.from(document.querySelectorAll("button")).filter((button) => button.textContent === "Create blank scene").map((button) => button.outerHTML)));
    const disposedMarkup = await markup(); await settle(page);
    await expect(page.locator("html")).toHaveAttribute("data-creation", "settled");
    if (reject) {
      if (!dispose) await expect(page.locator("#status")).toContainText("try again");
      expect(await nativeRows(page)).toEqual(before); expect(await frame(page)).toEqual(previousFrame);
    } else {
      await expect.poll(async () => (await nativeRows(page)).revisions).toHaveLength(1);
      const after = await nativeRows(page); const row = (after.revisions as ReturnType<typeof revision>[])[0]!;
      expect(after).toEqual({ ...before, revisions: [revision(blankScene(), row.revisionId, 1)],
        pointers: [{ documentId: BROWSER_DOCUMENT, saved: null, draft: pointer(row.revisionId, 1) }] });
      if (!dispose) await expect(page.locator("#status")).toContainText("Rendered imported draft at 0 µs.");
    }
    if (dispose) {
      await createButton(page).dispatchEvent("click"); await page.locator("#json-import").dispatchEvent("submit");
      expect(await markup()).toEqual(disposedMarkup); expect(await frame(page)).toEqual(previousFrame);
      await expect(createButton(page)).toBeDisabled(); await expect(page.locator("#json-import")).toHaveAttribute("aria-busy", "true");
    }
    expect(await page.locator("html").getAttribute("data-bitmaps")).toBeNull(); expect(errors).toEqual([]);
  });
}

for (const saved of [false, true]) {
  test(`PNG requires user JSON, never seeds the sample (saved-only=${saved})`, async ({ page }) => {
    await open(page);
    if (saved) {
      const row = revision(scene(), "saved-41", 41);
      await nativeRows(page, { revisions: [row], pointers: [{ documentId: BROWSER_DOCUMENT,
        saved: pointer(row.revisionId, 41, "saved"), draft: null }] });
      await page.reload();
      await expect(page.locator("#status")).toContainText("unpersisted sample");
    }
    const before = await nativeRows(page);
    await expect(pngButton(page)).toBeDisabled();
    await expect(page.locator("#png-status")).toContainText("Create a scene or import JSON");
    await expect(jsonButton(page)).toBeEnabled();
    await page.locator("#png-import").evaluate((form) => form.dispatchEvent(new Event("submit", { cancelable: true })));
    expect(await nativeRows(page)).toEqual(before);
    await publishJson(page); // No file required; genuine publication makes PNG available.
    await expect(pngButton(page)).toBeEnabled();
    const rows = await nativeRows(page);
    expect(rows.assets).toEqual([]);
    expect(rows.revisions).toHaveLength(saved ? 2 : 1);
  });
}

test("real selected PNG captures placement, identity/metadata/pixels and restores after refresh", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await holdDecode(page); await open(page); await publishJson(page);
  const source = (await nativeRows(page)).revisions as ReturnType<typeof revision>[];
  for (const [key, value] of Object.entries({ x: 0, y: 0, width: 64, height: 64 })) {
    await expect(page.getByLabel(`PNG ${key}`, { exact: true })).toHaveValue(String(value));
  }
  await page.getByLabel("Editable JSON", { exact: true }).fill(""); // PNG needs no JSON text.
  await select(page); await place(page); await hold(page); await pngButton(page).click();
  await expect(page.locator("html")).toHaveAttribute("data-decode", "pending");
  await expect(pngButton(page)).toBeDisabled(); await expect(jsonButton(page)).toBeDisabled();
  await select(page, "image/png", [1, 2, 3]);
  await page.locator("#png-x").evaluate((input: HTMLInputElement) => { input.value = "220"; });
  await page.locator("#json-import").evaluate((form) => form.dispatchEvent(new Event("submit", { cancelable: true })));
  await settle(page);
  await expect(page.getByRole("status", { name: "PNG import status", exact: true })).toBeVisible();
  await expect(page.locator("#png-status")).toContainText("PNG import complete");
  await expect(page.locator("#status")).toHaveText("Rendered imported draft at 500000 µs.");
  await expect(page.locator("html")).toHaveAttribute("data-bitmaps", JSON.stringify([{ id: 1, closes: 0 }, { id: 2, closes: 1 }]));
  const rows = await nativeRows(page);
  const next = (rows.revisions as ReturnType<typeof revision>[]).find((row) => row.revisionId !== source[0]!.revisionId)!;
  const element = next.document.elements.at(-1)!;
  expect(element.id).toMatch(/^image-[a-f0-9-]{36}$/);
  expect(next.revisionId).toMatch(/^[a-f0-9-]{36}$/);
  const document = scene();
  document.elements.push({ id: element.id, type: "image", ...placement, opacity: 1,
    asset: { sha256: hash, mimeType: "image/png", byteLength: bytes.length, intrinsicWidth: 1, intrinsicHeight: 1 } });
  document.rootIds.push(element.id);
  expect(rows.revisions).toHaveLength(2);
  expect(rows.revisions).toContainEqual(revision(scene(), source[0]!.revisionId, 1));
  expect(next).toEqual(revision(document, next.revisionId, 2));
  expect(rows.pointers).toEqual([{ documentId: BROWSER_DOCUMENT, saved: null, draft: pointer(next.revisionId, 2) }]);
  expect(rows.assets).toEqual([asset]);
  expect(rows.autosaves).toEqual([]); expect(rows.approvals).toEqual([]);
  expect(await frame(page)).toEqual([[0, 0, 0, 128], [0, 0, 0, 255], [0, 0, 0, 0], [0, 0, 0, 0]]);
  await page.reload();
  await expect(page.locator("#status")).toHaveText("Rendered restored draft at 500000 µs.");
  expect(await nativeRows(page)).toEqual(rows);
  expect(await frame(page)).toEqual([[0, 0, 0, 128], [0, 0, 0, 255], [0, 0, 0, 0], [0, 0, 0, 0]]);
  expect(errors).toEqual([]);
});

for (const fault of ["wrong-MIME", "invalid-PNG", "file-read", "decode", "asset-reread", "placement"] as const) {
  test(`PNG ${fault} preserves document/pointers/frame with exact permitted asset effects`, async ({ page }) => {
    await page.addInitScript((fault) => {
      const read = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function () { return fault === "file-read" ? Promise.reject(new Error("Read fault")) : read.call(this); };
      const decode = globalThis.createImageBitmap;
      globalThis.createImageBitmap = (image: ImageBitmapSource) => fault === "decode" ? Promise.reject(new Error("Decode fault")) : decode(image);
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        const result = transaction.apply(this, args);
        if (fault === "asset-reread" && result.mode === "readwrite" && result.objectStoreNames.contains("assets")) {
          result.addEventListener("complete", () => { document.documentElement.dataset.assetCommitted = "yes"; }, { once: true });
        }
        return result;
      };
      const get = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function (key) {
        // Exclude writeAsset's readwrite preflight. Fault only the postcommit reread.
        if (fault === "asset-reread" && this.name === "assets" && this.transaction.mode === "readonly" &&
          document.documentElement.dataset.assetCommitted === "yes") {
          document.documentElement.dataset.assetReread = "postcommit";
          throw new DOMException("Read fault", "UnknownError");
        }
        return get.call(this, key);
      };
    }, fault);
    await open(page); await publishJson(page);
    const before = await nativeRows(page); const previousFrame = await frame(page);
    const input = fault === "invalid-PNG" ? [1, 2, 3] : bytes;
    await select(page, fault === "wrong-MIME" ? "text/plain" : "image/png", input);
    if (fault === "placement") await page.getByLabel("PNG width", { exact: true }).fill("-1");
    await pngButton(page).click();
    await expect(page.locator("#png-status")).toContainText(fault === "placement" ? "finite" : "PNG import failed");
    await expect(jsonButton(page)).toBeEnabled(); await expect(pngButton(page)).toBeEnabled();
    if (fault === "asset-reread") {
      await expect(page.locator("html")).toHaveAttribute("data-asset-committed", "yes");
      await expect(page.locator("html")).toHaveAttribute("data-asset-reread", "postcommit");
    }
    const written = ["invalid-PNG", "decode", "asset-reread"].includes(fault);
    const inputHash = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(input))).toString("hex")}`;
    expect(await nativeRows(page)).toEqual({ ...before, assets: written
      ? [{ sha256: inputHash, mimeType: "image/png", byteLength: input.length, bytes: input }] : [] });
    expect(await frame(page)).toEqual(previousFrame);
    await expect(page.locator("#status")).toHaveText("Import complete. Rendered imported draft at 500000 µs.");
  });
}

for (const during of [false, true]) {
  test(`external winner survives stale PNG with no retry/rebase (during preparation=${during})`, async ({ page, context }) => {
    if (during) await holdDecode(page);
    await open(page); await publishJson(page); await select(page); await place(page);
    const previousFrame = await frame(page);
    const other = await context.newPage(); await other.goto("/");
    await expect(other.locator("#status")).toContainText("restored draft");
    if (during) {
      await hold(page); await pngButton(page).click();
      await expect(page.locator("html")).toHaveAttribute("data-decode", "pending");
    }
    const winnerScene = scene(); winnerScene.seed = 99;
    await publishJson(other, winnerScene);
    const winner = await nativeRows(other);
    if (during) await settle(page); else await pngButton(page).click();
    await expect(page.locator("#png-status")).toContainText("PNG import failed");
    const expected = { ...winner, assets: [asset] }; // Even stale preparation may persist immutable bytes.
    expect(await nativeRows(page)).toEqual(expected);
    expect(await frame(page)).toEqual(previousFrame);
    await pngButton(page).click(); // Explicit later action is still bound to the old local source.
    await expect(page.locator("#png-status")).toContainText("PNG import failed");
    expect(await nativeRows(page)).toEqual(expected);
    expect(await frame(page)).toEqual(previousFrame);
    await other.close();
  });
}

for (const reject of [false, true]) {
  test(`pagehide owns PNG until settlement and freezes late DOM/frame (reject=${reject})`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await holdDecode(page, reject); await open(page); await publishJson(page);
    await select(page); await place(page); await hold(page); await pngButton(page).click();
    await expect(page.locator("html")).toHaveAttribute("data-decode", "pending");
    const before = await nativeRows(page); const previousFrame = await frame(page);
    expect(before.assets).toEqual([asset]);
    await page.evaluate(() => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pagehide")); });
    await expect(pngButton(page)).toBeDisabled(); await expect(jsonButton(page)).toBeDisabled();
    const markup = () => page.locator("body").evaluate(() => ["#json-import", "#png-import", "#status", "#png-status"]
      .map((selector) => document.querySelector(selector)!.outerHTML));
    const disposedMarkup = await markup();
    await expect(page.locator("html")).toHaveAttribute("data-bitmaps", JSON.stringify([{ id: 1, closes: 0 }]));
    await settle(page);
    const lifetimes = reject ? [{ id: 1, closes: 1 }] : [{ id: 1, closes: 1 }, { id: 2, closes: 1 }];
    await expect(page.locator("html")).toHaveAttribute("data-bitmaps", JSON.stringify(lifetimes));
    await expect(page.locator("#png-import")).toHaveAttribute("aria-busy", "true");
    await page.evaluate(() => {
      for (const id of ["json-import", "png-import"]) document.getElementById(id)!.dispatchEvent(new Event("submit", { cancelable: true }));
    });
    expect(await markup()).toEqual(disposedMarkup); expect(await frame(page)).toEqual(previousFrame);
    const after = await nativeRows(page);
    if (reject) expect(after).toEqual(before);
    else {
      expect(after.revisions).toHaveLength(2);
      const row = (after.revisions as ReturnType<typeof revision>[]).find((row) => row.sequence === 2)!;
      const document = scene(); const id = row.document.elements.at(-1)!.id;
      document.elements.push({ id, type: "image", ...placement, opacity: 1,
        asset: { sha256: hash, mimeType: "image/png", byteLength: bytes.length, intrinsicWidth: 1, intrinsicHeight: 1 } });
      document.rootIds.push(id);
      expect(row).toEqual(revision(document, row.revisionId, 2));
      expect(after.pointers).toEqual([{ documentId: BROWSER_DOCUMENT, saved: null, draft: pointer(row.revisionId, 2) }]);
      expect(after.assets).toEqual([asset]);
    }
    expect(errors).toEqual([]);
  });
}
