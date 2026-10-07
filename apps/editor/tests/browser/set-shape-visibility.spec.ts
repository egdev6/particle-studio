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
