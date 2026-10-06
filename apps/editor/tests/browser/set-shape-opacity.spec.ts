/// <reference types="node" />
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { SceneDocumentV1 } from "@particle-studio/scene-document";
import { BROWSER_DOCUMENT, nativeRows } from "../raw-indexeddb-seed.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const hash = `sha256:${createHash("sha256").update(png).digest("hex")}`;
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const field = (page: Page, name: string) => page.getByLabel(name, { exact: true });
const select = (page: Page) => page.getByRole("combobox", { name: "Scene element", exact: true });
const details = (page: Page) => field(page, "Published element JSON");
const status = (page: Page, kind = "Opacity") => page.getByRole("status", { name: `${kind} status`, exact: true });
const actions = ["Import editable JSON", "Create blank scene", "Import PNG", "Add rectangle", "Apply position", "Apply dimensions", "Apply opacity"];
const forms = ["#json-import", "#png-import", "#rectangle-create", "#shape-position", "#shape-dimensions", "#shape-opacity"];
const edits = ["Position", "Dimension", "Opacity"] as const;
const inputs = { Position: { "Position X": "32.5", "Position Y": "28.25" },
  Dimension: { "Dimension width": "40.5", "Dimension height": "20.25" }, Opacity: { "Shape opacity": "0.5" } };
const patch = { Position: { x: 32.5, y: 28.25 }, Dimension: { width: 40.5, height: 20.25 }, Opacity: { opacity: 0.5 } };
const action = (kind: typeof edits[number]) => kind === "Dimension" ? "Apply dimensions" : `Apply ${kind.toLowerCase()}`;
const scene = (nested = false, opacity = 1, tracked = false): SceneDocumentV1 => ({
  schemaVersion: 1, durationUs: 1_000_000, seed: 99, loop: false,
  playbackRange: { startUs: 500_000, endUs: 900_000 }, rootIds: nested ? ["root"] : ["shape", "root"],
  elements: [{ id: "root", type: "group", childrenIds: nested ? ["shape", "line", "text", "particle"] : ["line", "text", "particle"],
    transform: [1, 0, 0, 1, 30, 10], visible: true },
    { id: "shape", type: "shape", x: 16, y: 24, width: 40, height: 20, opacity },
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
  return (rows.revisions as ReturnType<typeof revision>[]).find((row) => row.documentId === BROWSER_DOCUMENT && row.revisionId === pointer.revisionId)!;
}
function ordered(rows: Rows) {
  return { ...rows, revisions: (rows.revisions as ReturnType<typeof revision>[]).slice().sort((a, b) => a.revisionId.localeCompare(b.revisionId)) };
}
async function publication(page: Page, before: Rows, changes: Record<string, number>) {
  const after = await nativeRows(page); const prior = current(before); const next = current(after);
  const document = structuredClone(prior.document); Object.assign(document.elements.find((element) => element.id === "shape")!, changes);
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
async function pixels(page: Page, nested: boolean, alpha: number) {
  expect(await page.locator("#scene").evaluate((canvas: HTMLCanvasElement, nested) =>
    [[nested ? 50 : 20, nested ? 40 : 30], [181, 45]].map(([x, y]) =>
      Array.from(canvas.getContext("2d")!.getImageData(x!, y!, 1, 1).data)), nested)).toEqual([[0, 0, 0, alpha + 0], [0, 0, 0, 255]]);
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
    const bytes = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () { hit("asset-bytes"); return bytes.call(this); };
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = (...args) => { hit("sha"); return digest(...args); };
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      const request = get.call(this, key); const root = document.documentElement;
      // Hold the original readonly result, never the conditional readwrite CAS.
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
    // An active edit controller would clear its value on Inspector's null notification.
    const value = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
    Object.defineProperty(HTMLInputElement.prototype, "value", { ...value, set(this: HTMLInputElement, next: string) {
      if (document.documentElement.dataset.disposalGuard === "yes" && this.closest("#shape-position,#shape-dimensions,#shape-opacity")) {
        document.documentElement.dataset.lateController = this.id; throw new Error(`Controller active after pagehide: ${this.id}`);
      }
      value.set!.call(this, next);
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
async function open(page: Page) {
  await page.goto("/"); await expect(page.locator("#status")).toContainText("unpersisted sample");
}
async function publish(page: Page, document = scene()) {
  await field(page, "Editable JSON").fill(JSON.stringify(document)); await button(page, actions[0]!).click();
  await expect(page.locator("#status")).toContainText("Rendered imported draft"); expect(current(await nativeRows(page)).document).toEqual(document);
}
async function healthy(page: Page, nested = false, opacity = 1, tracked = false) {
  await instrument(page); await open(page); await publish(page, scene(nested, opacity, tracked));
  await field(page, "PNG file").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: png });
  for (const [key, value] of Object.entries({ x: 180, y: 40, width: 8, height: 8 })) await field(page, `PNG ${key}`).fill(String(value));
  await button(page, "Import PNG").click(); await expect(page.locator("#png-status")).toContainText("PNG import complete");
  const rows = await nativeRows(page); const image = current(rows).document.elements.at(-1)!;
  const expected = scene(nested, opacity, tracked); expected.rootIds.push(image.id);
  expected.elements.push({ id: image.id, type: "image", x: 180, y: 40, width: 8, height: 8, opacity: 1,
    asset: { sha256: hash, mimeType: "image/png", byteLength: png.length, intrinsicWidth: 1, intrinsicHeight: 1 } });
  expect(current(rows).document).toEqual(expected);
  expect(current(rows)).toEqual(revision(expected, current(rows).revisionId, 2));
  expect(rows.assets).toEqual([{ sha256: hash, mimeType: "image/png", byteLength: png.length, bytes: Array.from(png) }]);
  await pixels(page, nested, tracked ? 128 : opacity === 1 ? 255 : 128);
  await expect(select(page)).toBeEnabled(); await select(page).selectOption("shape");
  expect(JSON.parse((await details(page).textContent())!)).toEqual(expected.elements[1]);
}
async function edit(page: Page, kind: typeof edits[number] = "Opacity") {
  await select(page).selectOption("shape");
  for (const [name, value] of Object.entries(inputs[kind])) await field(page, name).fill(value);
}
async function savedPrior(page: Page) {
  const original = await nativeRows(page); const draft = (original.pointers as { draft: Record<string, unknown> }[])[0]!.draft;
  await nativeRows(page, { pointers: [{ documentId: BROWSER_DOCUMENT, draft, saved: { ...draft, kind: "saved" } }] });
  await page.reload(); await expect(page.locator("#status")).toContainText("restored draft");
  return nativeRows(page); // Public reload makes saved/draft history the genuine prior source.
}
for (const nested of [false, true]) test(`production opacity: healthy JSON/PNG, full history, alpha, equal and cold reload (nested=${nested})`, async ({ page }) => {
  await healthy(page, nested); // Parent RED must reach the real frame and native source before these missing affordances.
  await expect(field(page, "Shape opacity")).toHaveValue("1"); await expect(button(page, "Apply opacity")).toBeEnabled();
  await expect(status(page)).toBeVisible(); await expect(page.getByRole("status", { name: "", exact: true })).toHaveCount(1);
  let before = await savedPrior(page); const original = current(before).document;
  for (const raw of ["0", "-0", "0.5", "1", "1"]) {
    await edit(page); await field(page, "Shape opacity").fill(raw); await field(page, "Editable JSON").fill("unsent invalid JSON");
    const retained = (await handles(page)).filter((record) => record.closes === 0); expect(retained).toHaveLength(1); expect(retained[0]!.useful).toBe(true);
    const allocated = (await ids(page)).length; const prior = before;
    await button(page, "Apply opacity").click(); await expect(status(page)).toContainText("complete");
    expect((await ids(page)).length).toBe(allocated + 2); before = await publication(page, before, { opacity: Number(raw) });
    const priorShape = current(prior).document.elements.find((element) => element.id === "shape")!;
    if (raw === "-0" || raw === "1" && priorShape.type === "shape" && priorShape.opacity === 1) expect(current(before).canonicalBytes).toEqual(current(prior).canonicalBytes);
    expect(current(before).document.elements.map((element) => element.id)).toEqual(original.elements.map((element) => element.id));
    await pixels(page, nested, Math.round(Number(raw) * 255)); await expect(select(page)).toHaveValue(""); await expect(details(page)).toHaveText("");
    for (const kind of edits) {
      await expect(button(page, action(kind))).toBeDisabled();
      await expect(status(page, kind)).toContainText(kind === "Opacity" ? "complete" : "Select a published shape");
    }
    for (const record of await handles(page)) {
      const kept = retained.some((item) => item.id === record.id); expect(record.closes).toBe(kept ? 0 : 1); expect(record.useful).toBe(kept);
    }
    expect((await handles(page)).length).toBeGreaterThan(1);
    await page.reload(); await expect(page.locator("#status")).toContainText("restored draft");
    expect(await nativeRows(page)).toEqual(before); await pixels(page, nested, Math.round(Number(raw) * 255));
    await expect(select(page)).toHaveValue(""); await select(page).selectOption("shape");
    await expect(field(page, "Shape opacity")).toHaveValue(String(Number(raw)));
    expect(JSON.parse((await details(page).textContent())!)).toEqual(current(before).document.elements[1]);
  }
});
for (const initial of [-0.25, 2]) test(`production authored wide opacity ${initial} remains truthful under a separate playback-start track override`, async ({ page }) => {
  await healthy(page, true, initial, true); await expect(field(page, "Shape opacity")).toHaveValue(String(initial));
  await field(page, "Editable JSON").fill(JSON.stringify(scene(true, 0.9, true)));
  await select(page).selectOption("root"); await select(page).selectOption("shape"); await expect(field(page, "Shape opacity")).toHaveValue(String(initial));
  const before = await nativeRows(page); await field(page, "Shape opacity").fill("0"); await button(page, "Apply opacity").click();
  await expect(status(page)).toContainText("tracks may override"); const after = await publication(page, before, { opacity: 0 });
  expect(current(after).document.tracks).toEqual(current(before).document.tracks);
  const time = current(after).document.playbackRange.startUs;
  const independentlyEvaluated = 0.25 + (0.75 - 0.25) * time / 1_000_000;
  expect(time).toBe(500_000); await pixels(page, true, Math.round(independentlyEvaluated * 255));
  await page.reload(); await expect(page.locator("#status")).toContainText("restored draft");
  expect(await nativeRows(page)).toEqual(after); await pixels(page, true, 128); await select(page).selectOption("shape");
  await expect(field(page, "Shape opacity")).toHaveValue("0");
});
test("production opacity guards all six variants, empty/range inputs and mutable DOM without retargeting", async ({ page }) => {
  await healthy(page); const before = await nativeRows(page); const priorFrame = await frame(page);
  await set(page, { watch: "yes", effects: "{}" });
  for (const element of current(before).document.elements) {
    await select(page).selectOption(element.id); expect(JSON.parse((await details(page).textContent())!)).toEqual(element);
    await expect(button(page, "Apply opacity")).toBeEnabled({ enabled: element.type === "shape" });
    await expect(field(page, "Shape opacity")).toBeEnabled({ enabled: element.type === "shape" });
    if (element.type !== "shape") { await expect(status(page)).toContainText("Other elements remain read-only"); await page.locator("#shape-opacity").dispatchEvent("submit"); }
  }
  await select(page).selectOption(""); await expect(button(page, "Apply opacity")).toBeDisabled();
  await button(page, "Apply opacity").dispatchEvent("click"); await page.locator("#shape-opacity").dispatchEvent("submit");
  await set(page, { watch: "no" }); expect(await page.locator("html").getAttribute("data-effects")).toBe("{}");
  await edit(page); await field(page, "Shape opacity").evaluate((input: HTMLInputElement) => { input.type = "text"; });
  for (const invalid of ["", "   ", "NaN", "Infinity", "-Infinity", "garbage", "-0.25", "2"]) {
    await field(page, "Shape opacity").fill(invalid); await set(page, { watch: "yes", effects: "{}" });
    await page.locator("#shape-opacity").dispatchEvent("submit"); await expect(status(page)).toContainText("finite");
    await expect(field(page, "Shape opacity")).toHaveValue(invalid); await expect(select(page)).toHaveValue("shape");
    await set(page, { watch: "no" }); expect(await page.locator("html").getAttribute("data-effects")).toBe("{}");
    expect(await nativeRows(page)).toEqual(before); expect(await frame(page)).toEqual(priorFrame);
  }
  await field(page, "Shape opacity").fill("0.5"); await field(page, "Editable JSON").fill(JSON.stringify(scene(false, 0.9)));
  await select(page).evaluate((element: HTMLSelectElement) => { element.value = "root"; element.selectedOptions[0]!.textContent = "shape opacity=2"; });
  await button(page, "Apply opacity").click(); await expect(status(page)).toContainText("complete"); await publication(page, before, { opacity: 0.5 });
  await publish(page); await expect(select(page)).toHaveValue(""); await expect(button(page, "Apply opacity")).toBeDisabled();
  const replaced = await nativeRows(page); await page.locator("#shape-opacity").dispatchEvent("submit"); expect(await nativeRows(page)).toEqual(replaced);
  await select(page).selectOption("shape"); await expect(field(page, "Shape opacity")).toHaveValue("1");
});
for (const held of actions) test(`production held ${held} excludes all seven forced actions and captures original inputs`, async ({ page }) => {
  if (held === "Create blank scene") { await instrument(page); await open(page); }
  else { await healthy(page); for (const kind of edits) await edit(page, kind); }
  const before = await nativeRows(page); const detail = await details(page).textContent();
  await set(page, { hold: "yes" });
  await button(page, held).evaluate((target) => {
    (target as HTMLButtonElement).click(); // Enter the actual public handler, then challenge in the same task.
    for (const other of document.querySelectorAll("button")) other.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    for (const form of document.forms) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const select = document.querySelector<HTMLSelectElement>("#scene-element")!;
    select.value = "root"; select.dispatchEvent(new Event("change", { bubbles: true }));
    for (const input of document.querySelectorAll("input,textarea")) input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending");
  await set(page, { watch: "yes", effects: "{}" });
  for (const name of actions) { await expect(button(page, name)).toBeDisabled(); await button(page, name).dispatchEvent("click"); }
  for (const form of forms) await page.locator(form).dispatchEvent("submit");
  await expect(select(page)).toBeDisabled();
  await select(page).evaluate((element: HTMLSelectElement) => { element.value = "root"; element.dispatchEvent(new Event("change")); });
  for (const name of [...Object.keys(inputs.Position), ...Object.keys(inputs.Dimension), "Shape opacity", "PNG x", "PNG y", "PNG width", "PNG height", "Rectangle x", "Rectangle y", "Rectangle width", "Rectangle height"]) {
    await expect(field(page, name)).toBeDisabled();
    await field(page, name).evaluate((input: HTMLInputElement, name) => { input.value = name === "Shape opacity" ? "0.75" : "999"; input.dispatchEvent(new Event("input")); }, name);
  }
  await field(page, "Editable JSON").evaluate((input: HTMLTextAreaElement, json) => { input.value = json; input.dispatchEvent(new Event("input")); }, JSON.stringify({ ...scene(), seed: 777 }));
  await set(page, { watch: "no" }); expect(await page.locator("html").getAttribute("data-effects")).toBe("{}");
  expect(await details(page).textContent()).toBe(detail); expect(await nativeRows(page)).toEqual(before);
  await set(page, { settle: "yes" }); await expect(select(page)).toBeEnabled(); await expect(select(page)).toHaveValue("");
  const after = await nativeRows(page); expect(after.revisions).toHaveLength((before.revisions as unknown[]).length + 1);
  if (held === actions[0]) expect(current(after).document).toEqual(scene());
  if (held === "Create blank scene") expect(current(after).document).toEqual({ schemaVersion: 1, durationUs: 1_000_000, seed: 42, loop: true,
    playbackRange: { startUs: 0, endUs: 1_000_000 }, tracks: [], rootIds: ["root"], elements: [{ id: "root", type: "group", childrenIds: [] }] });
  if (held === "Import PNG" || held === "Add rectangle") {
    const appended = current(after).document.elements.at(-1)!; const expected = structuredClone(current(before).document); expected.rootIds.push(appended.id);
    expected.elements.push(held === "Import PNG" ? { id: appended.id, type: "image", x: 180, y: 40, width: 8, height: 8, opacity: 1,
      asset: { sha256: hash, mimeType: "image/png", byteLength: png.length, intrinsicWidth: 1, intrinsicHeight: 1 } }
      : { id: appended.id, type: "shape", x: 16, y: 24, width: 120, height: 80, opacity: 1 });
    expect(current(after)).toEqual(revision(expected, current(after).revisionId, current(before).sequence + 1));
  }
  for (const kind of edits) {
    await expect(status(page, kind)).toContainText(held === action(kind) ? "complete" : "Select a published shape");
    await expect(button(page, action(kind))).toBeDisabled();
    // No initial token means forced DOM assignments remain; disabled input events authorize nothing.
    for (const name of Object.keys(inputs[kind])) await expect(field(page, name)).toHaveValue(
      held === "Create blank scene" ? name === "Shape opacity" ? "0.75" : "999" : "");
    await expect(page.locator(kind === "Dimension" ? "#shape-dimensions" : `#shape-${kind.toLowerCase()}`)).toHaveAttribute("aria-busy", "false");
    if (held === action(kind)) await publication(page, before, patch[kind]);
  }
  await expect(page.getByRole("status", { name: "Element inspection status", exact: true })).toContainText(current(after).revisionId);
});
for (const during of [false, true]) test(`production opacity genuine native CAS winner and eager candidate absence (during=${during})`, async ({ page, context }) => {
  await healthy(page); const before = await savedPrior(page); await edit(page);
  const priorFrame = await frame(page); const detail = await details(page).textContent(); const allocated = (await ids(page)).length;
  const retained = (await handles(page)).filter((record) => record.closes === 0);
  const other = await context.newPage(); await other.goto("/"); await expect(other.locator("#status")).toContainText("restored draft");
  if (during) { await set(page, { hold: "yes" }); await button(page, "Apply opacity").click(); await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending"); }
  const candidate = during ? (await ids(page)).at(-1)! : null; if (during) expect((await ids(page)).length).toBe(allocated + 2);
  const winner = structuredClone(current(before).document); winner.seed = 123; await publish(other, winner); const winningRows = await nativeRows(other);
  expect((winningRows.pointers as { saved: unknown }[])[0]!.saved).toEqual((before.pointers as { saved: unknown }[])[0]!.saved);
  for (const row of before.revisions as unknown[]) expect(winningRows.revisions).toContainEqual(row);
  expect(winningRows.assets).toEqual(before.assets);
  const winning = current(winningRows); expect(winning).toEqual(revision(winner, winning.revisionId, current(before).sequence + 1));
  expect(ordered(winningRows)).toEqual(ordered({ ...before, revisions: [...before.revisions as unknown[], winning],
    pointers: [{ documentId: BROWSER_DOCUMENT, saved: (before.pointers as { saved: unknown }[])[0]!.saved,
      draft: { kind: "draft", documentId: BROWSER_DOCUMENT, revisionId: winning.revisionId, sequence: winning.sequence } }] }));
  if (during) await set(page, { settle: "yes" }); else await button(page, "Apply opacity").click();
  await expect(status(page)).toContainText("refresh"); const captured = candidate ?? (await ids(page)).at(-1)!;
  expect((await ids(page)).length).toBe(allocated + 2); expect((winningRows.revisions as { revisionId: string }[]).some((row) => row.revisionId === captured)).toBe(false);
  expect(await nativeRows(page)).toEqual(winningRows); expect(await frame(page)).toEqual(priorFrame); expect(await details(page).textContent()).toBe(detail);
  for (const record of retained) expect((await handles(page)).find((item) => item.id === record.id)).toEqual(record);
  await expect(select(page)).toHaveValue("shape"); await expect(field(page, "Shape opacity")).toHaveValue("0.5");
  await page.reload(); await expect(page.locator("#status")).toContainText("restored draft");
  expect(await nativeRows(page)).toEqual(winningRows); await expect(select(page)).toHaveValue("");
  await select(page).selectOption("shape"); expect(JSON.parse((await details(page).textContent())!)).toEqual(winner.elements[1]); await other.close();
});
for (const kind of edits) test(`production ${kind} own rejection/success survive END and both external edit controllers refresh actual source`, async ({ page }) => {
  await healthy(page); await edit(page, kind); const before = await nativeRows(page); const priorFrame = await frame(page);
  await set(page, { hold: "yes", fault: "preparation", settle: "yes" }); await button(page, action(kind)).click();
  await expect(status(page, kind)).toContainText("failed"); await expect(select(page)).toHaveValue("shape");
  for (const [name, value] of Object.entries(inputs[kind])) await expect(field(page, name)).toHaveValue(value);
  expect(await nativeRows(page)).toEqual(before); expect(await frame(page)).toEqual(priorFrame);
  await set(page, { fault: "" }); await button(page, action(kind)).click(); await expect(status(page, kind)).toContainText("complete");
  let prior = await publication(page, before, patch[kind]); await expect(select(page)).toHaveValue("");
  for (const external of edits.filter((other) => other !== kind)) {
    await expect(status(page, external)).toContainText("Select a published shape");
    await edit(page, external); expect(JSON.parse((await details(page).textContent())!)).toEqual(current(prior).document.elements[1]);
    await button(page, action(external)).click(); await expect(status(page, external)).toContainText("complete");
    prior = await publication(page, prior, patch[external]); await expect(select(page)).toHaveValue("");
    for (const other of edits.filter((item) => item !== external)) await expect(status(page, other)).toContainText("Select a published shape");
    await expect(page.getByRole("status", { name: "Element inspection status", exact: true })).toContainText(current(prior).revisionId);
  }
  expect(await page.locator("#scene").evaluate((canvas: HTMLCanvasElement) => [[40, 35], [20, 29], [181, 45]]
    .map(([x, y]) => Array.from(canvas.getContext("2d")!.getImageData(x!, y!, 1, 1).data))))
    .toEqual([[0, 0, 0, 128], [0, 0, 0, 0], [0, 0, 0, 255]]);
});
for (const kind of edits) test(`production ${kind} committed render warning retains real source without rollback then renders a later genuine edit`, async ({ page }) => {
  await healthy(page); await edit(page, kind); const before = await nativeRows(page); const priorFrame = await frame(page);
  await set(page, { renderFault: "yes" }); await button(page, action(kind)).click();
  await expect(status(page, kind)).toContainText("published, but rendering failed"); const after = await publication(page, before, patch[kind]);
  expect(await frame(page)).toEqual(priorFrame); await expect(select(page)).toHaveValue("");
  await expect(status(page, kind)).not.toContainText("try again"); await expect(status(page, kind)).not.toContainText("rolled back");
  for (const other of edits.filter((item) => item !== kind)) await expect(status(page, other)).toContainText("Select a published shape");
  await select(page).selectOption("shape"); expect(JSON.parse((await details(page).textContent())!)).toEqual(current(after).document.elements[1]);
  await set(page, { renderFault: "" }); const nextKind = edits[(edits.indexOf(kind) + 1) % edits.length]!;
  await edit(page, nextKind); await button(page, action(nextKind)).click(); await expect(status(page, nextKind)).toContainText("complete");
  const rendered = await publication(page, after, patch[nextKind]); const shape = current(rendered).document.elements[1]!;
  if (shape.type !== "shape") throw new Error("Expected genuinely published shape");
  expect(await page.locator("#scene").evaluate((canvas: HTMLCanvasElement, shape) =>
    Array.from(canvas.getContext("2d")!.getImageData(Math.ceil(shape.x + 4), Math.ceil(shape.y + 4), 1, 1).data), shape)).toEqual([0, 0, 0, Math.round(shape.opacity * 255)]);
});
for (const held of ["Import editable JSON", "Apply opacity"]) for (const reject of [false, true]) test(`production pagehide owns ${held} settlement, all three controllers precede Inspector null and each bitmap closes once (reject=${reject})`, async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await healthy(page); await edit(page); const before = await nativeRows(page); const priorFrame = await frame(page);
  if (held === "Import editable JSON") await field(page, "Editable JSON").fill(JSON.stringify(current(before).document));
  const retained = (await handles(page)).filter((record) => record.closes === 0); expect(retained).toHaveLength(1);
  await set(page, { hold: "yes", fault: reject ? "preparation" : "" }); await button(page, held).click();
  await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending");
  const values = await page.locator("#shape-position input,#shape-dimensions input,#shape-opacity input").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  const statuses = await Promise.all(edits.map((kind) => status(page, kind).textContent()));
  await set(page, { disposalGuard: "yes" }); await page.evaluate(() => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pagehide")); });
  expect(await page.locator("html").getAttribute("data-late-controller")).toBeNull();
  expect(await page.locator("#shape-position input,#shape-dimensions input,#shape-opacity input").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual(values);
  expect(await Promise.all(edits.map((kind) => status(page, kind).textContent()))).toEqual(statuses);
  const frozen = await pane(page); for (const record of retained) expect((await handles(page)).find((item) => item.id === record.id)).toEqual(record);
  await set(page, { settle: "yes" }); await expect.poll(async () => (await handles(page)).every((record) => record.closes === 1 && !record.useful)).toBe(true);
  if (reject) expect(await nativeRows(page)).toEqual(before);
  else if (held === "Apply opacity") await publication(page, before, { opacity: 0.5 });
  else await publication(page, before, {});
  for (const name of actions) await button(page, name).dispatchEvent("click");
  for (const form of forms) await page.locator(form).dispatchEvent("submit"); await select(page).dispatchEvent("change");
  expect(await pane(page)).toBe(frozen); expect(await frame(page)).toEqual(priorFrame); expect(errors).toEqual([]);
  expect(await page.locator("html").getAttribute("data-late-controller")).toBeNull();
});

for (const held of actions) test(`production fill color: another origin ${held} blocks colour input and forced publication`, async ({ page }) => {
  if (held === "Create blank scene") { await instrument(page); await open(page); }
  else await healthy(page);
  if (held !== "Create blank scene") await field(page, "Shape fill color").fill("#112233");
  if (held === "Import editable JSON") await field(page, "Editable JSON").fill(JSON.stringify(current(await nativeRows(page)).document));
  const before = await nativeRows(page); await set(page, { hold: "yes" }); await button(page, held).click();
  await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending");
  await expect(field(page, "Shape fill color")).toBeDisabled(); await expect(button(page, "Apply fill color")).toBeDisabled();
  await set(page, { watch: "yes", effects: "{}" });
  await button(page, "Apply fill color").dispatchEvent("click"); await page.locator("#shape-fill-color").dispatchEvent("submit");
  await set(page, { watch: "no" }); expect(await page.locator("html").getAttribute("data-effects")).toBe("{}");
  expect(await nativeRows(page)).toEqual(before);
  await set(page, { settle: "yes" }); await expect(page.locator("html")).toHaveAttribute("data-preparation", "settled");
  await expect(page.locator("#shape-fill-color")).toHaveAttribute("aria-busy", "false");
  await expect(select(page)).toHaveValue(""); await expect(button(page, "Apply fill color")).toBeDisabled();
  const after = current(await nativeRows(page));
  for (const element of after.document.elements) if (element.type === "shape") expect(element).not.toHaveProperty("fillColor");
});
async function colours(page: Page, nested: boolean) {
  return page.locator("#scene").evaluate((canvas: HTMLCanvasElement, nested) =>
    [[nested ? 50 : 20, nested ? 40 : 30], [181, 45]].map(([x, y]) =>
      Array.from(canvas.getContext("2d")!.getImageData(x!, y!, 1, 1).data)), nested);
}
async function colourPublication(page: Page, before: Rows, fillColor: string) {
  const after = await nativeRows(page); const prior = current(before); const next = current(after);
  const expected = structuredClone(prior.document); const shape = expected.elements.find((element) => element.id === "shape")!;
  if (shape.type !== "shape") throw new Error("Expected an authored shape");
  shape.fillColor = fillColor; const independent = revision(expected, next.revisionId, prior.sequence + 1);
  expect(next).toEqual(independent); expect(next.canonicalBytes).toEqual(independent.canonicalBytes);
  expect(createHash("sha256").update(Uint8Array.from(independent.canonicalBytes)).digest("hex"))
    .toBe(createHash("sha256").update(Uint8Array.from(next.canonicalBytes)).digest("hex"));
  expect(ordered(after)).toEqual(ordered({ ...before, revisions: [...before.revisions as unknown[], next],
    pointers: [{ documentId: BROWSER_DOCUMENT, saved: (before.pointers as { saved: unknown }[])[0]!.saved,
      draft: { kind: "draft", documentId: BROWSER_DOCUMENT, revisionId: next.revisionId, sequence: next.sequence } }] }));
  return after;
}
for (const nested of [false, true]) test(`production fill color: authored cases stay exact, fall back to black and survive cold reload (nested=${nested})`, async ({ page }) => {
  await healthy(page, nested);
  await expect(field(page, "Shape fill color")).toHaveCount(1);
  await expect(button(page, "Apply fill color")).toHaveCount(1);
  await expect(status(page, "Fill color")).toHaveCount(1);
  const initial = current(await nativeRows(page));
  expect(initial.document.elements.find((element) => element.id === "shape")!).not.toHaveProperty("fillColor");
  await expect(field(page, "Shape fill color")).toHaveValue("");
  await expect(status(page, "Fill color")).toContainText("Absent colors render black (#000000) by fallback");
  let before = await savedPrior(page); const original = current(before).document;
  const rendered = [[63, 169, 245, 255], [0, 0, 0, 255]];
  for (const fillColor of ["#3FA9F5", "#3Fa9F5", "#3fa9f5", "#3fa9f5"]) {
    await select(page).selectOption("shape"); await field(page, "Shape fill color").fill(fillColor);
    const retained = (await handles(page)).filter((record) => record.closes === 0); expect(retained).toHaveLength(1);
    const allocated = (await ids(page)).length; const prior = before;
    await button(page, "Apply fill color").click(); await expect(status(page, "Fill color")).toContainText("complete");
    expect((await ids(page)).length).toBe(allocated + 2);
    before = await colourPublication(page, before, fillColor);
    const previous = current(prior).document.elements[1]!;
    if (previous.type === "shape" && previous.fillColor === fillColor) expect(current(before).canonicalBytes).toEqual(current(prior).canonicalBytes);
    expect(current(before).document.elements.map((element) => element.id)).toEqual(original.elements.map((element) => element.id));
    expect(current(before).document.tracks).toEqual(original.tracks);
    await expect(select(page)).toHaveValue(""); await expect(field(page, "Shape fill color")).toBeDisabled(); await expect(button(page, "Apply fill color")).toBeDisabled();
    await expect(field(page, "Shape fill color")).toHaveValue("");
    for (const kind of edits) { await expect(button(page, action(kind))).toBeDisabled(); await expect(status(page, kind)).toContainText("Select a published shape"); }
    for (const record of await handles(page)) { const kept = retained.some((item) => item.id === record.id); expect(record.closes).toBe(kept ? 0 : 1); expect(record.useful).toBe(kept); }
    expect((await handles(page)).length).toBeGreaterThan(1); expect(await colours(page, nested)).toEqual(rendered);
    await page.reload(); await expect(page.locator("#status")).toContainText("restored draft");
    expect(await nativeRows(page)).toEqual(before); expect(await colours(page, nested)).toEqual(rendered);
    await select(page).selectOption("shape"); await expect(field(page, "Shape fill color")).toHaveValue(fillColor);
    expect(JSON.parse((await details(page).textContent())!)).toEqual(current(before).document.elements[1]);
  }
});
test("production fill color: unsent JSON and a relabeled option never retarget the published source", async ({ page }) => {
  await healthy(page); await expect(field(page, "Shape fill color")).toHaveCount(1); await savedPrior(page);
  await select(page).selectOption("shape"); await field(page, "Shape fill color").fill("#112233");
  await field(page, "Editable JSON").fill(JSON.stringify(scene(false, 0.9)));
  await select(page).evaluate((element: HTMLSelectElement) => { element.value = "root"; element.selectedOptions[0]!.textContent = "shape fillColor=#ffffff"; });
  const before = await nativeRows(page); await button(page, "Apply fill color").click(); await expect(status(page, "Fill color")).toContainText("complete");
  const after = await colourPublication(page, before, "#112233");
  await expect(select(page)).toHaveValue(""); await expect(field(page, "Shape fill color")).toBeDisabled(); await expect(field(page, "Shape fill color")).toHaveValue("");
  await expect(button(page, "Apply fill color")).toBeDisabled();
  for (const kind of edits) await expect(status(page, kind)).toContainText("Select a published shape");
  expect(current(after).document.elements[1]).toEqual({ ...current(before).document.elements[1], fillColor: "#112233" });
});
test("production fill color: invalid matrix leaves native rows, frame and effects untouched and only shapes are editable", async ({ page }) => {
  await healthy(page); await expect(field(page, "Shape fill color")).toHaveCount(1);
  const before = await nativeRows(page); const priorFrame = await frame(page); const detail = await details(page).textContent();
  await select(page).selectOption("shape"); await set(page, { watch: "yes", effects: "{}" });
  for (const invalid of ["#3a9", "#3fa9f5ff", "rebeccapurple", "rgb(63,169,245)", " #3fa9f5", "#3fa9f5 ", "", "garbage"]) {
    await field(page, "Shape fill color").fill(invalid); await page.locator("#shape-fill-color").dispatchEvent("submit");
    await expect(status(page, "Fill color")).toContainText("seven-character"); await expect(field(page, "Shape fill color")).toHaveValue(invalid);
    await expect(select(page)).toHaveValue("shape");
  }
  await set(page, { watch: "no" }); expect(await page.locator("html").getAttribute("data-effects")).toBe("{}");
  expect(await nativeRows(page)).toEqual(before); expect(await frame(page)).toEqual(priorFrame); expect(await details(page).textContent()).toBe(detail);
  for (const element of current(before).document.elements) {
    await select(page).selectOption(element.id);
    await expect(field(page, "Shape fill color")).toBeEnabled({ enabled: element.type === "shape" });
    await expect(button(page, "Apply fill color")).toBeEnabled({ enabled: element.type === "shape" });
    if (element.type !== "shape") {
      await expect(status(page, "Fill color")).toContainText("Other elements remain read-only");
      await page.locator("#shape-fill-color").dispatchEvent("submit"); await button(page, "Apply fill color").dispatchEvent("click");
    }
  }
  await select(page).selectOption(""); await expect(field(page, "Shape fill color")).toBeDisabled(); await expect(button(page, "Apply fill color")).toBeDisabled();
  await expect(status(page, "Fill color")).toContainText("Select a published shape");
  await page.locator("#shape-fill-color").dispatchEvent("submit"); await button(page, "Apply fill color").dispatchEvent("click");
  expect(await nativeRows(page)).toEqual(before); expect(await frame(page)).toEqual(priorFrame);
});
test("production fill color: a held real preparation keeps all eight origins blocked until release publishes once", async ({ page }) => {
  await healthy(page); await expect(field(page, "Shape fill color")).toHaveCount(1); await select(page).selectOption("shape");
  const before = await nativeRows(page); const detail = await details(page).textContent(); await field(page, "Shape fill color").fill("#3fa9f5");
  await set(page, { hold: "yes" });
  await button(page, "Apply fill color").evaluate((target) => {
    (target as HTMLButtonElement).click();
    for (const other of document.querySelectorAll("button")) other.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    for (const form of document.forms) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    for (const input of document.querySelectorAll("input,textarea")) input.dispatchEvent(new Event("input", { bubbles: true }));
    const select = document.querySelector<HTMLSelectElement>("#scene-element")!; select.value = "root"; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending");
  await set(page, { watch: "yes", effects: "{}" });
  for (const name of [...actions, "Apply fill color"]) { await expect(button(page, name)).toBeDisabled(); await button(page, name).dispatchEvent("click"); }
  for (const form of [...forms, "#shape-fill-color"]) await page.locator(form).dispatchEvent("submit");
  await set(page, { watch: "no" }); expect(await page.locator("html").getAttribute("data-effects")).toBe("{}");
  expect(await details(page).textContent()).toBe(detail); expect(await nativeRows(page)).toEqual(before);
  await set(page, { settle: "yes" }); await expect(status(page, "Fill color")).toContainText("complete");
  await colourPublication(page, before, "#3fa9f5"); await expect(button(page, "Apply fill color")).toBeDisabled();
  await expect(status(page, "Fill color")).not.toContainText("Loading local scene");
  for (const kind of edits) await expect(status(page, kind)).toContainText("Select a published shape");
});
for (const during of [false, true]) test(`production fill color: genuine external CAS winner before/during retains no colour candidate (during=${during})`, async ({ page, context }) => {
  await healthy(page); await expect(field(page, "Shape fill color")).toHaveCount(1); const before = await savedPrior(page);
  await select(page).selectOption("shape"); await field(page, "Shape fill color").fill("#3fa9f5");
  const priorFrame = await frame(page); const detail = await details(page).textContent(); const allocated = (await ids(page)).length;
  const retained = (await handles(page)).filter((record) => record.closes === 0);
  const other = await context.newPage(); await other.goto("/"); await expect(other.locator("#status")).toContainText("restored draft");
  if (during) { await set(page, { hold: "yes" }); await button(page, "Apply fill color").click(); await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending"); }
  const candidate = during ? (await ids(page)).at(-1)! : null; if (during) expect((await ids(page)).length).toBe(allocated + 2);
  const winner = structuredClone(current(before).document); winner.seed = 123; await publish(other, winner); const winningRows = await nativeRows(other);
  expect((winningRows.pointers as { saved: unknown }[])[0]!.saved).toEqual((before.pointers as { saved: unknown }[])[0]!.saved);
  for (const row of before.revisions as unknown[]) expect(winningRows.revisions).toContainEqual(row);
  expect(winningRows.assets).toEqual(before.assets);
  const winning = current(winningRows); expect(winning).toEqual(revision(winner, winning.revisionId, current(before).sequence + 1));
  expect(ordered(winningRows)).toEqual(ordered({ ...before, revisions: [...before.revisions as unknown[], winning],
    pointers: [{ documentId: BROWSER_DOCUMENT, saved: (before.pointers as { saved: unknown }[])[0]!.saved,
      draft: { kind: "draft", documentId: BROWSER_DOCUMENT, revisionId: winning.revisionId, sequence: winning.sequence } }] }));
  if (during) await set(page, { settle: "yes" }); else await button(page, "Apply fill color").click();
  await expect(status(page, "Fill color")).toContainText("refresh"); const captured = candidate ?? (await ids(page)).at(-1)!;
  expect((await ids(page)).length).toBe(allocated + 2); expect((winningRows.revisions as { revisionId: string }[]).some((row) => row.revisionId === captured)).toBe(false);
  expect(await nativeRows(page)).toEqual(winningRows); expect(await frame(page)).toEqual(priorFrame); expect(await details(page).textContent()).toBe(detail);
  for (const record of retained) expect((await handles(page)).find((item) => item.id === record.id)).toEqual(record);
  await page.reload(); await expect(page.locator("#status")).toContainText("restored draft");
  expect(await nativeRows(page)).toEqual(winningRows); await select(page).selectOption("shape");
  await expect(field(page, "Shape fill color")).toHaveValue(""); expect(await colours(page, false)).toEqual([[0, 0, 0, 255], [0, 0, 0, 255]]);
  expect(JSON.parse((await details(page).textContent())!)).toEqual(winner.elements[1]); await other.close();
});
test("production fill color: committed render warning preserves the native publication and reload renders it", async ({ page }) => {
  await healthy(page); await field(page, "Shape fill color").fill("#00ff00");
  const before = await nativeRows(page); const priorFrame = await frame(page);
  await set(page, { renderFault: "yes" }); await button(page, "Apply fill color").click();
  await expect(status(page, "Fill color")).toContainText("published, but rendering failed");
  const after = await colourPublication(page, before, "#00ff00");
  expect(await frame(page)).toEqual(priorFrame); await expect(select(page)).toHaveValue("");
  await expect(status(page, "Fill color")).not.toContainText("rolled back");
  await set(page, { renderFault: "" }); await page.reload();
  await expect(page.locator("#status")).toContainText("restored draft");
  expect(await nativeRows(page)).toEqual(after);
  expect(await colours(page, false)).toEqual([[0, 255, 0, 255], [0, 0, 0, 255]]);
  await select(page).selectOption("shape"); await expect(field(page, "Shape fill color")).toHaveValue("#00ff00");
});
for (const reject of [false, true]) test(`production fill color: pagehide owns settlement and closes every bitmap once (reject=${reject})`, async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await healthy(page); await field(page, "Shape fill color").fill("#3Fa9F5");
  const before = await nativeRows(page); const priorFrame = await frame(page);
  const retained = (await handles(page)).filter((record) => record.closes === 0); expect(retained).toHaveLength(1);
  await set(page, { hold: "yes", fault: reject ? "preparation" : "" }); await button(page, "Apply fill color").click();
  await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending");
  const value = await field(page, "Shape fill color").inputValue(); const feedback = await status(page, "Fill color").textContent();
  await field(page, "Shape fill color").evaluate((input: HTMLInputElement) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
    Object.defineProperty(input, "value", { configurable: true, get: () => descriptor.get!.call(input),
      set: () => { document.documentElement.dataset.lateFill = "yes"; throw new Error("Fill controller active after pagehide"); } });
  });
  await set(page, { disposalGuard: "yes" }); await page.evaluate(() => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pagehide")); });
  expect(await page.locator("html").getAttribute("data-late-fill")).toBeNull();
  expect(await page.locator("html").getAttribute("data-late-controller")).toBeNull();
  await expect(field(page, "Shape fill color")).toHaveValue(value); expect(await status(page, "Fill color").textContent()).toBe(feedback);
  const frozen = await pane(page); for (const record of retained) expect((await handles(page)).find((item) => item.id === record.id)).toEqual(record);
  await set(page, { settle: "yes" }); await expect.poll(async () => (await handles(page)).every((record) => record.closes === 1 && !record.useful)).toBe(true);
  if (reject) expect(await nativeRows(page)).toEqual(before); else await colourPublication(page, before, "#3Fa9F5");
  for (const name of [...actions, "Apply fill color"]) await button(page, name).dispatchEvent("click");
  for (const form of [...forms, "#shape-fill-color"]) await page.locator(form).dispatchEvent("submit"); await select(page).dispatchEvent("change");
  expect(await pane(page)).toBe(frozen); expect(await frame(page)).toEqual(priorFrame); expect(errors).toEqual([]);
});
