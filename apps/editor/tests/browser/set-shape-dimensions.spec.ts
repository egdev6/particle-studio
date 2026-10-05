/// <reference types="node" />
import { Buffer } from "node:buffer";
import { expect, test, type Page } from "@playwright/test";
import type { SceneDocumentV1 } from "@particle-studio/scene-document";
import { BROWSER_DOCUMENT, nativeRows } from "../raw-indexeddb-seed.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const hash = "sha256:431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460";
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const field = (page: Page, name: string) => page.getByLabel(name, { exact: true });
const select = (page: Page) => page.getByRole("combobox", { name: "Scene element", exact: true });
const details = (page: Page) => field(page, "Published element JSON");
const status = (page: Page, kind = "Dimension") => page.getByRole("status", { name: `${kind} status`, exact: true });
const actions = ["Import editable JSON", "Create blank scene", "Import PNG", "Add rectangle", "Apply position", "Apply dimensions"];
const forms = ["#json-import", "#png-import", "#rectangle-create", "#shape-position", "#shape-dimensions"];
const scene = (nested = false): SceneDocumentV1 => ({
  schemaVersion: 1, durationUs: 1_000_000, seed: 99, loop: false,
  playbackRange: { startUs: 500_000, endUs: 900_000 }, rootIds: nested ? ["root"] : ["shape", "root"],
  elements: [{ id: "root", type: "group", childrenIds: nested ? ["shape", "line", "text", "particle"] : ["line", "text", "particle"],
    transform: [1, 0, 0, 1, 30, 10], visible: true },
    { id: "shape", type: "shape", x: 16, y: 24, width: 0, height: -1, opacity: 1 },
    { id: "line", type: "line", x1: 190, y1: 110, x2: 200, y2: 120, opacity: 0.6 },
    { id: "text", type: "text", text: "authored", x: 190, y: 130, fontSize: 12, opacity: 1 },
    { id: "particle", type: "particle", count: 2, x: 190, y: 140, velocityX: 3, velocityY: 4,
      spread: 5, size: 6, opacity: 0.7, lifetimeSteps: 20 }],
  tracks: [{ elementId: "shape", property: "opacity", interpolation: "linear", easing: "linear",
    keyframes: [{ timeUs: 0, value: 0.25 }, { timeUs: 1_000_000, value: 0.75 }] }],
});
function revision(document: SceneDocumentV1, revisionId: string, sequence: number) {
  // Independent recursive key ordering; arrays preserve hierarchy and track order.
  const json = JSON.stringify(document, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  const canonicalBytes = Array.from(new TextEncoder().encode(json));
  return { documentId: BROWSER_DOCUMENT, revisionId, sequence, document, canonicalBytes,
    canonicalization: { identifier: "jcs-1", byteLength: canonicalBytes.length } };
}
type Rows = Awaited<ReturnType<typeof nativeRows>>;
function current(rows: Rows) {
  const pointer = (rows.pointers as { draft: { revisionId: string } }[])[0]!.draft;
  return (rows.revisions as ReturnType<typeof revision>[]).find((row) => row.documentId === BROWSER_DOCUMENT && row.revisionId === pointer.revisionId)!;
}
function ordered(rows: Rows) {
  return { ...rows, revisions: (rows.revisions as ReturnType<typeof revision>[]).slice().sort((a, b) => a.revisionId.localeCompare(b.revisionId)) };
}
async function publication(page: Page, before: Rows, pair: Record<string, number>) {
  const after = await nativeRows(page); const prior = current(before); const next = current(after);
  const document = structuredClone(prior.document); Object.assign(document.elements.find((element) => element.id === "shape")!, pair);
  expect(next.revisionId).not.toBe(prior.revisionId); expect(next).toEqual(revision(document, next.revisionId, prior.sequence + 1));
  expect(ordered(after)).toEqual(ordered({ ...before, revisions: [...before.revisions as unknown[], next],
    pointers: [{ documentId: BROWSER_DOCUMENT, saved: (before.pointers as { saved: unknown }[])[0]!.saved,
      draft: { kind: "draft", documentId: BROWSER_DOCUMENT, revisionId: next.revisionId, sequence: next.sequence } }] }));
  return after;
}
async function set(page: Page, values: Record<string, string>) {
  await page.locator("html").evaluate((root, values) => Object.assign((root as HTMLElement).dataset, values), values);
}
async function frame(page: Page) {
  return page.locator("#scene").evaluate((canvas: HTMLCanvasElement) =>
    Array.from(canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data));
}
async function samples(page: Page, nested: boolean) {
  // Interior and exterior points chosen from authored local bounds, independently
  // of the renderer: shape (16,24)+(30,10) only when nested; PNG (180,40).
  return page.locator("#scene").evaluate((canvas: HTMLCanvasElement, nested) =>
    [[20, 29], [55, 43], [59, 48]].map(([x, y]) => [x! + (nested ? 30 : 0), y! + (nested ? 10 : 0)])
      .concat([[181, 45]]).map(([x, y]) => Array.from(canvas.getContext("2d")!.getImageData(x!, y!, 1, 1).data)), nested);
}
async function pane(page: Page) {
  return page.locator("body").evaluate(() => document.body.innerHTML + JSON.stringify(
    Array.from(document.querySelectorAll("input,select,textarea"), (element) => (element as HTMLInputElement).value)));
}
async function handles(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event("inspect-bitmaps")));
  return JSON.parse((await page.locator("html").getAttribute("data-bitmaps")) ?? "[]") as { id: number; closes: number; useful: boolean }[];
}
async function ids(page: Page) {
  return JSON.parse((await page.locator("html").getAttribute("data-ids")) ?? "[]") as string[];
}
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const hit = (name: string) => {
      const root = document.documentElement; if (root.dataset.watch !== "yes") return;
      const counts = JSON.parse(root.dataset.effects ?? "{}") as Record<string, number>;
      counts[name] = (counts[name] ?? 0) + 1; root.dataset.effects = JSON.stringify(counts);
    };
    const uuid = crypto.randomUUID.bind(crypto); const allocated: string[] = [];
    crypto.randomUUID = () => { hit("uuid"); const id = uuid(); allocated.push(id); document.documentElement.dataset.ids = JSON.stringify(allocated); return id; };
    for (const name of ["get", "getAll", "put", "add", "delete", "clear"] as const) {
      const method = IDBObjectStore.prototype[name];
      Object.defineProperty(IDBObjectStore.prototype, name, { configurable: true, value: function (this: IDBObjectStore, ...args: unknown[]) {
        hit(`idb-${name}`); return Reflect.apply(method, this, args);
      } });
    }
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) { hit("database-open"); return open.apply(this, args); };
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) { hit("transaction"); return transaction.apply(this, args); };
    const lookup = Map.prototype.get;
    Map.prototype.get = function (key) { if (typeof key === "string" && key.startsWith("sha256:")) hit("asset-lookup"); return lookup.call(this, key); };
    const bytes = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () { hit("asset-bytes"); return bytes.call(this); };
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = (...args) => { hit("sha"); return digest(...args); };
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      const request = get.call(this, key); const root = document.documentElement;
      // Delay a genuine readonly result; never replace a readwrite CAS or its result.
      if (this.name !== "pointers" || this.transaction.mode !== "readonly" || root.dataset.hold !== "yes") return request;
      root.dataset.hold = "consumed";
      const intercept = (event: Event) => {
        event.stopImmediatePropagation(); request.removeEventListener("success", intercept, true); root.dataset.preparation = "pending";
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
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (document.documentElement.dataset.renderFault === "yes") throw new Error("Post-commit before-clear render fault");
      return clear.apply(this, args);
    };
    const decode = globalThis.createImageBitmap;
    const records: { id: number; closes: number; bitmap: ImageBitmap }[] = [];
    const update = () => {
      document.documentElement.dataset.bitmaps = JSON.stringify(records.map(({ id, closes, bitmap }) => {
        let useful = false;
        try { const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!; context.drawImage(bitmap, 0, 0);
          useful = context.getImageData(0, 0, 1, 1).data[3] === 255;
        } catch { /* A closed native bitmap is not drawable. */ }
        return { id, closes, useful };
      }));
    };
    window.addEventListener("inspect-bitmaps", update);
    globalThis.createImageBitmap = async (source: ImageBitmapSource) => {
      hit("decode"); const bitmap = await decode(source); const record = { id: records.length + 1, closes: 0, bitmap }; records.push(record);
      const close = bitmap.close.bind(bitmap); bitmap.close = () => { hit("close"); close(); record.closes += 1; update(); };
      update(); return bitmap;
    };
  });
}
async function open(page: Page) {
  await page.goto("/"); await expect(page.locator("#status")).toContainText("unpersisted sample");
}
async function publish(page: Page, document = scene()) {
  await field(page, "Editable JSON").fill(JSON.stringify(document)); await button(page, actions[0]!).click();
  await expect(page.locator("#status")).toContainText("Rendered imported draft"); expect(current(await nativeRows(page)).document).toEqual(document);
}
async function healthy(page: Page, nested = false) {
  await instrument(page); await open(page); await publish(page, scene(nested));
  await field(page, "PNG file").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: png });
  for (const [key, value] of Object.entries({ x: 180, y: 40, width: 8, height: 8 })) await field(page, `PNG ${key}`).fill(String(value));
  await button(page, "Import PNG").click(); await expect(page.locator("#png-status")).toContainText("PNG import complete");
  const rows = await nativeRows(page); const image = current(rows).document.elements.at(-1)!;
  const expected = scene(nested); expected.rootIds.push(image.id);
  expected.elements.push({ id: image.id, type: "image", x: 180, y: 40, width: 8, height: 8, opacity: 1,
    asset: { sha256: hash, mimeType: "image/png", byteLength: png.length, intrinsicWidth: 1, intrinsicHeight: 1 } });
  expect(current(rows).document).toEqual(expected);
  expect(rows.assets).toEqual([{ sha256: hash, mimeType: "image/png", byteLength: png.length, bytes: Array.from(png) }]);
  expect(await page.evaluate(async (bytes) => "sha256:" + Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))))
    .map((byte) => byte.toString(16).padStart(2, "0")).join(""), Array.from(png))).toBe(hash);
  expect(await samples(page, nested)).toEqual([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 255]]);
  await expect(select(page)).toBeEnabled(); await select(page).selectOption("shape");
  expect(JSON.parse((await details(page).textContent())!)).toEqual(expected.elements[1]);
}
async function edit(page: Page, kind = "Dimension") {
  await select(page).selectOption("shape");
  for (const [axis, value] of Object.entries(kind === "Dimension" ? { width: "40.5", height: "20.25" } : { X: "32.5", Y: "28.25" }))
    await field(page, `${kind} ${axis}`).fill(value);
}
const pair = (kind: string): Record<string, number> => kind === "Dimension" ? { width: 40.5, height: 20.25 } : { x: 32.5, y: 28.25 };
const action = (kind: string) => kind === "Dimension" ? "Apply dimensions" : "Apply position";

for (const nested of [false, true]) test(`production dimensions: full canonical history, useful PNG, equal pair and cold reload (nested=${nested})`, async ({ page }) => {
  await healthy(page, nested); // RED must reach healthy real import/PNG/inspection before missing widgets.
  await expect(field(page, "Dimension width")).toHaveValue("0"); await expect(field(page, "Dimension height")).toHaveValue("-1");
  await expect(status(page)).toBeVisible(); await expect(page.getByRole("status", { name: "", exact: true })).toHaveCount(1);
  const original = await nativeRows(page); const draft = (original.pointers as { draft: Record<string, unknown> }[])[0]!.draft;
  await nativeRows(page, { pointers: [{ documentId: BROWSER_DOCUMENT, draft, saved: { ...draft, kind: "saved" } }] });
  await page.reload(); await expect(page.locator("#status")).toContainText("restored draft"); // Load the legitimate full saved/draft prior.
  const before = await nativeRows(page); const retained = (await handles(page)).filter((record) => record.closes === 0);
  expect(retained).toHaveLength(1); expect(retained[0]!.useful).toBe(true);
  await edit(page); await field(page, "Editable JSON").fill("unsent invalid JSON"); const allocated = (await ids(page)).length;
  await button(page, "Apply dimensions").click(); await expect(status(page)).toContainText("complete");
  expect((await ids(page)).length).toBe(allocated + 2); const after = await publication(page, before, pair("Dimension"));
  const pixels = [[0, 0, 0, 128], [0, 0, 0, 128], [0, 0, 0, 0], [0, 0, 0, 255]];
  expect(await samples(page, nested)).toEqual(pixels); await expect(select(page)).toHaveValue(""); await expect(details(page)).toHaveText("");
  await expect(status(page, "Position")).toContainText("Select a published shape"); await expect(button(page, "Apply dimensions")).toBeDisabled();
  await edit(page); await button(page, "Apply dimensions").click(); await expect(status(page)).toContainText("complete");
  const equal = await publication(page, after, pair("Dimension")); expect(current(equal).canonicalBytes).toEqual(current(after).canonicalBytes);
  for (const record of await handles(page)) {
    const kept = retained.some((item) => item.id === record.id); expect(record.closes).toBe(kept ? 0 : 1); expect(record.useful).toBe(kept);
  }
  expect((await handles(page)).length).toBeGreaterThan(2);
  await page.reload(); await expect(page.locator("#status")).toContainText("restored draft");
  expect(await nativeRows(page)).toEqual(equal); expect(await samples(page, nested)).toEqual(pixels); await expect(select(page)).toHaveValue("");
});
test("all six variants, no selection, malformed pairs and mutable DOM cannot authorize or retarget dimensions", async ({ page }) => {
  await healthy(page); const before = await nativeRows(page); const pixels = await frame(page);
  await set(page, { watch: "yes", effects: "{}" });
  for (const element of current(before).document.elements) {
    await select(page).selectOption(element.id); expect(JSON.parse((await details(page).textContent())!)).toEqual(element);
    await expect(button(page, "Apply dimensions")).toBeEnabled({ enabled: element.type === "shape" });
    for (const axis of ["width", "height"]) await expect(field(page, `Dimension ${axis}`)).toBeEnabled({ enabled: element.type === "shape" });
    if (element.type !== "shape") {
      await expect(status(page)).toContainText("Other elements remain read-only");
      await page.locator("#shape-dimensions").dispatchEvent("submit");
    }
  }
  await select(page).selectOption(""); await expect(button(page, "Apply dimensions")).toBeDisabled();
  await button(page, "Apply dimensions").dispatchEvent("click"); await page.locator("#shape-dimensions").dispatchEvent("submit");
  await set(page, { watch: "no" }); expect(await page.locator("html").getAttribute("data-effects")).toBe("{}");
  expect(await nativeRows(page)).toEqual(before); await edit(page);
  // Number inputs sanitize malformed strings; text mode additionally proves the controller's raw-string guard.
  for (const axis of ["width", "height"]) await field(page, `Dimension ${axis}`).evaluate((input: HTMLInputElement) => { input.type = "text"; });
  for (const axis of ["width", "height"]) for (const invalid of ["", "   ", "NaN", "Infinity", "-Infinity", "garbage", "0", "-0", "-2"]) {
    await edit(page); await field(page, `Dimension ${axis}`).fill(invalid); await set(page, { watch: "yes", effects: "{}" });
    await page.locator("#shape-dimensions").dispatchEvent("submit"); await expect(status(page)).toContainText("finite");
    await expect(field(page, `Dimension ${axis}`)).toHaveValue(invalid);
    await set(page, { watch: "no" }); expect(await page.locator("html").getAttribute("data-effects")).toBe("{}");
    expect(await nativeRows(page)).toEqual(before); expect(await frame(page)).toEqual(pixels); await expect(select(page)).toHaveValue("shape");
  }
  await edit(page); await field(page, "Editable JSON").fill(JSON.stringify({ ...scene(), seed: 123 }));
  await select(page).evaluate((element: HTMLSelectElement) => { element.value = "root"; element.selectedOptions[0]!.textContent = "shape width=999"; });
  await button(page, "Apply dimensions").click(); await expect(status(page)).toContainText("complete"); await publication(page, before, pair("Dimension"));
  await publish(page); await expect(select(page)).toHaveValue(""); await expect(button(page, "Apply dimensions")).toBeDisabled();
  const replaced = await nativeRows(page); await page.locator("#shape-dimensions").dispatchEvent("submit"); expect(await nativeRows(page)).toEqual(replaced);
  await select(page).selectOption("shape"); await expect(field(page, "Dimension width")).toHaveValue("0");
});
for (const held of actions) test(`real ${held} hold excludes all six DOM actions and captures the original pair`, async ({ page }) => {
  if (held === "Create blank scene") { await instrument(page); await open(page); }
  else { await healthy(page); await edit(page); await field(page, "Position X").fill("32.5"); await field(page, "Position Y").fill("28.25"); }
  const before = await nativeRows(page); const detail = await details(page).textContent();
  await set(page, { hold: "yes" }); await button(page, held).click(); await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending");
  for (const name of actions) { await expect(button(page, name)).toBeDisabled(); await button(page, name).dispatchEvent("click"); }
  for (const form of forms) await page.locator(form).dispatchEvent("submit");
  await select(page).evaluate((element: HTMLSelectElement) => { element.value = "root"; element.dispatchEvent(new Event("change")); });
  for (const name of ["Dimension width", "Dimension height", "Position X", "Position Y"]) {
    await expect(field(page, name)).toBeDisabled();
    await field(page, name).evaluate((input: HTMLInputElement, mutate) => { if (mutate) input.value = "999"; input.dispatchEvent(new Event("input")); }, held !== "Create blank scene");
  }
  await field(page, "Editable JSON").evaluate((input: HTMLTextAreaElement) => { input.value = "late invalid JSON"; input.dispatchEvent(new Event("input")); });
  expect(await details(page).textContent()).toBe(detail); expect(await nativeRows(page)).toEqual(before);
  await set(page, { settle: "yes" }); await expect(select(page)).toBeEnabled(); await expect(select(page)).toHaveValue("");
  const after = await nativeRows(page); expect(after.revisions).toHaveLength((before.revisions as unknown[]).length + 1);
  if (held === "Import editable JSON") expect(current(after).document).toEqual(scene());
  if (held === "Create blank scene") expect(current(after).document).toEqual({ schemaVersion: 1, durationUs: 1_000_000, seed: 42, loop: true,
    playbackRange: { startUs: 0, endUs: 1_000_000 }, tracks: [], rootIds: ["root"], elements: [{ id: "root", type: "group", childrenIds: [] }] });
  for (const kind of ["Position", "Dimension"]) {
    await expect(status(page, kind)).toContainText(held === action(kind) ? "complete" : "Select a published shape");
    await expect(button(page, action(kind))).toBeDisabled();
    for (const axis of kind === "Dimension" ? ["width", "height"] : ["X", "Y"]) await expect(field(page, `${kind} ${axis}`)).toHaveValue("");
    await expect(page.locator(kind === "Dimension" ? "#shape-dimensions" : "#shape-position")).toHaveAttribute("aria-busy", "false");
    if (held === action(kind)) await publication(page, before, pair(kind));
  }
  await expect(page.getByRole("status", { name: "Element inspection status", exact: true })).toContainText(current(after).revisionId);
});
for (const during of [false, true]) test(`native CAS winner keeps rows, assets, local source and pixels without retry (during=${during})`, async ({ page, context }) => {
  await healthy(page); await edit(page); const pixels = await frame(page); const detail = await details(page).textContent(); const allocated = (await ids(page)).length;
  const retained = (await handles(page)).filter((record) => record.closes === 0);
  const other = await context.newPage(); await other.goto("/"); await expect(other.locator("#status")).toContainText("restored draft");
  if (during) { await set(page, { hold: "yes" }); await button(page, "Apply dimensions").click(); await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending"); }
  const candidate = during ? (await ids(page)).at(-1)! : null; if (during) expect((await ids(page)).length).toBe(allocated + 2);
  const winner = scene(); winner.seed = 123; await publish(other, winner); const winningRows = await nativeRows(other);
  if (during) await set(page, { settle: "yes" }); else await button(page, "Apply dimensions").click();
  await expect(status(page)).toContainText("refresh"); const captured = candidate ?? (await ids(page)).at(-1)!;
  expect((await ids(page)).length).toBe(allocated + 2); expect((winningRows.revisions as { revisionId: string }[]).some((row) => row.revisionId === captured)).toBe(false);
  expect(await nativeRows(page)).toEqual(winningRows); expect(await frame(page)).toEqual(pixels); expect(await details(page).textContent()).toBe(detail);
  for (const record of retained) expect((await handles(page)).find((item) => item.id === record.id)).toEqual(record);
  await expect(select(page)).toHaveValue("shape"); await expect(field(page, "Dimension width")).toHaveValue("40.5");
  await button(page, "Apply dimensions").click(); await expect(status(page)).toContainText("refresh"); expect(await nativeRows(page)).toEqual(winningRows);
  expect(await frame(page)).toEqual(pixels); await page.reload(); await expect(page.locator("#status")).toContainText("restored draft");
  await expect(select(page)).toHaveValue(""); expect(current(await nativeRows(page)).document).toEqual(winner); await other.close();
});
for (const kind of ["Position", "Dimension"]) test(`${kind} own rejection and success survive shared END; the other controller follows actual current`, async ({ page }) => {
  await healthy(page); await edit(page, kind); const before = await nativeRows(page); const pixels = await frame(page);
  await set(page, { hold: "yes", fault: "preparation", settle: "yes" }); await button(page, action(kind)).click();
  await expect(status(page, kind)).toContainText("failed"); await expect(select(page)).toHaveValue("shape");
  for (const [axis, value] of Object.entries(pair(kind))) await expect(field(page, `${kind} ${kind === "Position" ? axis.toUpperCase() : axis}`)).toHaveValue(String(value));
  expect(await nativeRows(page)).toEqual(before); expect(await frame(page)).toEqual(pixels);
  await set(page, { fault: "" }); await button(page, action(kind)).click(); await expect(status(page, kind)).toContainText("complete");
  const after = await publication(page, before, pair(kind)); await expect(select(page)).toHaveValue("");
  await expect(status(page, kind === "Position" ? "Dimension" : "Position")).toContainText("Select a published shape");
  await expect(page.getByRole("status", { name: "Element inspection status", exact: true })).toContainText(current(after).revisionId);
  await edit(page, kind === "Position" ? "Dimension" : "Position"); await button(page, action(kind === "Position" ? "Dimension" : "Position")).click();
  await expect(status(page, kind === "Position" ? "Dimension" : "Position")).toContainText("complete");
  await publication(page, after, pair(kind === "Position" ? "Dimension" : "Position"));
  // Either edit order ends at (32.5,28.25), width 40.5/height 20.25, opacity 0.5.
  expect(await page.locator("#scene").evaluate((canvas: HTMLCanvasElement) => [[40, 35], [20, 29], [181, 45]]
    .map(([x, y]) => Array.from(canvas.getContext("2d")!.getImageData(x!, y!, 1, 1).data))))
    .toEqual([[0, 0, 0, 128], [0, 0, 0, 0], [0, 0, 0, 255]]);
});
for (const kind of ["Position", "Dimension"]) test(`${kind} committed render warning survives shared END without rollback or retry`, async ({ page }) => {
  await healthy(page); await edit(page, kind); const before = await nativeRows(page); const pixels = await frame(page);
  await set(page, { renderFault: "yes" }); await button(page, action(kind)).click();
  await expect(status(page, kind)).toContainText("published, but rendering failed"); const after = await publication(page, before, pair(kind));
  expect(await frame(page)).toEqual(pixels); await expect(select(page)).toHaveValue(""); await expect(status(page, kind)).not.toContainText("try again");
  await expect(status(page, kind)).not.toContainText("rolled back"); await expect(status(page, kind === "Dimension" ? "Position" : "Dimension")).toContainText("Select a published shape");
  await select(page).selectOption("shape"); expect(JSON.parse((await details(page).textContent())!)).toEqual(current(after).document.elements[1]);
});
for (const reject of [false, true]) test(`pagehide freezes both controllers before inspector clear, then releases each bitmap once (reject=${reject})`, async ({ page, context }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await healthy(page); await edit(page); const before = await nativeRows(page); const pixels = await frame(page);
  const retained = (await handles(page)).filter((record) => record.closes === 0); expect(retained).toHaveLength(1);
  const other = reject ? await context.newPage() : null;
  if (other) { await other.goto("/"); await expect(other.locator("#status")).toContainText("restored draft"); }
  await set(page, { hold: "yes", fault: reject ? "preparation" : "" }); await button(page, "Apply dimensions").click();
  await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending");
  const values = await page.locator("#shape-position input,#shape-dimensions input").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  const statuses = [await status(page).textContent(), await status(page, "Position").textContent()];
  await page.evaluate(() => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pagehide")); });
  expect(await page.locator("#shape-position input,#shape-dimensions input").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual(values);
  expect([await status(page).textContent(), await status(page, "Position").textContent()]).toEqual(statuses);
  const frozen = await pane(page); for (const record of retained) expect((await handles(page)).find((item) => item.id === record.id)).toEqual(record);
  let winningRows = before;
  if (other) { const winner = scene(); winner.seed = 456; await publish(other, winner); winningRows = await nativeRows(other); }
  await set(page, { settle: "yes" }); await expect.poll(async () => (await handles(page)).every((record) => record.closes === 1 && !record.useful)).toBe(true);
  if (reject) expect(await nativeRows(page)).toEqual(winningRows); else await publication(page, before, pair("Dimension"));
  for (const name of actions) await button(page, name).dispatchEvent("click");
  for (const form of forms) await page.locator(form).dispatchEvent("submit"); await select(page).dispatchEvent("change");
  expect(await pane(page)).toBe(frozen); expect(await frame(page)).toEqual(pixels); expect(errors).toEqual([]);
  await other?.close();
});
