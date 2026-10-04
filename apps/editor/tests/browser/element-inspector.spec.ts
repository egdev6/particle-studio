/// <reference types="node" />
import { Buffer } from "node:buffer";
import { expect, test, type Page } from "@playwright/test";
import type { SceneDocumentV1 } from "@particle-studio/scene-document";
import { BROWSER_DOCUMENT, nativeRows } from "../raw-indexeddb-seed.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const hash = "sha256:431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460";
const select = (page: Page) => page.getByRole("combobox", { name: "Scene element", exact: true });
const details = (page: Page) => page.getByLabel("Published element JSON", { exact: true });
const status = (page: Page) => page.getByRole("status", { name: "Element inspection status", exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const blank = (): SceneDocumentV1 => ({ schemaVersion: 1, durationUs: 1_000_000, seed: 42, loop: true,
  playbackRange: { startUs: 0, endUs: 1_000_000 }, tracks: [], rootIds: ["root"],
  elements: [{ id: "root", type: "group", childrenIds: [] }] });
const rich = (): SceneDocumentV1 => ({ ...blank(), seed: 99, loop: false,
  playbackRange: { startUs: 500_000, endUs: 900_000 },
  elements: [{ id: "root", type: "group", childrenIds: ["nested", "line", "text", "particle"] },
    { id: "nested", type: "group", childrenIds: ["shape"], transform: [1, 0, 0, 1, 3, 4], visible: true },
    { id: "shape", type: "shape", x: 16, y: 24, width: 120, height: 80, opacity: 1 },
    { id: "line", type: "line", x1: 2, y1: 3, x2: 20, y2: 30, opacity: 0.6 },
    { id: "text", type: "text", text: "<img src=x onerror=alert(1)>&", x: 8, y: 9, fontSize: 12, opacity: 1 },
    { id: "particle", type: "particle", count: 2, x: 1, y: 2, velocityX: 3, velocityY: 4,
      spread: 5, size: 6, opacity: 0.7, lifetimeSteps: 20 }],
  tracks: [{ elementId: "shape", property: "opacity", interpolation: "linear", easing: "linear",
    keyframes: [{ timeUs: 0, value: 0.25 }, { timeUs: 1_000_000, value: 0.75 }] },
    { elementId: "text", property: "text.text", interpolation: "step", keyframes: [{ timeUs: 0, value: "animated" }] }] });
function revision(document: SceneDocumentV1, revisionId: string, sequence: number) {
  // Independent JCS expectation for finite JSON fixtures; preserve array order.
  // Real production imports validate these authored variants; UI fixtures also
  // exercise the SDK validator. Do not load its generated module in Node here.
  const json = JSON.stringify(document, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  const canonicalBytes = Array.from(new TextEncoder().encode(json));
  return { documentId: BROWSER_DOCUMENT, revisionId, sequence, document, canonicalBytes,
    canonicalization: { identifier: "jcs-1", byteLength: canonicalBytes.length } };
}
type Rows = Awaited<ReturnType<typeof nativeRows>>;
function current(rows: Rows) {
  const draft = (rows.pointers as { draft: { revisionId: string } }[])[0]!.draft;
  return (rows.revisions as ReturnType<typeof revision>[]).find((row) => row.documentId === BROWSER_DOCUMENT && row.revisionId === draft.revisionId)!;
}
function ordered(rows: Rows) {
  return Object.fromEntries(Object.entries(rows).map(([store, values]) => [store, (values as Record<string, unknown>[]).slice().sort((a, b) =>
    String(a.documentId ?? a.sha256 ?? "").localeCompare(String(b.documentId ?? b.sha256 ?? "")) ||
    String(a.revisionId ?? "").localeCompare(String(b.revisionId ?? "")))]));
}
async function set(page: Page, values: Record<string, string>) {
  await page.locator("html").evaluate((root, values) => Object.assign((root as HTMLElement).dataset, values), values);
}
async function pixels(page: Page) {
  return page.locator("#scene").evaluate((canvas: HTMLCanvasElement) =>
    Array.from(canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data));
}
async function handles(page: Page) {
  return JSON.parse((await page.locator("html").getAttribute("data-bitmaps")) ?? "[]") as { id: number; closes: number }[];
}
async function pane(page: Page) {
  return { select: await select(page).evaluate((element: HTMLSelectElement) => [element.outerHTML, element.value]),
    detail: await details(page).evaluate((element) => element.outerHTML),
    status: await status(page).evaluate((element) => element.outerHTML) };
}
async function instrument(page: Page, startupHold = false) {
  await page.addInitScript((startupHold) => {
    const counts: Record<string, number> = {};
    const hit = (name: string) => { if (document.documentElement.dataset.watch === "yes") {
      counts[name] = (counts[name] ?? 0) + 1; document.documentElement.dataset.effects = JSON.stringify(counts);
    } };
    globalThis.BigInt = new Proxy(BigInt, { apply(target, receiver, args) { hit("evaluation"); return Reflect.apply(target, receiver, args); } });
    const lookup = Map.prototype.get;
    Map.prototype.get = function (key) { if (typeof key === "string" && key.startsWith("sha256:")) hit("bitmap-lookup"); return lookup.call(this, key); };
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) { hit("database-open"); return open.apply(this, args); };
    for (const name of ["getAll", "put", "add", "delete", "clear"] as const) {
      const method = IDBObjectStore.prototype[name];
      Object.defineProperty(IDBObjectStore.prototype, name, { configurable: true, value: function (this: IDBObjectStore, ...args: unknown[]) {
        hit(`idb-${name}`); return Reflect.apply(method, this, args);
      } });
    }
    const get = IDBObjectStore.prototype.get; let startup = startupHold;
    IDBObjectStore.prototype.get = function (key) {
      hit(`read-${this.name}`); const request = get.call(this, key);
      const root = document.documentElement;
      if (this.name !== "pointers" || this.transaction.mode !== "readonly" || (!startup && root.dataset.hold !== "yes")) return request;
      startup = false; root.dataset.hold = "consumed";
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
      request.addEventListener("success", intercept, true); return request;
    };
    for (const name of Object.getOwnPropertyNames(CanvasRenderingContext2D.prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, name)!;
      if (typeof descriptor.value !== "function" || name === "constructor" || name === "getImageData") continue;
      Object.defineProperty(CanvasRenderingContext2D.prototype, name, { ...descriptor, value: function (this: CanvasRenderingContext2D, ...args: unknown[]) {
        hit(`canvas-${name}`);
        if (name === "clearRect" && document.documentElement.dataset.renderFault === "yes") throw new Error("Before-clear render fault");
        return Reflect.apply(descriptor.value, this, args);
      } });
    }
    const bytes = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () { hit("blob-read"); return bytes.call(this); };
    const decode = globalThis.createImageBitmap; const records: { id: number; closes: number }[] = [];
    globalThis.createImageBitmap = async (source: ImageBitmapSource) => {
      hit("decode"); const bitmap = await decode(source); const record = { id: records.length + 1, closes: 0 }; records.push(record);
      const update = () => { document.documentElement.dataset.bitmaps = JSON.stringify(records); };
      const close = bitmap.close.bind(bitmap);
      bitmap.close = () => { hit("close"); close(); record.closes += 1; update(); }; update(); return bitmap;
    };
  }, startupHold);
}
async function open(page: Page) {
  await page.goto("/"); await expect(page.locator("#status")).toContainText("unpersisted sample");
  await expect(select(page)).toBeVisible(); await expect(select(page)).toBeDisabled();
  await expect(page.getByRole("status", { name: "", exact: true })).toHaveCount(1);
}
async function publish(page: Page, document = rich()) {
  // Successful production import plus exact durable document equality below
  // proves validation of the authored fixture without a Node SDK preflight.
  await page.getByLabel("Editable JSON", { exact: true }).fill(JSON.stringify(document));
  await button(page, "Import editable JSON").click(); await expect(page.locator("#status")).toContainText("Rendered imported draft");
  expect(current(await nativeRows(page)).document).toEqual(document);
}
async function importPng(page: Page) {
  await page.getByLabel("PNG file", { exact: true }).setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: png });
  for (const [key, value] of Object.entries({ x: 16, y: 24, width: 120, height: 80 })) {
    await page.getByLabel(`PNG ${key}`, { exact: true }).fill(String(value));
  }
  await button(page, "Import PNG").click(); await expect(page.locator("#png-status")).toContainText("PNG import complete");
}
async function inspect(page: Page, expected: SceneDocumentV1) {
  const before = await nativeRows(page); const frame = await pixels(page); const bitmaps = await handles(page);
  expect(current(before).document).toEqual(expected);
  await expect(select(page)).toHaveValue(""); await expect(details(page)).toHaveText("");
  if (expected.elements.some((element) => element.type === "image")) {
    expect(bitmaps.filter((record) => record.closes === 0)).toHaveLength(1);
    for (const record of bitmaps) expect(record.closes).toBeLessThanOrEqual(1);
  }
  expect(await select(page).locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)))
    .toEqual(["", ...expected.elements.map((element) => element.id)]);
  await set(page, { watch: "yes" });
  for (const editable of [JSON.stringify({ ...expected, seed: 123 }), "not JSON / unsent"]) {
    await page.getByLabel("Editable JSON", { exact: true }).fill(editable);
    for (const element of expected.elements) {
      await select(page).selectOption(element.id);
      expect(JSON.parse((await details(page).textContent())!)).toEqual(element);
      await expect(details(page).locator("img,script,input,textarea")).toHaveCount(0);
    }
  }
  await select(page).selectOption(""); await expect(details(page)).toHaveText("");
  await set(page, { watch: "no" });
  expect(JSON.parse((await page.locator("html").getAttribute("data-effects")) ?? "{}")).toEqual({});
  expect(ordered(await nativeRows(page))).toEqual(ordered(before));
  expect(await pixels(page)).toEqual(frame); expect(await handles(page)).toEqual(bitmaps);
  await select(page).selectOption(expected.elements[0]!.id);
  await page.reload(); await expect(page.locator("#status")).toContainText("restored draft");
  await expect(select(page)).toHaveValue(""); await expect(details(page)).toHaveText("");
  expect(ordered(await nativeRows(page))).toEqual(ordered(before)); expect(await pixels(page)).toEqual(frame);
}

test("published blank/root, rectangle, all nested authored variants and genuine PNG inspect without effects", async ({ page }) => {
  await instrument(page); await open(page);
  await expect(status(page)).toContainText("Create blank scene"); await expect(status(page)).toContainText("import JSON");
  await button(page, "Create blank scene").click(); await expect(page.locator("#status")).toContainText("Rendered imported draft");
  await inspect(page, blank());
  await button(page, "Add rectangle").click(); await expect(page.locator("#rectangle-status")).toContainText("complete");
  const appended = current(await nativeRows(page)).document.elements.at(-1)!;
  const rectangle = blank(); rectangle.rootIds.push(appended.id);
  rectangle.elements.push({ id: appended.id, type: "shape", x: 16, y: 24, width: 120, height: 80, opacity: 1 });
  await inspect(page, rectangle); await publish(page); await importPng(page);
  const image = current(await nativeRows(page)).document.elements.at(-1)!;
  const expected = rich(); expected.rootIds.push(image.id);
  expected.elements.push({ id: image.id, type: "image", x: 16, y: 24, width: 120, height: 80, opacity: 1,
    asset: { sha256: hash, mimeType: "image/png", byteLength: png.length, intrinsicWidth: 1, intrinsicHeight: 1 } });
  expect((await nativeRows(page)).assets).toEqual([{ sha256: hash, mimeType: "image/png", byteLength: png.length, bytes: Array.from(png) }]);
  await page.getByLabel("Editable JSON", { exact: true }).fill("not JSON / unsent");
  await inspect(page, expected);
});

for (const action of ["Import editable JSON", "Create blank scene", "Import PNG", "Add rectangle"]) {
  test(`actual ${action} pending lane disables inspection and reflects the settled published identity`, async ({ page }) => {
    await instrument(page); await open(page);
    if (action !== "Create blank scene") {
      await publish(page);
      // Re-import the same genuine PNG: legitimate asset staging before the
      // readonly pointer barrier must not be mistaken for inspection writes.
      if (action === "Import PNG") await importPng(page);
      await select(page).selectOption("shape");
    }
    const before = await nativeRows(page); const prior = await details(page).textContent();
    if (action === "Import PNG") await page.getByLabel("PNG file", { exact: true }).setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: png });
    await set(page, { hold: "yes" }); await button(page, action).click();
    await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending");
    await expect(select(page)).toBeDisabled(); await expect(status(page)).toContainText("pending");
    if (action !== "Create blank scene") await expect(status(page)).toContainText(current(before).revisionId);
    await select(page).evaluate((element: HTMLSelectElement) => { element.value = "root"; element.dispatchEvent(new Event("change")); });
    expect(await details(page).textContent()).toBe(prior); expect(await nativeRows(page)).toEqual(before);
    await set(page, { settle: "yes" }); await expect(select(page)).toBeEnabled();
    await expect(select(page)).toHaveValue(""); await expect(details(page)).toHaveText("");
    const after = await nativeRows(page); expect(current(after).revisionId).not.toBe(action === "Create blank scene" ? "" : current(before).revisionId);
    await select(page).selectOption("root"); expect(JSON.parse((await details(page).textContent())!)).toEqual(current(after).document.elements[0]);
  });
}

test("same-current rejection retains selection; reused IDs in a different publication clear it", async ({ page }) => {
  await instrument(page); await open(page); await publish(page); await select(page).selectOption("shape");
  const before = await nativeRows(page); const frame = await pixels(page); const detail = await details(page).textContent();
  await set(page, { hold: "yes", fault: "preparation" }); await button(page, "Add rectangle").click();
  await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending"); await set(page, { settle: "yes" });
  await expect(page.locator("#rectangle-status")).toContainText("failed"); await expect(select(page)).toHaveValue("shape");
  expect(await details(page).textContent()).toBe(detail); expect(await nativeRows(page)).toEqual(before); expect(await pixels(page)).toEqual(frame);
  await set(page, { fault: "" }); const replacement = rich(); replacement.seed = 123;
  const shape = replacement.elements[2]!; if (shape.type === "shape") shape.x = 90;
  await publish(page, replacement); await expect(select(page)).toHaveValue(""); await expect(details(page)).toHaveText("");
  expect(current(await nativeRows(page)).revisionId).not.toBe(current(before).revisionId);
  await select(page).selectOption("shape"); expect(JSON.parse((await details(page).textContent())!)).toEqual(shape);
});

test("post-CAS before-clear render exception still resets inspector to the genuine published current", async ({ page }) => {
  await instrument(page); await open(page); await publish(page); await select(page).selectOption("shape");
  const before = await nativeRows(page); const frame = await pixels(page);
  await set(page, { renderFault: "yes" }); await button(page, "Add rectangle").click();
  await expect(page.locator("#rectangle-status")).toContainText("created, but rendering failed");
  const after = await nativeRows(page); const next = current(after); const previous = current(before);
  expect(next.revisionId).not.toBe(previous.revisionId); const element = next.document.elements.at(-1)!;
  const expected = rich(); expected.rootIds.push(element.id);
  expected.elements.push({ id: element.id, type: "shape", x: 16, y: 24, width: 120, height: 80, opacity: 1 });
  expect(next).toEqual(revision(expected, next.revisionId, previous.sequence + 1));
  expect(ordered(after)).toEqual(ordered({ ...before, revisions: [...before.revisions as unknown[], next],
    pointers: [{ documentId: BROWSER_DOCUMENT, saved: null,
      draft: { kind: "draft", documentId: BROWSER_DOCUMENT, revisionId: next.revisionId, sequence: next.sequence } }] }));
  await expect(select(page)).toBeEnabled(); await expect(select(page)).toHaveValue(""); await expect(details(page)).toHaveText("");
  await select(page).selectOption(element.id); expect(JSON.parse((await details(page).textContent())!)).toEqual(expected.elements.at(-1));
  expect(await pixels(page)).toEqual(frame);
});

for (const reject of [false, true]) {
  test(`pagehide freezes inspector through actual owned settlement and late events (reject=${reject})`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await instrument(page); await open(page); await publish(page); await importPng(page); await select(page).selectOption("shape");
    const before = await nativeRows(page); const frame = await pixels(page);
    const retained = (await handles(page)).filter((record) => record.closes === 0); expect(retained).toHaveLength(1);
    await set(page, { hold: "yes", fault: reject ? "preparation" : "" }); await button(page, "Add rectangle").click();
    await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending");
    await page.evaluate(() => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pagehide")); });
    const frozen = await pane(page);
    for (const record of retained) expect((await handles(page)).find((candidate) => candidate.id === record.id)?.closes).toBe(0);
    await set(page, { settle: "yes" });
    await expect.poll(async () => (await handles(page)).every((record) => record.closes === 1)).toBe(true);
    await select(page).dispatchEvent("change"); await button(page, "Add rectangle").dispatchEvent("click");
    expect(await pane(page)).toEqual(frozen); expect(await pixels(page)).toEqual(frame);
    const after = await nativeRows(page);
    if (reject) expect(after).toEqual(before);
    else {
      const next = current(after); const document = structuredClone(current(before).document);
      const id = next.document.elements.at(-1)!.id; document.rootIds.push(id);
      document.elements.push({ id, type: "shape", x: 16, y: 24, width: 120, height: 80, opacity: 1 });
      expect(next).toEqual(revision(document, next.revisionId, current(before).sequence + 1));
      expect(ordered(after)).toEqual(ordered({ ...before, revisions: [...before.revisions as unknown[], next],
        pointers: [{ documentId: BROWSER_DOCUMENT, saved: null,
          draft: { kind: "draft", documentId: BROWSER_DOCUMENT, revisionId: next.revisionId, sequence: next.sequence } }] }));
    }
    expect(errors).toEqual([]);
  });
}

for (const gate of ["absent", "saved-only", "corrupt", "context", "pending"] as const) {
  test(`startup ${gate} cannot seed/promote or enable inspection`, async ({ page }) => {
    if (gate === "context") await page.addInitScript(() => { HTMLCanvasElement.prototype.getContext = () => null; });
    if (gate === "pending") await instrument(page, true);
    if (gate === "context" || gate === "pending") {
      await page.goto("/"); await expect(select(page)).toBeDisabled();
      if (gate === "context") {
        await expect(page.locator("#status")).toContainText("Error:");
        expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
      } else {
        await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending");
        const before = await nativeRows(page); const frozen = await pane(page);
        await select(page).dispatchEvent("change"); expect(await pane(page)).toEqual(frozen);
        await set(page, { settle: "yes" }); await expect(page.locator("#status")).toContainText("sample");
        expect(await nativeRows(page)).toEqual(before);
      }
      await expect(details(page)).toHaveText(""); return;
    }
    await open(page);
    if (gate !== "absent") {
      const row = revision(rich(), "saved-41", 41);
      await nativeRows(page, { revisions: [row], pointers: [{ documentId: BROWSER_DOCUMENT,
        saved: gate === "saved-only" ? { kind: "saved", documentId: BROWSER_DOCUMENT, revisionId: "saved-41", sequence: 41 } : null,
        draft: gate === "corrupt" ? { kind: "draft", documentId: BROWSER_DOCUMENT, revisionId: "missing", sequence: 42 } : null }] });
      await page.reload(); await expect(page.locator("#status")).toContainText(gate === "corrupt" ? "Error:" : "sample");
    }
    const before = await nativeRows(page); await expect(select(page)).toBeDisabled();
    await select(page).dispatchEvent("change"); await expect(details(page)).toHaveText("");
    expect(await nativeRows(page)).toEqual(before);
  });
}
