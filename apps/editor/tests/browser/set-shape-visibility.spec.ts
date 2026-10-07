/// <reference types="node" />
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { SceneDocumentV1 } from "@particle-studio/scene-document";
import { BROWSER_DOCUMENT, nativeRows } from "../raw-indexeddb-seed.js";

// Genuine 1x1 PNG bytes reused by the sibling colour/opacity production specs.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const hash = `sha256:${createHash("sha256").update(png).digest("hex")}`;
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const field = (page: Page, name: string) => page.getByLabel(name, { exact: true });
const select = (page: Page) => page.getByRole("combobox", { name: "Scene element", exact: true });
const checkbox = (page: Page) => page.getByRole("checkbox", { name: "Shape visible", exact: true });
const status = (page: Page) => page.getByRole("status", { name: "Visibility status", exact: true });
const details = (page: Page) => field(page, "Published element JSON");
const ids = ["#shape-visibility", "#shape-visible", "#apply-visibility", "#visibility-status"];

// Root scene mirrors the sealed colour/opacity fixture: one root group, one shape,
// and line/text/particle siblings so non-shape read-only guards stay meaningful.
const scene = (nested = false, hidden = false, tracked = false): SceneDocumentV1 => ({
  schemaVersion: 1, durationUs: 1_000_000, seed: 99, loop: false,
  playbackRange: { startUs: 500_000, endUs: 900_000 }, rootIds: nested ? ["root"] : ["shape", "root"],
  elements: [
    { id: "root", type: "group", childrenIds: nested ? ["shape", "line", "text", "particle"] : ["line", "text", "particle"],
      transform: [1, 0, 0, 1, 30, 10], visible: !hidden },
    { id: "shape", type: "shape", x: 16, y: 24, width: 40, height: 20, opacity: 1 },
    { id: "line", type: "line", x1: 190, y1: 110, x2: 200, y2: 120, opacity: 0.6 },
    { id: "text", type: "text", text: "authored", x: 190, y: 130, fontSize: 12, opacity: 1 },
    { id: "particle", type: "particle", count: 2, x: 190, y: 140, velocityX: 3, velocityY: 4,
      spread: 5, size: 6, opacity: 0.7, lifetimeSteps: 20 }],
  tracks: tracked ? [{ elementId: "shape", property: "opacity", interpolation: "linear", easing: "linear",
    keyframes: [{ timeUs: 0, value: 0.25 }, { timeUs: 1_000_000, value: 0.75 }] }] : [],
});
function revision(document: SceneDocumentV1, revisionId: string, sequence: number) {
  // Independent recursive key ordering; preserve all semantic array order.
  const json = JSON.stringify(document, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  const canonicalBytes = Array.from(new TextEncoder().encode(json));
  return { documentId: BROWSER_DOCUMENT, revisionId, sequence, document: JSON.parse(json) as SceneDocumentV1, canonicalBytes,
    canonicalization: { identifier: "jcs-1", byteLength: canonicalBytes.length } };
}
type Rows = Awaited<ReturnType<typeof nativeRows>>;
function current(rows: Rows) {
  const pointer = (rows.pointers as { draft: { revisionId: string } }[])[0]!.draft;
  return (rows.revisions as ReturnType<typeof revision>[])
    .find((row) => row.documentId === BROWSER_DOCUMENT && row.revisionId === pointer.revisionId)!;
}
function ordered(rows: Rows) {
  return { ...rows, revisions: (rows.revisions as ReturnType<typeof revision>[]).slice()
    .sort((a, b) => a.revisionId.localeCompare(b.revisionId)) };
}
// Full canonical oracle: only the shape gains the authored flag; every other field,
// the parent history, saved pointer and asset bytes stay byte-identical.
async function publication(page: Page, before: Rows, visible: boolean) {
  const after = await nativeRows(page); const prior = current(before); const next = current(after);
  const document = structuredClone(prior.document);
  (document.elements.find((element) => element.id === "shape") as { visible?: boolean }).visible = visible;
  const expected = revision(document, next.revisionId, prior.sequence + 1);
  expect(next.revisionId).not.toBe(prior.revisionId);
  expect(next).toEqual(expected);
  expect(next.canonicalBytes).toEqual(expected.canonicalBytes);
  expect(after.assets).toEqual(before.assets);
  for (const row of before.revisions as unknown[]) expect(after.revisions).toContainEqual(row);
  expect(ordered(after)).toEqual(ordered({ ...before, revisions: [...before.revisions as unknown[], next],
    pointers: [{ documentId: BROWSER_DOCUMENT, saved: (before.pointers as { saved: unknown }[])[0]!.saved,
      draft: { kind: "draft", documentId: BROWSER_DOCUMENT, revisionId: next.revisionId, sequence: next.sequence } }] }));
  return after;
}
async function frame(page: Page) {
  return page.locator("#scene").evaluate((canvas: HTMLCanvasElement) =>
    Array.from(canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data));
}
// Centroid inside the shape plus one genuine PNG sample that never overlaps it.
async function pixels(page: Page, nested: boolean, alpha: number) {
  expect(await page.locator("#scene").evaluate((canvas: HTMLCanvasElement, nested) =>
    [[nested ? 50 : 20, nested ? 40 : 30], [181, 45]].map(([x, y]) =>
      Array.from(canvas.getContext("2d")!.getImageData(x!, y!, 1, 1).data)), nested))
    .toEqual([[0, 0, 0, alpha], [0, 0, 0, 255]]);
}
async function open(page: Page) {
  await page.goto("/"); await expect(page.locator("#status")).toContainText("unpersisted sample");
}
async function publish(page: Page, document = scene()) {
  await field(page, "Editable JSON").fill(JSON.stringify(document));
  await button(page, "Import editable JSON").click();
  await expect(page.locator("#status")).toContainText("Rendered imported draft");
  expect(current(await nativeRows(page)).document).toEqual(document);
}
async function healthy(page: Page, nested = false, hidden = false, tracked = false) {
  await open(page); await publish(page, scene(nested, hidden, tracked));
  await field(page, "PNG file").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: png });
  for (const [key, value] of Object.entries({ x: 180, y: 40, width: 8, height: 8 })) await field(page, `PNG ${key}`).fill(String(value));
  await button(page, "Import PNG").click();
  await expect(page.locator("#png-status")).toContainText("PNG import complete");
  const rows = await nativeRows(page); const image = current(rows).document.elements.at(-1)!;
  expect(image).toEqual({ id: image.id, type: "image", x: 180, y: 40, width: 8, height: 8, opacity: 1,
    asset: { sha256: hash, mimeType: "image/png", byteLength: png.length, intrinsicWidth: 1, intrinsicHeight: 1 } });
  expect(rows.assets).toEqual([{ sha256: hash, mimeType: "image/png", byteLength: png.length, bytes: Array.from(png) }]);
  await expect(select(page)).toBeEnabled();
}
// Public reload makes saved/draft history the genuine prior source used by each case.
async function savedPrior(page: Page) {
  const original = await nativeRows(page);
  const draft = (original.pointers as { draft: Record<string, unknown> }[])[0]!.draft;
  await nativeRows(page, { pointers: [{ documentId: BROWSER_DOCUMENT, draft, saved: { ...draft, kind: "saved" } }] });
  await page.reload(); await expect(page.locator("#status")).toContainText("restored draft");
  return nativeRows(page);
}
for (const nested of [false, true]) test(`production visibility: root/nested shape, full history, hidden render, reselect and durable reload (nested=${nested})`, async ({ page }) => {
  await healthy(page, nested); // Parent RED must reach the real frame and native source before these missing affordances.
  for (const id of ids) await expect(page.locator(id)).toHaveCount(1);
  await expect(checkbox(page)).toHaveCount(1); await expect(button(page, "Apply visibility")).toHaveCount(1);
  await expect(status(page)).toHaveCount(1);
  const before = await savedPrior(page);
  const authored = current(before).document.elements.find((element) => element.id === "shape")!;
  expect(authored).not.toHaveProperty("visible");
  await select(page).selectOption("shape");
  expect(await nativeRows(page)).toEqual(before); expect(JSON.parse((await details(page).textContent())!)).toEqual(authored);
  await expect(checkbox(page)).toBeChecked(); await expect(checkbox(page)).toBeEnabled();
  await expect(button(page, "Apply visibility")).toBeEnabled();
  await pixels(page, nested, 255);
  await checkbox(page).uncheck(); await button(page, "Apply visibility").click();
  await expect(status(page)).toContainText("complete");
  const hidden = await publication(page, before, false);
  await expect(select(page)).toHaveValue(""); await expect(checkbox(page)).toBeDisabled();
  await expect(button(page, "Apply visibility")).toBeDisabled();
  await pixels(page, nested, 0);
  await page.reload(); await expect(page.locator("#status")).toContainText("restored draft");
  expect(await nativeRows(page)).toEqual(hidden); await pixels(page, nested, 0); // Reload restores the same publication.
  await select(page).selectOption("shape"); await expect(checkbox(page)).not.toBeChecked();
  expect(current(hidden).document.elements.find((element) => element.id === "shape")).toHaveProperty("visible", false);
  await checkbox(page).check(); await button(page, "Apply visibility").click(); await expect(status(page)).toContainText("complete");
  const shown = await publication(page, hidden, true);
  await pixels(page, nested, 255);
  await select(page).selectOption("shape"); await expect(checkbox(page)).toBeChecked();
  await button(page, "Apply visibility").click(); await expect(status(page)).toContainText("complete");
  const equal = await publication(page, shown, true); // An equal explicit flag still publishes.
  await page.reload(); await expect(page.locator("#status")).toContainText("restored draft");
  expect(await nativeRows(page)).toEqual(equal); await pixels(page, nested, 255);
  await select(page).selectOption("shape"); await expect(checkbox(page)).toBeChecked();
});
test("production visibility: a hidden ancestor keeps the authored default and publishes only the shape", async ({ page }) => {
  await healthy(page, true, true, true);
  const before = await savedPrior(page);
  await select(page).selectOption("shape");
  await expect(checkbox(page)).toBeChecked(); await expect(checkbox(page)).toBeEnabled();
  await expect(button(page, "Apply visibility")).toBeEnabled();
  await expect(status(page)).toContainText("hidden ancestor");
  await pixels(page, true, 0);
  const group = current(before).document.elements.find((element) => element.id === "root")!;
  expect(group).toHaveProperty("visible", false);
  await button(page, "Apply visibility").click(); await expect(status(page)).toContainText("complete");
  const after = await publication(page, before, true);
  await expect(select(page)).toHaveValue("");
  expect(current(after).document.elements.find((element) => element.id === "root")).toEqual(group);
  expect(current(after).document.tracks).toEqual(current(before).document.tracks);
  await pixels(page, true, 0); // Explicit local true never draws through a hidden ancestor.
  await select(page).selectOption("shape"); await expect(checkbox(page)).toBeChecked();
  expect(current(after).document.elements.find((element) => element.id === "shape")).toHaveProperty("visible", true);
});
test("production visibility: only shapes stay editable and forced empty submissions change nothing", async ({ page }) => {
  await healthy(page);
  const before = await nativeRows(page); const priorFrame = await frame(page);
  for (const element of current(before).document.elements) {
    await select(page).selectOption(element.id);
    expect(JSON.parse((await details(page).textContent())!)).toEqual(element);
    await expect(checkbox(page)).toBeEnabled({ enabled: element.type === "shape" });
    await expect(button(page, "Apply visibility")).toBeEnabled({ enabled: element.type === "shape" });
    if (element.type !== "shape") await expect(status(page)).toContainText("Select a published shape");
  }
  expect(await nativeRows(page)).toEqual(before);
  await select(page).selectOption(""); await expect(checkbox(page)).toBeDisabled();
  await expect(button(page, "Apply visibility")).toBeDisabled();
  await page.locator("#apply-visibility").dispatchEvent("click");
  await page.locator("#shape-visibility").dispatchEvent("submit");
  expect(await nativeRows(page)).toEqual(before); expect(await frame(page)).toEqual(priorFrame);
});
test("production visibility: the startup unpersisted sample exposes no visibility authority", async ({ page }) => {
  await open(page);
  await expect(checkbox(page)).toBeDisabled(); await expect(button(page, "Apply visibility")).toBeDisabled();
});

// --- Unit 6 shared native triangulation instrumentation -------------------------------------------
// Appended only; the frozen 182-line prefix above is untouched. These helpers read the genuine
// IndexedDB rail through the real readonly pointers.get preparation and never wrap the conditional
// readwrite CAS. The value/checked disposal hooks are staged here for the later pagehide unit and are
// inert for the held-origin, toggle-without-Apply and cross-feedback cases below.
const origins = ["Import editable JSON", "Create blank scene", "Import PNG", "Add rectangle",
  "Apply position", "Apply dimensions", "Apply opacity", "Apply fill color", "Apply visibility"];
const shifts: Record<string, Record<string, string>> = {
  "Apply position": { "Position X": "32.5", "Position Y": "28.25" },
  "Apply dimensions": { "Dimension width": "40.5", "Dimension height": "20.25" },
  "Apply opacity": { "Shape opacity": "0.5" },
  "Apply fill color": { "Shape fill color": "#AbC123" },
};
const patches: Record<string, Record<string, unknown>> = {
  "Apply position": { x: 32.5, y: 28.25 },
  "Apply dimensions": { width: 40.5, height: 20.25 },
  "Apply opacity": { opacity: 0.5 },
  "Apply fill color": { fillColor: "#AbC123" },
  "Apply visibility": { visible: false },
};
const controlForms = ["#json-import", "#png-import", "#rectangle-create", "#shape-position",
  "#shape-dimensions", "#shape-opacity", "#shape-fill-color", "#shape-visibility"];
// The sealed empty-scene fixture the real "Create blank scene" button publishes at startup.
const blankScene: SceneDocumentV1 = { schemaVersion: 1, durationUs: 1_000_000, seed: 42, loop: true,
  playbackRange: { startUs: 0, endUs: 1_000_000 }, tracks: [], rootIds: ["root"],
  elements: [{ id: "root", type: "group", childrenIds: [] }] };
async function set(page: Page, values: Record<string, string>) {
  await page.locator("html").evaluate((root, values) => Object.assign((root as HTMLElement).dataset, values), values);
}
// Control-panel snapshot: identity, value and checked primitive; never the full page innerHTML that
// also carries the instrumentation dataset attributes.
async function pane(page: Page) {
  return page.locator("body").evaluate(() => JSON.stringify(Array.from(document.querySelectorAll("input,select,textarea"),
    (element) => ({ id: (element as HTMLInputElement).id, value: (element as HTMLInputElement).value,
      checked: (element as HTMLInputElement).checked }))));
}
async function handles(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event("inspect-bitmaps")));
  return JSON.parse((await page.locator("html").getAttribute("data-bitmaps")) ?? "[]") as { id: number; closes: number; useful: boolean }[];
}
// UUID ledger reads the data-ids ledger; the existing `ids` array above stays the locator label list.
async function uuids(page: Page) {
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
    const bytes = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () { hit("asset-bytes"); return bytes.call(this); };
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = (...args) => { hit("sha"); return digest(...args); };
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      const request = get.call(this, key); const root = document.documentElement;
      // Hold only the genuine readonly preparation; the conditional rw CAS is never wrapped.
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
      hit("render");
      if (document.documentElement.dataset.renderFault === "yes") throw new Error("Post-commit before-clear render fault");
      return clear.apply(this, args);
    };
    const value = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
    Object.defineProperty(HTMLInputElement.prototype, "value", { ...value, set(this: HTMLInputElement, next: string) {
      if (document.documentElement.dataset.disposalGuard === "yes" &&
        this.closest("#shape-position,#shape-dimensions,#shape-opacity,#shape-fill-color,#shape-visibility")) {
        document.documentElement.dataset.lateController = this.id; throw new Error(`Controller active after pagehide: ${this.id}`);
      }
      value.set!.call(this, next);
    } });
    const checked = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")!;
    Object.defineProperty(HTMLInputElement.prototype, "checked", { ...checked, set(this: HTMLInputElement, next: boolean) {
      if (document.documentElement.dataset.disposalGuard === "yes" && this.id === "shape-visible") {
        document.documentElement.dataset.lateChecked = "yes"; throw new Error("Visibility controller active after pagehide");
      }
      checked.set!.call(this, next);
    } });
    const decode = globalThis.createImageBitmap;
    const records: { id: number; closes: number; bitmap: ImageBitmap }[] = [];
    const update = () => {
      document.documentElement.dataset.bitmaps = JSON.stringify(records.map(({ id, closes, bitmap }) => {
        let useful = false;
        try { const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!; context.drawImage(bitmap, 0, 0);
          useful = context.getImageData(0, 0, 1, 1).data[3] === 255;
        } catch { /* Closed native handles cannot be drawn. */ }
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
// General whole-row oracle: independent canonical revision, unchanged asset store, retained prior
// history and the exact saved+draft pointer pair. Reuses the frozen current/ordered/revision helpers.
async function published(page: Page, before: Rows, document: SceneDocumentV1) {
  const after = await nativeRows(page); const prior = current(before); const next = current(after);
  const expected = revision(document, next.revisionId, prior.sequence + 1);
  expect(next.revisionId).not.toBe(prior.revisionId); expect(next).toEqual(expected); expect(next.canonicalBytes).toEqual(expected.canonicalBytes);
  expect(after.assets).toEqual(before.assets);
  for (const row of before.revisions as unknown[]) expect(after.revisions).toContainEqual(row);
  expect(ordered(after)).toEqual(ordered({ ...before, revisions: [...before.revisions as unknown[], next],
    pointers: [{ documentId: BROWSER_DOCUMENT, saved: (before.pointers as { saved: unknown }[])[0]!.saved,
      draft: { kind: "draft", documentId: BROWSER_DOCUMENT, revisionId: next.revisionId, sequence: next.sequence } }] }));
  return after;
}

// --- Matrix A: every genuine origin held during its real readonly preparation ---------------------
for (const held of origins) test(`production visibility held origin ${held} blocks all nine actions, captures intent and publishes exactly its own change`, async ({ page }) => {
  const blank = held === "Create blank scene";
  if (blank) { await instrument(page); await open(page); }
  else {
    await instrument(page); await healthy(page); await savedPrior(page); await select(page).selectOption("shape");
    for (const [name, value] of Object.entries(shifts[held] ?? {})) await field(page, name).fill(value);
    if (held === "Apply visibility") await checkbox(page).uncheck();
    if (held === "Import editable JSON") await field(page, "Editable JSON").fill(JSON.stringify({ ...scene(), seed: 123 }));
    if (held === "Import PNG") {
      // savedPrior reload clears the file input and geometry; stage a genuine second import.
      await field(page, "PNG file").setInputFiles({ name: "second.png", mimeType: "image/png", buffer: png });
      for (const [key, value] of Object.entries({ x: 180, y: 40, width: 8, height: 8 })) await field(page, `PNG ${key}`).fill(String(value));
      await expect(button(page, held)).toBeEnabled();
    }
  }
  // Genuine prior source before the held origin begins; the blank startup legitimately has no draft pointer.
  const before = await nativeRows(page); const detail = await details(page).textContent();
  const priorFrame = await frame(page); const allocated = (await uuids(page)).length;
  const checkedDraft = await checkbox(page).isChecked();
  await set(page, { hold: "yes" });
  await button(page, held).evaluate((target) => {
    (target as HTMLButtonElement).click();
    for (const other of document.querySelectorAll("button")) other.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    for (const form of document.forms) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const combo = document.querySelector<HTMLSelectElement>("#scene-element")!;
    combo.value = "root"; combo.dispatchEvent(new Event("change", { bubbles: true }));
    for (const input of document.querySelectorAll("input,textarea")) input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending");
  await set(page, { watch: "yes", effects: "{}" });
  for (const name of origins) { await expect(button(page, name)).toBeDisabled(); await button(page, name).dispatchEvent("click"); }
  for (const form of controlForms) await page.locator(form).dispatchEvent("submit");
  await expect(select(page)).toBeDisabled(); await expect(checkbox(page)).toBeDisabled();
  expect(await checkbox(page).isChecked()).toBe(checkedDraft);
  expect(await page.locator("input,textarea,select").evaluateAll((elements) => elements.every((element) => (element as unknown as HTMLInputElement).disabled))).toBe(true);
  for (const input of await page.locator("input,textarea").all()) await input.dispatchEvent("input");
  // Effects watch must be read and cleared before any native oracle opens its own DB connection.
  await set(page, { watch: "no" }); expect(await page.locator("html").getAttribute("data-effects")).toBe("{}");
  expect(await nativeRows(page)).toEqual(before); expect(await frame(page)).toEqual(priorFrame);
  expect(await details(page).textContent()).toBe(detail); await expect(select(page)).toHaveValue(blank ? "" : "shape");
  await set(page, { settle: "yes" }); await expect(select(page)).toBeEnabled(); await expect(select(page)).toHaveValue("");
  const rows = await nativeRows(page); expect(rows.revisions).toHaveLength((before.revisions as unknown[]).length + 1);
  if (blank) {
    // Vacuous blank authority: no prior current, so the whole first canonical draft row is checked directly.
    expect(current(rows)).toEqual(revision(blankScene, current(rows).revisionId, 1)); expect(rows.assets).toEqual([]);
    expect(rows.pointers).toEqual([{ documentId: BROWSER_DOCUMENT, saved: null,
      draft: { kind: "draft", documentId: BROWSER_DOCUMENT, revisionId: current(rows).revisionId, sequence: 1 } }]);
  } else if (held === "Import editable JSON") {
    await published(page, before, { ...scene(), seed: 123 } as SceneDocumentV1);
  } else if (held === "Import PNG" || held === "Add rectangle") {
    const appended = current(rows).document.elements.at(-1)!; const expected = structuredClone(current(before).document);
    expected.rootIds.push(appended.id);
    expected.elements.push(held === "Import PNG"
      ? { id: appended.id, type: "image", x: 180, y: 40, width: 8, height: 8, opacity: 1,
        asset: { sha256: hash, mimeType: "image/png", byteLength: png.length, intrinsicWidth: 1, intrinsicHeight: 1 } }
      : { id: appended.id, type: "shape", x: 16, y: 24, width: 120, height: 80, opacity: 1 });
    await published(page, before, expected);
  } else {
    const expected = structuredClone(current(before).document);
    Object.assign(expected.elements.find((element) => element.id === "shape")!, patches[held] ?? {});
    await published(page, before, expected);
  }
  if (held === "Apply visibility") expect((await uuids(page)).length).toBe(allocated + 2);
  // Any genuine publication clears the selection epoch; visibility and sibling editors stay guarded.
  await expect(select(page)).toHaveValue(""); await expect(checkbox(page)).toBeDisabled();
  await expect(button(page, "Apply visibility")).toBeDisabled();
  // The origin's own editor keeps its completion line; every foreign editor returns to guidance.
  const originKind = held === "Apply position" ? "Position" : held === "Apply dimensions" ? "Dimension"
    : held === "Apply opacity" ? "Opacity" : held === "Apply fill color" ? "Fill color" : null;
  for (const kind of ["Position", "Dimension", "Opacity", "Fill color"]) {
    if (kind === originKind) continue;
    await expect(page.getByRole("status", { name: `${kind} status`, exact: true })).toContainText("Select a published shape");
  }
  if (originKind) await expect(page.getByRole("status", { name: `${originKind} status`, exact: true })).toContainText("complete");
});

// --- Case B: explicit toggle without Apply stays local, then a held own apply commits once --------
test("production visibility: unchecking without Apply publishes nothing and a held own apply commits exactly once", async ({ page }) => {
  await instrument(page); await healthy(page); const before = await savedPrior(page); await select(page).selectOption("shape");
  const priorFrame = await frame(page); const allocated = (await uuids(page)).length;
  const shapeBefore = current(before).document.elements.find((element) => element.id === "shape")!;
  expect(shapeBefore).not.toHaveProperty("visible"); await expect(checkbox(page)).toBeChecked();
  const panel = JSON.parse(await pane(page)) as { id: string; checked: boolean }[];
  expect(panel.find((entry) => entry.id === "shape-visible")!.checked).toBe(true);
  await checkbox(page).uncheck(); // No Apply yet: the authored flag must stay absent and nothing persists.
  expect((JSON.parse(await pane(page)) as { id: string; checked: boolean }[]).find((entry) => entry.id === "shape-visible")!.checked).toBe(false);
  expect(await nativeRows(page)).toEqual(before); expect(await frame(page)).toEqual(priorFrame);
  expect((await uuids(page)).length).toBe(allocated); expect(await details(page).textContent()).not.toBe("");
  expect(current(await nativeRows(page)).document.elements.find((element) => element.id === "shape")).not.toHaveProperty("visible");
  await set(page, { hold: "yes" });
  await button(page, "Apply visibility").evaluate((target) => {
    (target as HTMLButtonElement).click();
    for (const other of document.querySelectorAll("button")) other.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    for (const form of document.forms) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const combo = document.querySelector<HTMLSelectElement>("#scene-element")!;
    combo.value = "root"; combo.dispatchEvent(new Event("change", { bubbles: true }));
    for (const input of document.querySelectorAll("input,textarea")) input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending");
  await set(page, { watch: "yes", effects: "{}" });
  for (const name of origins) { await expect(button(page, name)).toBeDisabled(); await button(page, name).dispatchEvent("click"); }
  for (const form of controlForms) await page.locator(form).dispatchEvent("submit");
  await page.locator("#shape-visible").dispatchEvent("click");
  await set(page, { watch: "no" }); expect(await page.locator("html").getAttribute("data-effects")).toBe("{}");
  expect(await nativeRows(page)).toEqual(before); expect(await frame(page)).toEqual(priorFrame);
  await set(page, { settle: "yes" }); await expect(select(page)).toHaveValue(""); await expect(checkbox(page)).toBeDisabled();
  await publication(page, before, false); expect((await uuids(page)).length).toBe(allocated + 2);
  await expect(status(page)).toContainText("complete");
});

// --- Case F: own settlement retains visibility feedback while the inspector clears siblings -------
test("production visibility: own settlement retains its feedback while the cross-controller refresh clears details and re-selection prefills locally", async ({ page }) => {
  await instrument(page); await healthy(page); const before = await savedPrior(page); await select(page).selectOption("shape");
  // A same-source failure is retained before the genuine publication (no source change, no sibling churn).
  await set(page, { hold: "yes", fault: "preparation", settle: "yes" }); await button(page, "Apply visibility").click();
  await expect(status(page)).toContainText("failed"); await expect(select(page)).toHaveValue("shape");
  await expect(checkbox(page)).toBeChecked(); expect(await nativeRows(page)).toEqual(before);
  await set(page, { hold: "", fault: "", settle: "" });
  // Own genuine publication: the inspector consumes the new source while visibility keeps its completion.
  await checkbox(page).uncheck(); await button(page, "Apply visibility").click(); await expect(status(page)).toContainText("complete");
  const after = await publication(page, before, false);
  await expect(select(page)).toHaveValue(""); expect(await details(page).textContent()).toBe("");
  await expect(page.getByRole("status", { name: "Element inspection status", exact: true })).toContainText(current(after).revisionId);
  for (const name of ["Position status", "Dimension status", "Opacity status", "Fill color status"]) {
    await expect(page.getByRole("status", { name, exact: true })).toContainText(/Select a published shape|Create a scene or import/i);
  }
  await expect(status(page)).toContainText("complete");
  // Re-selecting the new source prefills the authored false locally; no flag is injected or removed.
  await select(page).selectOption("shape"); await expect(checkbox(page)).not.toBeChecked();
  expect(current(after).document.elements.find((element) => element.id === "shape")).toHaveProperty("visible", false);
});
