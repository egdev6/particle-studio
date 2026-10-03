import { expect, test, type Page } from "@playwright/test";
import type { SceneDocumentV1 } from "@particle-studio/scene-document";
import { BROWSER_DOCUMENT, nativeRows } from "../raw-indexeddb-seed.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const hash = "sha256:431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460";
const bytes = Array.from(atob(PNG), (char) => char.charCodeAt(0));
const asset = { sha256: hash, mimeType: "image/png", byteLength: bytes.length, bytes };
function scene(startUs = 500_000): SceneDocumentV1 {
  return { schemaVersion: 1, durationUs: 1_000_000, seed: 42, loop: true,
    playbackRange: { startUs, endUs: 1_000_000 }, rootIds: ["shape", "image"],
    tracks: [{ elementId: "shape", property: "opacity", interpolation: "linear", easing: "linear",
      keyframes: [{ timeUs: 0, value: 0.25 }, { timeUs: 1_000_000, value: 0.75 }] }],
    elements: [{ id: "shape", type: "shape", x: 16, y: 24, width: 120, height: 80, opacity: 1 },
      { id: "image", type: "image", x: 180, y: 24, width: 4, height: 4, opacity: 1,
        asset: { sha256: hash, mimeType: "image/png", byteLength: bytes.length, intrinsicWidth: 1, intrinsicHeight: 1 } }] };
}
function revision(document: SceneDocumentV1, revisionId: string, sequence: number) {
  const json = JSON.stringify(document, (_key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  const canonicalBytes = Array.from(new TextEncoder().encode(json));
  return { documentId: BROWSER_DOCUMENT, revisionId, sequence, document, canonicalBytes,
    canonicalization: { identifier: "jcs-1", byteLength: canonicalBytes.length } };
}
const pointer = (revisionId: string, sequence: number, kind = "draft") => ({ kind,
  documentId: BROWSER_DOCUMENT, revisionId, sequence });
async function pixels(page: Page) {
  return page.locator("#scene").evaluate((canvas: HTMLCanvasElement) =>
    [60, 181, 240].map((x) => Array.from(canvas.getContext("2d")!.getImageData(x, 25, 1, 1).data)));
}
async function open(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "JSON scene editor" })).toBeVisible();
  await expect(page.getByRole("status", { name: "", exact: true })).toHaveText("Rendered unpersisted sample at 0 µs.");
  await expect(page.getByRole("button", { name: "Import editable JSON" })).toBeEnabled();
}
async function importJson(page: Page, json: string) {
  await page.getByLabel("Editable JSON", { exact: true }).fill(json);
  await page.getByRole("button", { name: "Import editable JSON" }).click();
}
async function publish(page: Page, document: SceneDocumentV1) {
  await importJson(page, JSON.stringify(document));
  await expect(page.getByRole("status", { name: "", exact: true })).toHaveText(`Import complete. Rendered imported draft at ${document.playbackRange.startUs} µs.`);
}
async function delayedDecode(page: Page, reject: boolean) {
  await page.addInitScript((reject) => {
    const decode = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async (image: ImageBitmapSource) => {
      const bitmap = await decode(image);
      const root = document.documentElement;
      root.dataset.decode = "pending";
      root.dataset.dimensions = `${bitmap.width}x${bitmap.height}`;
      const close = bitmap.close.bind(bitmap);
      bitmap.close = () => { close(); root.dataset.closes = String(Number(root.dataset.closes ?? 0) + 1); };
      while (root.dataset.settle !== "yes") await new Promise((resolve) => setTimeout(resolve, 10));
      if (reject) { bitmap.close(); throw new Error("Injected decode rejection"); }
      return bitmap;
    };
  }, reject);
}

test("first and replacement imports hydrate genuine PNG, render playback start and survive refresh", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  expect(Object.values(await nativeRows(page)).every((rows) => Array.isArray(rows) && rows.length === 0)).toBe(true);
  await nativeRows(page, { assets: [asset] });
  const first = scene();
  await publish(page, first);
  const rows = await nativeRows(page);
  const revisions = rows.revisions as ReturnType<typeof revision>[];
  expect(revisions).toHaveLength(1);
  const id = revisions[0]!.revisionId;
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  expect(revisions[0]).toEqual(revision(first, id, 1));
  expect(rows.pointers).toEqual([{ documentId: BROWSER_DOCUMENT, saved: null, draft: pointer(id, 1) }]);
  expect(rows.assets).toEqual([asset]);
  expect(await pixels(page)).toEqual([[0, 0, 0, 128], [0, 0, 0, 255], [0, 0, 0, 0]]);
  const replacement = scene(750_000);
  await publish(page, replacement);
  const replaced = await nativeRows(page);
  const next = (replaced.revisions as ReturnType<typeof revision>[]).find((row) => row.revisionId !== id)!;
  expect(next).toEqual(revision(replacement, next.revisionId, 2));
  expect(replaced.pointers).toEqual([{ documentId: BROWSER_DOCUMENT, saved: null, draft: pointer(next.revisionId, 2) }]);
  const frame = await pixels(page);
  expect(frame[0]!.slice(0, 3)).toEqual([0, 0, 0]);
  expect(frame[0]![3]).toBeGreaterThanOrEqual(159);
  expect(frame[0]![3]).toBeLessThanOrEqual(160);
  expect(frame.slice(1)).toEqual([[0, 0, 0, 255], [0, 0, 0, 0]]);
  await page.reload();
  await expect(page.getByRole("status", { name: "", exact: true })).toHaveText("Rendered restored draft at 750000 µs.");
  expect(await nativeRows(page)).toEqual(replaced);
  expect(await pixels(page)).toEqual(frame);
  expect(errors).toEqual([]);
});

test("saved-only sequence 41 stays unpersisted until user import, then retains saved rows through refresh", async ({ page }) => {
  await open(page);
  const saved = revision(scene(), "saved-41", 41);
  const before = await nativeRows(page, { revisions: [saved], assets: [asset],
    pointers: [{ documentId: BROWSER_DOCUMENT, saved: pointer("saved-41", 41, "saved"), draft: null }] });
  await page.reload();
  await expect(page.getByRole("status", { name: "", exact: true })).toHaveText("Rendered unpersisted sample at 0 µs.");
  expect(await nativeRows(page)).toEqual(before);
  await publish(page, scene());
  const after = await nativeRows(page);
  const imported = (after.revisions as ReturnType<typeof revision>[]).find((row) => row.revisionId !== "saved-41")!;
  expect(imported).toEqual(revision(scene(), imported.revisionId, 42));
  expect(after.revisions).toContainEqual(saved);
  expect(after.pointers).toEqual([{ documentId: BROWSER_DOCUMENT,
    saved: pointer("saved-41", 41, "saved"), draft: pointer(imported.revisionId, 42) }]);
  expect(await pixels(page)).toEqual([[0, 0, 0, 128], [0, 0, 0, 255], [0, 0, 0, 0]]);
  await page.reload();
  await expect(page.getByRole("status", { name: "", exact: true })).toHaveText("Rendered restored draft at 500000 µs.");
  expect(await nativeRows(page)).toEqual(after);
});

test("malformed JSON and missing local PNG preserve previous canvas and durable publication", async ({ page }) => {
  await open(page);
  await nativeRows(page, { assets: [asset] });
  await publish(page, scene());
  const before = await nativeRows(page);
  const frame = await pixels(page);
  const missing = scene(750_000);
  (missing.elements[1] as Extract<SceneDocumentV1["elements"][number], { type: "image" }>).asset.sha256 = `sha256:${"0".repeat(64)}`;
  for (const json of ["{", JSON.stringify(missing)]) {
    await importJson(page, json);
    await expect(page.getByRole("status", { name: "", exact: true })).toContainText("Editable JSON import failed.");
    await expect(page.getByRole("button", { name: "Import editable JSON" })).toBeEnabled();
    expect(await nativeRows(page)).toEqual(before);
    expect(await pixels(page)).toEqual(frame);
  }
  await publish(page, scene(750_000));
  expect((await nativeRows(page)).revisions).toHaveLength(2);
});

for (const during of [false, true]) {
  test(`external tab winner rejects stale import without rebasing (during preparation=${during})`, async ({ page, context }) => {
    if (during) await delayedDecode(page, false);
    await open(page);
    await nativeRows(page, { assets: [asset] });
    // Start with a shape-only publication, so the competing import decodes cold.
    const source = scene();
    source.rootIds.pop(); source.elements.pop();
    await publish(page, source);
    const frame = await pixels(page);
    const other = await context.newPage();
    await other.goto("/");
    await expect(other.getByRole("status", { name: "", exact: true })).toContainText("Rendered restored draft");
    if (during) {
      await importJson(page, JSON.stringify(scene(750_000)));
      await expect(page.locator("html")).toHaveAttribute("data-decode", "pending");
      await expect(page.locator("html")).toHaveAttribute("data-dimensions", "1x1");
    }
    await publish(other, scene());
    const winner = await nativeRows(other);
    if (during) await page.locator("html").evaluate((root) => { (root as HTMLElement).dataset.settle = "yes"; });
    else await importJson(page, JSON.stringify(scene(750_000)));
    await expect(page.getByRole("status", { name: "", exact: true })).toContainText("Editable JSON import failed.");
    expect(await nativeRows(page)).toEqual(winner);
    expect(await pixels(page)).toEqual(frame);
    await expect(page.getByRole("button", { name: "Import editable JSON" })).toBeEnabled();
    // A later explicit action still has the old local source, not an adopted winner.
    await importJson(page, JSON.stringify(scene(750_000)));
    await expect(page.getByRole("status", { name: "", exact: true })).toContainText("Editable JSON import failed.");
    expect(await nativeRows(page)).toEqual(winner);
    expect(await pixels(page)).toEqual(frame);
    await other.close();
  });
}

for (const reject of [false, true]) {
  test(`pagehide waits for owned import settlement and suppresses late rendering (reject=${reject})`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await delayedDecode(page, reject);
    await open(page);
    await nativeRows(page, { assets: [asset] });
    const before = await nativeRows(page);
    const frame = await pixels(page);
    await importJson(page, JSON.stringify(scene()));
    await expect(page.locator("html")).toHaveAttribute("data-decode", "pending");
    await page.evaluate(() => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pagehide")); });
    await expect(page.getByRole("button", { name: "Import editable JSON" })).toBeDisabled();
    expect(await page.locator("html").getAttribute("data-closes")).toBeNull();
    expect(await nativeRows(page)).toEqual(before);
    await page.locator("html").evaluate((root) => { (root as HTMLElement).dataset.settle = "yes"; });
    await expect(page.locator("html")).toHaveAttribute("data-closes", "1");
    await expect(page.getByRole("status", { name: "", exact: true })).toHaveText("Import in progress.");
    await expect(page.getByRole("form", { name: "JSON import controls" })).toHaveAttribute("aria-busy", "true");
    expect(await pixels(page)).toEqual(frame);
    const settled = await nativeRows(page);
    if (reject) expect(settled).toEqual(before);
    else {
      expect(settled.revisions).toHaveLength(1);
      const row = (settled.revisions as ReturnType<typeof revision>[])[0]!;
      expect(row).toEqual(revision(scene(), row.revisionId, 1));
      expect(settled.pointers).toEqual([{ documentId: BROWSER_DOCUMENT, saved: null, draft: pointer(row.revisionId, 1) }]);
    }
    expect(errors).toEqual([]);
  });
}
