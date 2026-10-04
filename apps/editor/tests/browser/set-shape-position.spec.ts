/// <reference types="node" />
import { Buffer } from "node:buffer";
import { expect, test, type Page } from "@playwright/test";
import type { SceneDocumentV1 } from "@particle-studio/scene-document";
import { BROWSER_DOCUMENT, nativeRows } from "../raw-indexeddb-seed.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const hash = "sha256:431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460";
const apply = (page: Page) => page.getByRole("button", { name: "Apply position", exact: true });
const status = (page: Page) => page.getByRole("status", { name: "Position status", exact: true });
const select = (page: Page) => page.getByRole("combobox", { name: "Scene element", exact: true });
const axis = (page: Page, name: string) => page.getByLabel(`Position ${name}`, { exact: true });
const details = (page: Page) => page.getByLabel("Published element JSON", { exact: true });
const actions = ["Import editable JSON", "Create blank scene", "Import PNG", "Add rectangle", "Apply position"];
const scene = (nested = false): SceneDocumentV1 => ({
  schemaVersion: 1, durationUs: 1_000_000, seed: 99, loop: false,
  playbackRange: { startUs: 500_000, endUs: 900_000 }, rootIds: nested ? ["root"] : ["shape", "root"],
  elements: [{ id: "root", type: "group", childrenIds: nested ? ["shape"] : [], ...(nested ? { transform: [1, 0, 0, 1, 30, 10] } : {}) },
    { id: "shape", type: "shape", x: 16, y: 24, width: 120, height: 80, opacity: 1 }],
  tracks: [{ elementId: "shape", property: "opacity", interpolation: "linear", easing: "linear",
    keyframes: [{ timeUs: 0, value: 0.25 }, { timeUs: 1_000_000, value: 0.75 }] }],
});
function revision(document: SceneDocumentV1, revisionId: string, sequence: number) {
  // Independent key-sorted JSON oracle. Arrays retain authored order. The real
  // editor imports and validates the fixture; no generated SDK validator in Node.
  const json = JSON.stringify(document, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  const canonicalBytes = Array.from(new TextEncoder().encode(json));
  return { documentId: BROWSER_DOCUMENT, revisionId, sequence, document, canonicalBytes,
    canonicalization: { identifier: "jcs-1", byteLength: canonicalBytes.length } };
}
type Rows = Awaited<ReturnType<typeof nativeRows>>;
function current(rows: Rows) {
  const draft = (rows.pointers as { draft: { revisionId: string } }[])[0]!.draft;
  return (rows.revisions as ReturnType<typeof revision>[]).find((row) => row.revisionId === draft.revisionId)!;
}
function ordered(rows: Rows) {
  return { ...rows, revisions: (rows.revisions as ReturnType<typeof revision>[]).slice().sort((a, b) =>
    a.documentId.localeCompare(b.documentId) || a.revisionId.localeCompare(b.revisionId)) };
}
async function set(page: Page, values: Record<string, string>) {
  await page.locator("html").evaluate((root, values) => Object.assign((root as HTMLElement).dataset, values), values);
}
async function frame(page: Page) {
  // Independent world-space sample points: old root/nested shape, new local
  // x=200/y=40 shape, transformed successor, and the separate PNG at x=180.
  return page.locator("#scene").evaluate((canvas: HTMLCanvasElement) => [60, 201, 231, 181].map((x) =>
    Array.from(canvas.getContext("2d")!.getImageData(x, 45, 1, 1).data)));
}
async function lifetimes(page: Page) {
  return JSON.parse((await page.locator("html").getAttribute("data-bitmaps")) ?? "[]") as { id: number; closes: number }[];
}
async function pane(page: Page) {
  return page.locator("body").evaluate(() => document.body.innerHTML + JSON.stringify(
    Array.from(document.querySelectorAll("input,select"), (element) => (element as HTMLInputElement).value)));
}
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      const root = document.documentElement;
      const request = get.call(this, key);
      // Only hold genuine readonly pointer results; never alter readwrite CAS.
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
      request.addEventListener("success", intercept, true); return request;
    };
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (document.documentElement.dataset.renderFault === "yes") throw new Error("Post-commit before-clear render fault");
      return clear.apply(this, args);
    };
    const decode = globalThis.createImageBitmap; const records: { id: number; closes: number }[] = [];
    globalThis.createImageBitmap = async (source: ImageBitmapSource) => {
      const bitmap = await decode(source); const record = { id: records.length + 1, closes: 0 }; records.push(record);
      const update = () => { document.documentElement.dataset.bitmaps = JSON.stringify(records); };
      const close = bitmap.close.bind(bitmap); bitmap.close = () => { close(); record.closes += 1; update(); };
      update(); return bitmap;
    };
  });
}
async function open(page: Page) {
  await page.goto("/"); await expect(page.locator("#status")).toContainText("unpersisted sample");
}
async function publish(page: Page, document = scene()) {
  await page.getByLabel("Editable JSON", { exact: true }).fill(JSON.stringify(document));
  await page.getByRole("button", { name: "Import editable JSON", exact: true }).click();
  await expect(page.locator("#status")).toContainText("Rendered imported draft");
  expect(current(await nativeRows(page)).document).toEqual(document);
}
async function withPng(page: Page) {
  await page.getByLabel("PNG file", { exact: true }).setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: png });
  for (const [key, value] of Object.entries({ x: 180, y: 40, width: 8, height: 8 })) {
    await page.getByLabel(`PNG ${key}`, { exact: true }).fill(String(value));
  }
  await page.getByRole("button", { name: "Import PNG", exact: true }).click();
  await expect(page.locator("#png-status")).toContainText("PNG import complete");
}
async function position(page: Page, x = "200", y = "40") {
  await select(page).selectOption("shape"); await axis(page, "X").fill(x); await axis(page, "Y").fill(y);
}
async function expectPublication(page: Page, before: Rows, x: number, y: number) {
  const after = await nativeRows(page); const previous = current(before); const next = current(after);
  const document = structuredClone(previous.document); Object.assign(document.elements.find((element) => element.id === "shape")!, { x, y });
  expect(next.revisionId).not.toBe(previous.revisionId); expect(next).toEqual(revision(document, next.revisionId, previous.sequence + 1));
  expect(ordered(after)).toEqual(ordered({ ...before, revisions: [...before.revisions as unknown[], next],
    pointers: [{ documentId: BROWSER_DOCUMENT, saved: (before.pointers as { saved: unknown }[])[0]!.saved,
      draft: { kind: "draft", documentId: BROWSER_DOCUMENT, revisionId: next.revisionId, sequence: next.sequence } }] }));
  return after;
}

test("position widgets are accessible and cannot edit the unpersisted sample", async ({ page }) => {
  await open(page); await expect(axis(page, "X")).toBeVisible(); await expect(axis(page, "Y")).toBeVisible();
  await expect(apply(page)).toBeDisabled(); await expect(status(page)).toBeVisible();
  await expect(page.getByRole("status", { name: "", exact: true })).toHaveCount(1);
});
for (const nested of [false, true]) {
  test(`visible authored position, native canonical history, transformed pixels and cold reload (nested=${nested})`, async ({ page }) => {
    await instrument(page); await open(page); await publish(page, scene(nested)); await withPng(page);
    const before = await nativeRows(page); const previous = current(before);
    const image = previous.document.elements.at(-1)!;
    const expected = scene(nested); expected.rootIds.push(image.id);
    expected.elements.push({ id: image.id, type: "image", x: 180, y: 40, width: 8, height: 8, opacity: 1,
      asset: { sha256: hash, mimeType: "image/png", byteLength: png.length, intrinsicWidth: 1, intrinsicHeight: 1 } });
    expect(previous.document).toEqual(expected);
    expect(before.assets).toEqual([{ sha256: hash, mimeType: "image/png", byteLength: png.length, bytes: Array.from(png) }]);
    await select(page).selectOption("shape"); await expect(axis(page, "X")).toHaveValue("16"); await expect(axis(page, "Y")).toHaveValue("24");
    await page.getByLabel("Editable JSON", { exact: true }).fill("unsent invalid JSON");
    await position(page); const retained = (await lifetimes(page)).filter((record) => record.closes === 0); expect(retained).toHaveLength(1);
    await apply(page).click(); await expect(status(page)).toContainText("complete");
    const after = await expectPublication(page, before, 200, 40);
    await expect(select(page)).toHaveValue(""); await expect(details(page)).toHaveText(""); await expect(apply(page)).toBeDisabled();
    const pixels = nested ? [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 255]]
      : [[0, 0, 0, 0], [0, 0, 0, 128], [0, 0, 0, 128], [0, 0, 0, 255]];
    // Nested y=40 + group y=10 means y=45 is above the shape; independently sample its interior too.
    expect(await frame(page)).toEqual(pixels);
    expect(await page.locator("#scene").evaluate((canvas: HTMLCanvasElement) =>
      Array.from(canvas.getContext("2d")!.getImageData(235, 55, 1, 1).data))).toEqual([0, 0, 0, 128]);
    const handles = await lifetimes(page);
    for (const record of retained) expect(handles.find((candidate) => candidate.id === record.id)?.closes).toBe(0);
    for (const record of handles) if (!retained.some((candidate) => candidate.id === record.id)) expect(record.closes).toBe(1);
    expect(handles.length).toBeGreaterThan(2);
    await page.reload(); await expect(page.locator("#status")).toContainText("restored draft");
    await expect(select(page)).toHaveValue(""); expect(await nativeRows(page)).toEqual(after); expect(await frame(page)).toEqual(pixels);
    await position(page, "200", "40"); await apply(page).click(); await expect(status(page)).toContainText("complete");
    const equal = await expectPublication(page, after, 200, 40); expect(current(equal).canonicalBytes).toEqual(current(after).canonicalBytes);
    await expect(select(page)).toHaveValue(""); await publish(page, scene());
    expect(current(await nativeRows(page)).sequence).toBe(current(equal).sequence + 1);
    for (const record of await lifetimes(page)) expect(record.closes).toBe(1);
    await withPng(page); await page.getByRole("button", { name: "Add rectangle", exact: true }).click();
    await expect(page.locator("#rectangle-status")).toContainText("complete");
    expect(current(await nativeRows(page)).sequence).toBe(current(equal).sequence + 3);
  });
}
for (const action of actions) {
  test(`actual ${action} hold excludes every programmatic action and keeps selected source`, async ({ page }) => {
    await instrument(page); await open(page);
    if (action !== "Create blank scene") {
      await publish(page); await withPng(page); await position(page);
      await expect(status(page)).toContainText("Edit both authored local coordinates");
    }
    const before = await nativeRows(page); const detail = await details(page).textContent();
    await set(page, { hold: "yes" }); await page.getByRole("button", { name: action, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending");
    for (const name of actions) {
      await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
      await page.getByRole("button", { name, exact: true }).dispatchEvent("click");
    }
    for (const id of ["#json-import", "#png-import", "#rectangle-create", "#shape-position"]) await page.locator(id).dispatchEvent("submit");
    await select(page).evaluate((element: HTMLSelectElement) => { element.value = "root"; element.dispatchEvent(new Event("change")); });
    expect(await details(page).textContent()).toBe(detail); expect(await nativeRows(page)).toEqual(before);
    if (action === "Apply position") {
      await axis(page, "X").evaluate((input: HTMLInputElement) => { input.value = "999"; });
      await expect(status(page)).toContainText("pending");
    }
    await set(page, { settle: "yes" }); await expect(select(page)).toBeEnabled(); await expect(select(page)).toHaveValue("");
    await expect(page.locator("#shape-position")).toHaveAttribute("aria-busy", "false");
    for (const name of ["X", "Y"]) {
      await expect(axis(page, name)).toHaveValue("");
      await expect(axis(page, name)).toBeDisabled();
    }
    await expect(apply(page)).toBeDisabled();
    if (action === "Apply position") {
      await expect(status(page)).toHaveAttribute("data-position-status", "success");
      await expect(status(page)).toContainText("complete");
    } else {
      await expect(status(page)).toHaveAttribute("data-position-status", "idle");
      await expect(status(page)).toContainText("Select a published shape");
      await expect(status(page)).not.toContainText("Edit both");
    }
    const after = await nativeRows(page);
    expect((after.revisions as unknown[]).length).toBe((before.revisions as unknown[]).length + 1);
    if (action === "Apply position") await expectPublication(page, before, 200, 40);
  });
}
for (const during of [false, true]) {
  test(`real native CAS winner is preserved without rebasing local position (during=${during})`, async ({ page, context }) => {
    await instrument(page); await open(page); await publish(page); await withPng(page); await position(page);
    const pixels = await frame(page); const detail = await details(page).textContent();
    const other = await context.newPage(); await other.goto("/"); await expect(other.locator("#status")).toContainText("restored draft");
    if (during) { await set(page, { hold: "yes" }); await apply(page).click(); await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending"); }
    const winnerDocument = scene(); winnerDocument.seed = 123; await publish(other, winnerDocument); const winner = await nativeRows(other);
    if (during) await set(page, { settle: "yes" }); else await apply(page).click();
    await expect(status(page)).toContainText("refresh"); expect(await nativeRows(page)).toEqual(winner); expect(await frame(page)).toEqual(pixels);
    await expect(select(page)).toHaveValue("shape"); expect(await details(page).textContent()).toBe(detail);
    await expect(axis(page, "X")).toHaveValue("200");
    await apply(page).click(); await expect(status(page)).toContainText("refresh"); expect(await nativeRows(page)).toEqual(winner);
    expect(await frame(page)).toEqual(pixels); await other.close();
  });
}
test("same-source rejection retains typed fields and lane recovery; reused-ID replacement requires reselect", async ({ page }) => {
  await instrument(page); await open(page); await publish(page); await position(page, "-12.5", "3.75");
  const before = await nativeRows(page); const pixels = await frame(page);
  await set(page, { hold: "yes", fault: "preparation", settle: "yes" }); await apply(page).click();
  await expect(status(page)).toContainText("failed"); expect(await nativeRows(page)).toEqual(before); expect(await frame(page)).toEqual(pixels);
  await expect(select(page)).toHaveValue("shape"); await expect(axis(page, "X")).toHaveValue("-12.5");
  await set(page, { fault: "" }); await apply(page).click(); await expect(status(page)).toContainText("complete");
  await expectPublication(page, before, -12.5, 3.75);
  const replacement = scene(); Object.assign(replacement.elements[1]!, { x: 90, y: 80 });
  await publish(page, replacement); await expect(select(page)).toHaveValue(""); await expect(apply(page)).toBeDisabled();
  await select(page).selectOption("shape"); await expect(axis(page, "X")).toHaveValue("90");
});
test("position publication remains truthful when the committed successor cannot render", async ({ page }) => {
  await instrument(page); await open(page); await publish(page); await position(page);
  const before = await nativeRows(page); const pixels = await frame(page);
  await set(page, { renderFault: "yes" }); await apply(page).click();
  await expect(status(page)).toContainText("published, but rendering failed");
  await expectPublication(page, before, 200, 40); expect(await frame(page)).toEqual(pixels);
  await expect(select(page)).toHaveValue(""); await expect(apply(page)).toBeDisabled();
  await select(page).selectOption("shape"); await expect(axis(page, "X")).toHaveValue("200");
  expect(JSON.parse((await details(page).textContent())!)).toMatchObject({ id: "shape", x: 200, y: 40 });
  await expect(status(page)).not.toContainText("try again");
});
for (const reject of [false, true]) {
  test(`pagehide freezes position/inspection and awaits bitmap ownership settlement (reject=${reject})`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await instrument(page); await open(page); await publish(page); await withPng(page); await position(page);
    const before = await nativeRows(page); const pixels = await frame(page);
    const retained = (await lifetimes(page)).filter((record) => record.closes === 0); expect(retained).toHaveLength(1);
    await set(page, { hold: "yes", fault: reject ? "preparation" : "" }); await apply(page).click();
    await expect(page.locator("html")).toHaveAttribute("data-preparation", "pending");
    await page.evaluate(() => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pagehide")); });
    const frozen = await pane(page);
    for (const record of retained) expect((await lifetimes(page)).find((candidate) => candidate.id === record.id)?.closes).toBe(0);
    await set(page, { settle: "yes" }); await expect.poll(async () => (await lifetimes(page)).every((record) => record.closes === 1)).toBe(true);
    if (reject) expect(await nativeRows(page)).toEqual(before); else await expectPublication(page, before, 200, 40);
    await apply(page).dispatchEvent("click"); await page.locator("#shape-position").dispatchEvent("submit"); await select(page).dispatchEvent("change");
    expect(await pane(page)).toBe(frozen); expect(await frame(page)).toEqual(pixels); expect(errors).toEqual([]);
  });
}
