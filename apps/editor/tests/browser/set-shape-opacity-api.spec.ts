import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { SceneDocumentV1 } from "@particle-studio/scene-document";
import type { ShapeOpacityRequest } from "../../src/editor-session.js";
import { BROWSER_DOCUMENT, nativeRows } from "../raw-indexeddb-seed.js";
import type {} from "./fixtures/browser-opacity-api.fixture.js";

const route = "/apps/editor/tests/browser/fixtures/browser-opacity-api.fixture.html";
const actions = ["json", "blank", "png", "rectangle", "position", "dimensions", "opacity"];
const scene = (nested: boolean, opacity = 1, tracked = false): SceneDocumentV1 => ({
  schemaVersion: 1, durationUs: 1_000_000, seed: 99, loop: false,
  playbackRange: { startUs: 500_000, endUs: 900_000 }, rootIds: nested ? ["root"] : ["shape", "root"],
  elements: [{ id: "root", type: "group", childrenIds: nested ? ["shape"] : [], transform: [1, 0, 0, 1, 30, 10] },
    { id: "shape", type: "shape", x: 16, y: 24, width: 40, height: 20, opacity }],
  tracks: tracked ? [{ elementId: "shape", property: "opacity", interpolation: "linear", easing: "linear",
    keyframes: [{ timeUs: 0, value: 0.25 }, { timeUs: 1_000_000, value: 0.75 }] }] : [],
});
const snapshot = (page: Page) => page.evaluate(() => window.opacity.snapshot());
async function pixels(page: Page, nested: boolean, alpha: number) {
  await page.evaluate(() => window.opacity.render());
  expect(await page.locator("#scene").evaluate((canvas: HTMLCanvasElement, nested) =>
    Array.from(canvas.getContext("2d")!.getImageData(nested ? 50 : 20, nested ? 40 : 30, 1, 1).data), nested)).toEqual([0, 0, 0, alpha]);
  expect(await page.locator("#scene").evaluate((canvas: HTMLCanvasElement) => canvas.getContext("2d")!.getImageData(282, 12, 1, 1).data[3])).toBe(255);
}
async function open(page: Page, nested = false, blank = false, opacity = 1, tracked = false) {
  await page.goto(route); await expect(page.locator("#status")).toHaveText("ready");
  if (!blank) {
    await page.evaluate((json) => window.opacity.publish(json), JSON.stringify(scene(nested, opacity, tracked)));
    await page.evaluate(() => window.opacity.action("png", {} as ShapeOpacityRequest));
    await pixels(page, nested, tracked ? 64 : Math.round(Math.max(0, Math.min(1, opacity)) * 255));
    const healthy = (await snapshot(page)).current!;
    expect(healthy.document.elements[1]).toMatchObject({ type: "shape", width: 40, height: 20, opacity });
    expect(healthy.sequence).toBe(2); expect(healthy.document.elements.at(-1)?.type).toBe("image");
    expect(typeof await page.evaluate(() => window.opacity.browser.current!.revision.revisionId)).toBe("string");
    expect(await page.evaluate(() => typeof window.opacity.browser.setShapeOpacity)).toBe("function");
  }
}
async function request(page: Page, opacity = 0.5): Promise<ShapeOpacityRequest> {
  const current = (await snapshot(page)).current!;
  return { documentId: current.documentId, revisionId: current.revisionId, elementId: "shape", opacity };
}
const rows = (page: Page) => nativeRows(page);
type Rows = Awaited<ReturnType<typeof rows>>;
function current(before: Rows) {
  const pointer = (before.pointers as { draft: { revisionId: string } }[])[0]!.draft;
  return (before.revisions as { documentId: string; revisionId: string; sequence: number; document: SceneDocumentV1 }[])
    .find((row) => row.revisionId === pointer.revisionId)!;
}
function ordered(before: Rows) {
  return { ...before, revisions: (before.revisions as { revisionId: string }[]).slice().sort((a, b) => a.revisionId.localeCompare(b.revisionId)) };
}
async function publication(page: Page, before: Rows, opacity = 0.5, disposed = false) {
  const after = await rows(page); const prior = current(before); const next = current(after);
  const document = structuredClone(prior.document); Object.assign(document.elements.find((element) => element.id === "shape")!, { opacity });
  // Independent recursive key ordering; arrays retain their semantic order.
  const json = JSON.stringify(document, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  const canonicalBytes = Array.from(new TextEncoder().encode(json));
  expect(next.revisionId).not.toBe(prior.revisionId);
  expect(next).toEqual({ documentId: BROWSER_DOCUMENT, revisionId: next.revisionId, sequence: prior.sequence + 1,
    document, canonicalBytes, canonicalization: { identifier: "jcs-1", byteLength: canonicalBytes.length } });
  expect(ordered(after)).toEqual(ordered({ ...before, revisions: [...before.revisions as unknown[], next],
    pointers: [{ documentId: BROWSER_DOCUMENT, saved: (before.pointers as { saved: unknown }[])[0]!.saved,
      draft: { kind: "draft", documentId: BROWSER_DOCUMENT, revisionId: next.revisionId, sequence: next.sequence } }] }));
  if (!disposed) expect((await snapshot(page)).current).toEqual(next);
  return after;
}
for (const nested of [false, true]) test(`native opacity whole history, alpha, equal and cold reload (nested=${nested})`, async ({ page }) => {
  await open(page, nested); let before = await rows(page); const prior = current(before);
  const pointer = (before.pointers as { draft: { revisionId: string; sequence: number } }[])[0]!;
  await nativeRows(page, { pointers: [{ documentId: BROWSER_DOCUMENT, draft: pointer.draft, saved: { ...pointer.draft, kind: "saved" } }] });
  await page.reload(); await expect(page.locator("#status")).toHaveText("ready");
  before = await rows(page); expect((await snapshot(page)).current).toEqual(current(before));
  const png = await page.evaluate(() => window.opacity.png);
  expect(before.assets).toEqual([{ sha256: `sha256:${createHash("sha256").update(new Uint8Array(png)).digest("hex")}`,
    mimeType: "image/png", byteLength: png.length, bytes: png }]);
  const retained = (await snapshot(page)).handles.filter((handle) => handle.closes === 0);
  expect(retained.length).toBeGreaterThan(0); for (const handle of retained) expect(handle.useful).toBe(true);
  for (const opacity of [0, 0.5, 1, 1]) {
    const ids = await page.evaluate(() => window.opacity.ids.length);
    await page.evaluate((input) => window.opacity.action("opacity", input), await request(page, opacity));
    expect(await page.evaluate(() => window.opacity.ids.length)).toBe(ids + 2);
    before = await publication(page, before, opacity); await pixels(page, nested, Math.round(opacity * 255));
    expect(current(before).document.elements.map((element) => element.id)).toEqual(prior.document.elements.map((element) => element.id));
    for (const handle of (await snapshot(page)).handles) {
      expect(handle.closes).toBe(retained.some((item) => item.id === handle.id) ? 0 : 1); expect(handle.useful).toBe(handle.closes === 0);
    }
  }
  expect(await page.evaluate(() => "release" in window.opacity.browser.current! || "cache" in window.opacity.browser.current!)).toBe(false);
  await page.reload(); await expect(page.locator("#status")).toHaveText("ready"); expect(await rows(page)).toEqual(before); await pixels(page, nested, 255);
});
for (const initial of [-0.25, 2]) test(`native finite-wide authored source and independent track override (${initial})`, async ({ page }) => {
  await open(page, true, false, initial, true); const before = await rows(page);
  await page.evaluate((input) => window.opacity.action("opacity", input), await request(page, 0));
  const after = await publication(page, before, 0); expect(current(after).document.tracks).toEqual(current(before).document.tracks);
  await pixels(page, true, 64); // Evaluated track, not newly authored zero.
  await page.reload(); await expect(page.locator("#status")).toHaveText("ready"); expect(await rows(page)).toEqual(after); await pixels(page, true, 64);
});
test("native pre-effect source/range/sequence guards and same-source recovery", async ({ page }) => {
  await open(page); const input = await request(page); const before = await rows(page); const prior = await snapshot(page);
  const ids = await page.evaluate(() => window.opacity.ids.length);
  for (const invalid of [{ documentId: "foreign" }, { revisionId: "old" }, { elementId: "absent" }, { elementId: "root" },
    { elementId: prior.current!.document.elements.at(-1)!.id }, { opacity: -0.25 }, { opacity: 2 }, { opacity: NaN }, { opacity: Infinity }]) {
    expect(await page.evaluate(async (input) => { try { await window.opacity.action("opacity", input); return false; } catch { return true; } }, { ...input, ...invalid })).toBe(true);
  }
  expect(await page.evaluate(() => window.opacity.ids.length)).toBe(ids); expect(await rows(page)).toEqual(before);
  expect((await snapshot(page)).current).toEqual(prior.current);
  await page.evaluate((input) => { window.opacity.hold(); window.opacity.launch("opacity", input); }, input);
  await expect.poll(async () => (await snapshot(page)).pending).toBe(true);
  await page.evaluate(() => window.opacity.settle(true)); await expect.poll(async () => (await snapshot(page)).result).toBe("rejected");
  expect(await rows(page)).toEqual(before); expect((await snapshot(page)).current).toEqual(prior.current);
  await page.evaluate((input) => window.opacity.action("opacity", input), input); const after = await publication(page, before);
  const next = current(after);
  await nativeRows(page, { revisions: [{ ...next, sequence: Number.MAX_SAFE_INTEGER }], pointers: [{ documentId: BROWSER_DOCUMENT, saved: null,
    draft: { kind: "draft", documentId: BROWSER_DOCUMENT, revisionId: next.revisionId, sequence: Number.MAX_SAFE_INTEGER } }] });
  await page.reload(); await expect(page.locator("#status")).toHaveText("ready"); const exhausted = await rows(page);
  const count = await page.evaluate(() => window.opacity.ids.length);
  expect(await page.evaluate(async (input) => { try { await window.opacity.action("opacity", input); return false; } catch { return true; } }, await request(page))).toBe(true);
  expect(await page.evaluate(() => window.opacity.ids.length)).toBe(count); expect(await rows(page)).toEqual(exhausted);
});
for (const action of actions) test(`native held ${action} excludes all seven direct actions`, async ({ page }) => {
  await open(page, false, action === "blank"); const before = await rows(page);
  const input = action === "blank" ? { documentId: BROWSER_DOCUMENT, revisionId: "absent", elementId: "shape", opacity: 0.5 } : await request(page);
  await page.evaluate(({ action, input }) => {
    window.opacity.hold(); window.opacity.launch(action, input);
    if (action === "opacity") Object.assign(input, { documentId: "foreign", revisionId: "late", elementId: "root", opacity: 1 });
  }, { action, input });
  await expect.poll(async () => (await snapshot(page)).pending).toBe(true);
  for (const name of actions) expect(await page.evaluate(async ({ name, input }) => {
    try { await window.opacity.action(name, input); return false; } catch { return true; }
  }, { name, input })).toBe(true);
  expect(await rows(page)).toEqual(before);
  await page.evaluate(() => window.opacity.settle(false)); await expect.poll(async () => (await snapshot(page)).result).toBe("complete");
  expect((await rows(page)).revisions).toHaveLength((before.revisions as unknown[]).length + 1);
  if (action === "opacity") await publication(page, before);
});
for (const during of [false, true]) test(`native real CAS winner, no stale candidate/retry (during=${during})`, async ({ page, context }) => {
  await open(page); const input = await request(page); const prior = await snapshot(page);
  const other = await context.newPage(); await other.goto(route); await expect(other.locator("#status")).toHaveText("ready");
  const initialIds = await page.evaluate(() => window.opacity.ids.length);
  if (during) {
    await page.evaluate((input) => { window.opacity.hold(); window.opacity.launch("opacity", input); }, input);
    await expect.poll(async () => (await snapshot(page)).pending).toBe(true);
  }
  const candidate = during ? await page.evaluate(() => window.opacity.ids.at(-1)!) : null; // Eager UUID before preparation settles.
  const winner = scene(false); winner.seed = 123;
  await other.evaluate((json) => window.opacity.publish(json), JSON.stringify(winner)); const winningRows = await rows(other);
  if (during) await page.evaluate(() => window.opacity.settle(false));
  else await page.evaluate((input) => window.opacity.launch("opacity", input), input);
  await expect.poll(async () => (await snapshot(page)).result).toBe("rejected");
  const eager = await page.evaluate(() => window.opacity.ids.slice(-2));
  expect(await page.evaluate(() => window.opacity.ids.length)).toBe(initialIds + 2);
  if (during) expect(eager[1]).toBe(candidate);
  expect((winningRows.revisions as { revisionId: string }[]).some((row) => row.revisionId === eager[1])).toBe(false);
  expect(await rows(page)).toEqual(winningRows); expect((await snapshot(page)).current).toEqual(prior.current);
  expect((await snapshot(page)).pixels).toEqual(prior.pixels); await other.close();
});
test("native committed render failure is truthful; rerender the same actual current", async ({ page }) => {
  await open(page); const before = await rows(page); const prior = await snapshot(page);
  await page.evaluate((input) => { window.opacity.fault(true); window.opacity.launch("opacity", input); }, await request(page, 0));
  await expect.poll(async () => (await snapshot(page)).result).toBe("published, but rendering failed");
  const after = await publication(page, before, 0); expect((await snapshot(page)).pixels).toEqual(prior.pixels);
  await page.evaluate(() => window.opacity.fault(false)); await pixels(page, false, 0);
  expect(await rows(page)).toEqual(after); expect((await snapshot(page)).current).toEqual(current(after));
});
for (const reject of [false, true]) test(`native disposal waits, closes per lifetime and suppresses late callbacks (${reject})`, async ({ page }) => {
  await open(page); const before = await rows(page);
  await page.evaluate((input) => { window.opacity.hold(); window.opacity.launch("opacity", input); }, await request(page));
  await expect.poll(async () => (await snapshot(page)).pending).toBe(true);
  const frozen = await page.evaluate(async () => {
    const first = window.opacity.browser.dispose(); if (first !== window.opacity.browser.dispose()) throw new Error("Disposal identity changed");
    let settled = false; void first.then(() => { settled = true; });
    await Promise.resolve(); if (settled) throw new Error("Disposal did not await the held flight");
    return window.opacity.snapshot();
  });
  expect(frozen.current).toBeNull(); expect(frozen.handles.some((handle) => handle.closes === 0)).toBe(true);
  await page.evaluate((reject) => window.opacity.settle(reject), reject);
  await page.evaluate(() => window.opacity.browser.dispose()); const after = await snapshot(page);
  for (const handle of after.handles) { expect(handle.closes).toBe(1); expect(handle.useful).toBe(false); }
  for (const key of ["renders", "notifications", "dom", "pixels", "current"] as const) expect(after[key]).toEqual(frozen[key]);
  if (reject) expect(await rows(page)).toEqual(before);
  else await publication(page, before, 0.5, true);
});
