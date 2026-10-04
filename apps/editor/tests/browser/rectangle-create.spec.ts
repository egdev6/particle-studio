/// <reference types="node" />
import { Buffer } from "node:buffer";
import { expect, test, type Page } from "@playwright/test";
import type { SceneDocumentV1 } from "@particle-studio/scene-document";
import { BROWSER_DOCUMENT, nativeRows } from "../raw-indexeddb-seed.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const defaults = { x: 16, y: 24, width: 120, height: 80 };
const separate = { x: 200, y: 40, width: 20, height: 15 };
const add = (page: Page) => page.getByRole("button", { name: "Add rectangle", exact: true });
const status = (page: Page) => page.getByRole("status", { name: "Rectangle creation status", exact: true });
const blank = (): SceneDocumentV1 => ({ schemaVersion: 1, durationUs: 1_000_000, seed: 42, loop: true,
  playbackRange: { startUs: 0, endUs: 1_000_000 }, tracks: [], rootIds: ["root"],
  elements: [{ id: "root", type: "group", childrenIds: [] }] });
const rich = (): SceneDocumentV1 => ({ schemaVersion: 1, durationUs: 1_000_000, seed: 99, loop: false,
  playbackRange: { startUs: 500_000, endUs: 900_000 }, rootIds: ["group"],
  elements: [{ id: "group", type: "group", childrenIds: ["shape"] },
    { id: "shape", type: "shape", ...defaults, opacity: 1 }],
  tracks: [{ elementId: "shape", property: "opacity", interpolation: "linear", easing: "linear",
    keyframes: [{ timeUs: 0, value: 0.25 }, { timeUs: 1_000_000, value: 0.75 }] }] });
function revision(document: SceneDocumentV1, revisionId: string, sequence: number) {
  const json = JSON.stringify(document, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  const canonicalBytes = Array.from(new TextEncoder().encode(json));
  return { documentId: BROWSER_DOCUMENT, revisionId, sequence, document, canonicalBytes,
    canonicalization: { identifier: "jcs-1", byteLength: canonicalBytes.length } };
}
const pointer = (revisionId: string, sequence: number, kind = "draft") => ({ kind, documentId: BROWSER_DOCUMENT, revisionId, sequence });
function ordered(rows: Awaited<ReturnType<typeof nativeRows>>) {
  return { ...rows, revisions: (rows.revisions as ReturnType<typeof revision>[]).slice().sort((a, b) =>
    a.documentId.localeCompare(b.documentId) || a.revisionId.localeCompare(b.revisionId)) };
}
function current(rows: Awaited<ReturnType<typeof nativeRows>>) {
  const draft = (rows.pointers as { draft: { revisionId: string } }[])[0]!.draft;
  return (rows.revisions as ReturnType<typeof revision>[]).find((row) => row.revisionId === draft.revisionId)!;
}
async function frame(page: Page) {
  return page.locator("#scene").evaluate((canvas: HTMLCanvasElement) => [60, 181, 201, 240].map((x) =>
    Array.from(canvas.getContext("2d")!.getImageData(x, 45, 1, 1).data)));
}
async function placement(page: Page, geometry = separate) {
  for (const [key, value] of Object.entries(geometry)) await page.getByLabel(`Rectangle ${key}`, { exact: true }).fill(String(value));
}
async function open(page: Page) {
  await page.goto("/"); await expect(page.locator("#status")).toContainText("unpersisted sample");
}
async function publishJson(page: Page, document = rich()) {
  await page.getByLabel("Editable JSON", { exact: true }).fill(JSON.stringify(document));
  await page.getByRole("button", { name: "Import editable JSON" }).click();
  await expect(page.locator("#status")).toContainText("Rendered imported draft");
}
async function withPng(page: Page) {
  await publishJson(page);
  await page.getByLabel("PNG file", { exact: true }).setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: png });
  for (const [key, value] of Object.entries({ x: 180, y: 40, width: 8, height: 8 })) {
    await page.getByLabel(`PNG ${key}`, { exact: true }).fill(String(value));
  }
  await page.getByRole("button", { name: "Import PNG", exact: true }).click();
  await expect(page.locator("#png-status")).toContainText("PNG import complete");
}
// Delay a real readonly request AFTER it obtained its native result. Every later
// readwrite CAS request remains untouched and reads the then-current pointer.
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      const root = document.documentElement;
      if (root.dataset.fault === "image" && this.name === "assets" && this.transaction.mode === "readonly") {
        throw new DOMException("Referenced image read fault", "UnknownError");
      }
      const request = get.call(this, key);
      if (this.name !== "pointers" || this.transaction.mode !== "readonly" || root.dataset.hold !== "yes") return request;
      root.dataset.hold = "consumed";
      const intercept = (event: Event) => {
        event.stopImmediatePropagation(); request.removeEventListener("success", intercept, true);
        root.dataset.preparation = "pending";
        void (async () => {
          while (root.dataset.settle !== "yes") await new Promise((resolve) => setTimeout(resolve, 10));
          const reject = root.dataset.fault === "preparation";
          if (reject) Object.defineProperty(request, "error", { value: new DOMException("Preparation fault", "UnknownError") });
          request.dispatchEvent(new Event(reject ? "error" : "success", { cancelable: true }));
          setTimeout(() => { root.dataset.preparation = "settled"; }, 0);
        })();
      };
      request.addEventListener("success", intercept, true);
      return request;
    };
    const decode = globalThis.createImageBitmap;
    const records: { id: number; closes: number }[] = [];
    globalThis.createImageBitmap = async (source: ImageBitmapSource) => {
      const bitmap = await decode(source);
      const record = { id: records.length + 1, closes: 0 }; records.push(record);
      const update = () => { document.documentElement.dataset.bitmaps = JSON.stringify(records); };
      const close = bitmap.close.bind(bitmap);
      bitmap.close = () => { close(); record.closes += 1; update(); };
      update(); return bitmap;
    };
  });
}
async function set(page: Page, values: Record<string, string>) {
  await page.locator("html").evaluate((root, values) => Object.assign((root as HTMLElement).dataset, values), values);
}
async function lifetimes(page: Page) {
  return JSON.parse((await page.locator("html").getAttribute("data-bitmaps")) ?? "[]") as { id: number; closes: number }[];
}
async function expectedAppend(page: Page, before: Awaited<ReturnType<typeof nativeRows>>, geometry: typeof defaults) {
  const after = await nativeRows(page); const previous = current(before); const next = current(after);
  expect(next.revisionId).toMatch(/^[a-f0-9-]{36}$/);
  expect(next.revisionId).not.toBe(previous.revisionId);
  const id = next.document.elements.at(-1)!.id;
  expect(id).not.toBe(""); expect(previous.document.elements.some((element) => element.id === id)).toBe(false);
  const document = structuredClone(previous.document);
  document.rootIds.push(id); document.elements.push({ id, type: "shape", ...geometry, opacity: 1 });
  expect(next).toEqual(revision(document, next.revisionId, previous.sequence + 1));
  expect(ordered(after)).toEqual(ordered({ ...before, revisions: [...before.revisions as unknown[], next],
    pointers: [{ documentId: BROWSER_DOCUMENT, saved: (before.pointers as { saved: unknown }[])[0]!.saved,
      draft: pointer(next.revisionId, previous.sequence + 1) }] }));
  return after;
}

for (const image of [false, true]) {
  test(`actual rectangle preserves content, pixels and publication after refresh (PNG=${image})`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await instrument(page); await open(page);
    await expect(add(page)).toBeDisabled();
    if (image) await withPng(page);
    else {
      await page.getByRole("button", { name: "Create blank scene", exact: true }).click();
      await expect(page.locator("#status")).toContainText("Rendered imported draft");
      expect(current(await nativeRows(page)).document).toEqual(blank());
    }
    const before = await nativeRows(page);
    if (image) {
      const imageElement = current(before).document.elements.at(-1)!;
      const expected = rich(); expected.rootIds.push(imageElement.id);
      expected.elements.push({ id: imageElement.id, type: "image", x: 180, y: 40, width: 8, height: 8, opacity: 1,
        asset: { sha256: "sha256:431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460",
          mimeType: "image/png", byteLength: png.length, intrinsicWidth: 1, intrinsicHeight: 1 } });
      expect(current(before).document).toEqual(expected);
      expect(before.assets).toEqual([{ sha256: "sha256:431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460",
        mimeType: "image/png", byteLength: png.length, bytes: Array.from(png) }]);
    }
    for (const [key, value] of Object.entries(defaults)) {
      await expect(page.getByLabel(`Rectangle ${key}`, { exact: true })).toHaveValue(String(value));
    }
    await page.getByLabel("Editable JSON", { exact: true }).fill("not JSON");
    if (image) await placement(page);
    const geometry = image ? separate : defaults;
    const retained = (await lifetimes(page)).filter((record) => record.closes === 0);
    await set(page, { hold: "yes" }); await add(page).click();
    await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending");
    for (const name of ["Add rectangle", "Import PNG", "Import editable JSON", "Create blank scene"]) {
      await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
    }
    await add(page).dispatchEvent("click");
    await page.locator("#rectangle-create").dispatchEvent("submit");
    await page.locator("#json-import").dispatchEvent("submit");
    await page.locator("#png-import").dispatchEvent("submit");
    await page.getByRole("button", { name: "Create blank scene", exact: true }).dispatchEvent("click");
    await page.getByLabel("Rectangle x", { exact: true }).evaluate((input: HTMLInputElement) => { input.value = "240"; });
    expect(await nativeRows(page)).toEqual(before);
    await set(page, { settle: "yes" }); await expect(status(page)).toContainText("complete");
    const after = await expectedAppend(page, before, geometry);
    await expect(page.getByRole("status", { name: "", exact: true })).toHaveText(
      `Rendered imported draft at ${image ? 500000 : 0} µs.`);
    const pixels = image ? [[0, 0, 0, 128], [0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 0]]
      : [[0, 0, 0, 255], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    expect(await frame(page)).toEqual(pixels);
    const handles = await lifetimes(page);
    for (const record of retained) expect(handles.find((candidate) => candidate.id === record.id)?.closes).toBe(0);
    for (const record of handles) if (!retained.some((candidate) => candidate.id === record.id)) expect(record.closes).toBe(1);
    if (image) expect(handles.length).toBeGreaterThan(retained.length);
    await page.reload(); await expect(page.locator("#status")).toContainText("Rendered restored draft");
    expect(await nativeRows(page)).toEqual(after); expect(await frame(page)).toEqual(pixels);
    expect(errors).toEqual([]);
  });
}

for (const fault of ["geometry", "preparation", "image"] as const) {
  test(`rectangle ${fault} failure preserves native rows and rendered current`, async ({ page }) => {
    await instrument(page); await open(page); await withPng(page); await placement(page);
    const before = await nativeRows(page); const pixels = await frame(page);
    const handles = await lifetimes(page);
    if (fault === "geometry") await page.getByLabel("Rectangle width", { exact: true }).fill("0");
    else await set(page, { fault, hold: fault === "preparation" ? "yes" : "no", settle: "yes" });
    await add(page).click(); await expect(status(page)).toContainText(fault === "geometry" ? "finite" : "failed");
    expect(await nativeRows(page)).toEqual(before); expect(await frame(page)).toEqual(pixels);
    expect(await lifetimes(page)).toEqual(handles);
    await expect(add(page)).toBeEnabled();
  });
}

for (const during of [false, true]) {
  test(`external winner survives rectangle without retry or rebase (during=${during})`, async ({ page, context }) => {
    await instrument(page); await open(page); await withPng(page); await placement(page);
    const pixels = await frame(page);
    const other = await context.newPage(); await other.goto("/");
    await expect(other.locator("#status")).toContainText("restored draft");
    if (during) {
      await set(page, { hold: "yes" }); await add(page).click();
      await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending");
    }
    const winnerDocument = rich(); winnerDocument.seed = 123;
    await publishJson(other, winnerDocument); const winner = await nativeRows(other);
    if (during) await set(page, { settle: "yes" }); else await add(page).click();
    await expect(status(page)).toContainText("refresh");
    expect(await nativeRows(page)).toEqual(winner); expect(await frame(page)).toEqual(pixels);
    await add(page).click(); await expect(status(page)).toContainText("refresh");
    expect(await nativeRows(page)).toEqual(winner); expect(await frame(page)).toEqual(pixels);
    await other.close();
  });
}

for (const reject of [false, true]) {
  test(`pagehide freezes rectangle DOM/frame and settles real work before bitmap release (reject=${reject})`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await instrument(page); await open(page); await withPng(page); await placement(page);
    const before = await nativeRows(page); const pixels = await frame(page);
    const retained = (await lifetimes(page)).filter((record) => record.closes === 0);
    expect(retained).toHaveLength(1);
    await set(page, { hold: "yes", fault: reject ? "preparation" : "" }); await add(page).click();
    await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending");
    await page.evaluate(() => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pagehide")); });
    const markup = () => page.locator("body").evaluate(() => document.body.innerHTML);
    const snapshot = await markup();
    for (const record of retained) expect((await lifetimes(page)).find((candidate) => candidate.id === record.id)?.closes).toBe(0);
    await set(page, { settle: "yes" });
    await expect.poll(async () => (await lifetimes(page)).every((record) => record.closes === 1)).toBe(true);
    if (reject) expect(await nativeRows(page)).toEqual(before);
    else await expectedAppend(page, before, separate);
    await page.locator("#rectangle-create").dispatchEvent("submit"); await add(page).dispatchEvent("click");
    expect(await markup()).toBe(snapshot); expect(await frame(page)).toEqual(pixels);
    await expect(page.locator("#rectangle-create")).toHaveAttribute("aria-busy", "true");
    expect(errors).toEqual([]);
  });
}

for (const gate of ["absent", "saved-only", "corrupt", "context"] as const) {
  test(`rectangle cannot promote startup ${gate} into an editable source`, async ({ page }) => {
    if (gate === "context") await page.addInitScript(() => { HTMLCanvasElement.prototype.getContext = () => null; });
    await page.goto("/"); await expect(page.locator("#status")).toContainText(gate === "context" ? "Error:" : "sample");
    if (gate === "context") {
      // Context failure returns before startup I/O. nativeRows would create an
      // empty database here; enumerate read-only to prove genuine absence.
      expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
      await expect(add(page)).toBeDisabled(); await add(page).dispatchEvent("click");
      await page.locator("#rectangle-create").dispatchEvent("submit");
      expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
      return;
    }
    if (gate === "saved-only" || gate === "corrupt") {
      const row = revision(rich(), "saved-41", 41);
      await nativeRows(page, { revisions: [row], pointers: [{ documentId: BROWSER_DOCUMENT,
        saved: gate === "saved-only" ? pointer("saved-41", 41, "saved") : null,
        draft: gate === "corrupt" ? pointer("missing", 42) : null }] });
      await page.reload(); await expect(page.locator("#status")).toContainText(gate === "corrupt" ? "Error:" : "sample");
    }
    const before = await nativeRows(page);
    await expect(add(page)).toBeDisabled(); await add(page).dispatchEvent("click");
    await page.locator("#rectangle-create").dispatchEvent("submit");
    expect(await nativeRows(page)).toEqual(before);
    if (gate === "absent" || gate === "saved-only") await expect(status(page)).toContainText("Create a scene or import JSON");
  });
}
