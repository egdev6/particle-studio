import { expect, test, type Page } from "@playwright/test";
import type { SceneDocumentV1 } from "@particle-studio/scene-document";
import type { ShapeDimensionsRequest } from "../../src/editor-session.js";
import { BROWSER_DOCUMENT, nativeRows } from "../raw-indexeddb-seed.js";
import type {} from "./fixtures/browser-dimensions-api.fixture.js";

const route = "/apps/editor/tests/browser/fixtures/browser-dimensions-api.fixture.html";
const actions = ["json", "blank", "png", "rectangle", "position", "dimensions"];
const scene = (nested: boolean): SceneDocumentV1 => ({
  schemaVersion: 1, durationUs: 1_000_000, seed: 99, loop: false,
  playbackRange: { startUs: 500_000, endUs: 900_000 }, rootIds: nested ? ["root"] : ["shape", "root"],
  elements: [{ id: "root", type: "group", childrenIds: nested ? ["shape"] : [], transform: [1, 0, 0, 1, 30, 10] },
    { id: "shape", type: "shape", x: 16, y: 24, width: 0, height: -1, opacity: 1 }],
  tracks: [{ elementId: "shape", property: "opacity", interpolation: "linear", easing: "linear",
    keyframes: [{ timeUs: 0, value: 0.25 }, { timeUs: 1_000_000, value: 0.75 }] }],
});
const snapshot = (page: Page) => page.evaluate(() => window.dimensions.snapshot());
async function open(page: Page, nested = false, blank = false) {
  await page.goto(route); await expect(page.locator("#status")).toHaveText("ready");
  if (!blank) {
    await page.evaluate((json) => window.dimensions.publish(json), JSON.stringify(scene(nested)));
    await page.evaluate(() => window.dimensions.action("png", {} as ShapeDimensionsRequest));
    await page.evaluate(() => window.dimensions.render());
    expect((await snapshot(page)).current?.document.elements[1]).toMatchObject({ width: 0, height: -1 });
    expect(await page.evaluate(() => typeof window.dimensions.browser.setShapeDimensions)).toBe("function");
  }
}
async function request(page: Page): Promise<ShapeDimensionsRequest> {
  const current = (await snapshot(page)).current!;
  return { documentId: current.documentId, revisionId: current.revisionId, elementId: "shape", width: 40, height: 20 };
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
async function publication(page: Page, before: Rows, width = 40, height = 20) {
  const after = await rows(page); const prior = current(before); const next = current(after);
  const document = structuredClone(prior.document); Object.assign(document.elements.find((element) => element.id === "shape")!, { width, height });
  const json = JSON.stringify(document, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  const canonicalBytes = Array.from(new TextEncoder().encode(json));
  expect(next.revisionId).not.toBe(prior.revisionId);
  expect(next).toEqual({ documentId: BROWSER_DOCUMENT, revisionId: next.revisionId, sequence: prior.sequence + 1,
    document, canonicalBytes, canonicalization: { identifier: "jcs-1", byteLength: canonicalBytes.length } });
  expect(ordered(after)).toEqual(ordered({ ...before, revisions: [...before.revisions as unknown[], next],
    pointers: [{ documentId: BROWSER_DOCUMENT, saved: (before.pointers as { saved: unknown }[])[0]!.saved,
      draft: { kind: "draft", documentId: BROWSER_DOCUMENT, revisionId: next.revisionId, sequence: next.sequence } }] }));
  return after;
}
for (const nested of [false, true]) test(`native dimensions canonical history, equal publication and useful PNG (nested=${nested})`, async ({ page }) => {
  await open(page, nested); let before = await rows(page); const prior = current(before);
  const pointers = (before.pointers as { draft: { revisionId: string; sequence: number } }[])[0]!;
  await nativeRows(page, { pointers: [{ documentId: BROWSER_DOCUMENT, draft: pointers.draft,
    saved: { ...pointers.draft, kind: "saved" } }] });
  await page.reload(); await expect(page.locator("#status")).toHaveText("ready"); // Public start reloads the full saved/draft prior.
  before = await rows(page); const retained = (await snapshot(page)).handles.filter((handle) => handle.closes === 0);
  expect(retained).toHaveLength(1); expect(retained[0]!.useful).toBe(true);
  const png = await page.evaluate(() => window.dimensions.png);
  expect(before.assets).toEqual([{ sha256: "sha256:431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460",
    mimeType: "image/png", byteLength: png.length, bytes: png }]);
  const input = await request(page); const ids = await page.evaluate(() => window.dimensions.ids.length);
  await page.evaluate((input) => window.dimensions.action("dimensions", input), input);
  expect(await page.evaluate(() => window.dimensions.ids.length)).toBe(ids + 2); // Command + revision, never an element ID.
  const after = await publication(page, before); await page.evaluate(() => window.dimensions.render());
  expect(await page.locator("#scene").evaluate((canvas: HTMLCanvasElement, nested) =>
    Array.from(canvas.getContext("2d")!.getImageData(nested ? 50 : 20, nested ? 40 : 30, 1, 1).data), nested)).toEqual([0, 0, 0, 64]);
  expect((await snapshot(page)).current).toMatchObject(current(after));
  await page.evaluate((input) => window.dimensions.action("dimensions", input), await request(page));
  const equal = await publication(page, after); expect(current(equal).document).toEqual(current(after).document);
  for (const handle of (await snapshot(page)).handles) {
    expect(handle.closes).toBe(retained.some((item) => item.id === handle.id) ? 0 : 1);
    expect(handle.useful).toBe(handle.closes === 0);
  }
  expect(current(equal).document.elements.map((element) => element.id)).toEqual(prior.document.elements.map((element) => element.id));
  expect(await page.evaluate(() => "release" in window.dimensions.browser.current!)).toBe(false);
  await page.reload(); await expect(page.locator("#status")).toHaveText("ready"); expect(await rows(page)).toEqual(equal);
});
test("native source/type/pair guards, reused IDs and same-source rejection retain all rows", async ({ page }) => {
  await open(page); const input = await request(page); const before = await rows(page);
  const ids = await page.evaluate(() => window.dimensions.ids.length);
  for (const invalid of [{ documentId: "foreign" }, { revisionId: "old" }, { elementId: "absent" }, { elementId: "root" },
    { width: 0 }, { height: -1 }, { width: NaN }, { height: Infinity }]) {
    expect(await page.evaluate(async (input) => { try { await window.dimensions.action("dimensions", input); return false; } catch { return true; } }, { ...input, ...invalid })).toBe(true);
  }
  expect(await page.evaluate(() => window.dimensions.ids.length)).toBe(ids); expect(await rows(page)).toEqual(before);
  await page.evaluate((input) => { window.dimensions.hold(); window.dimensions.launch("dimensions", input); }, input);
  await expect.poll(async () => (await snapshot(page)).pending).toBe(true);
  await page.evaluate(() => window.dimensions.settle(true)); await expect.poll(async () => (await snapshot(page)).result).toBe("rejected");
  expect(await rows(page)).toEqual(before); expect((await snapshot(page)).current).toMatchObject(current(before));
  await page.evaluate((input) => window.dimensions.action("dimensions", input), input); await publication(page, before);
  await page.evaluate((json) => window.dimensions.publish(json), JSON.stringify(scene(false))); const replacement = await rows(page);
  expect(await page.evaluate(async (input) => { try { await window.dimensions.action("dimensions", input); return false; } catch { return true; } }, input)).toBe(true);
  expect(await rows(page)).toEqual(replacement);
});
test("native sequence exhaustion rejects before UUIDs or durable effects after public reload", async ({ page }) => {
  await open(page); const before = await rows(page); const prior = current(before);
  await nativeRows(page, { revisions: [{ ...prior, sequence: Number.MAX_SAFE_INTEGER }],
    pointers: [{ documentId: BROWSER_DOCUMENT, saved: null,
      draft: { kind: "draft", documentId: BROWSER_DOCUMENT, revisionId: prior.revisionId, sequence: Number.MAX_SAFE_INTEGER } }] });
  await page.reload(); await expect(page.locator("#status")).toHaveText("ready");
  const exhausted = await rows(page); const ids = await page.evaluate(() => window.dimensions.ids.length);
  expect(await page.evaluate(async (input) => { try { await window.dimensions.action("dimensions", input); return false; } catch { return true; } }, await request(page))).toBe(true);
  expect(await page.evaluate(() => window.dimensions.ids.length)).toBe(ids); expect(await rows(page)).toEqual(exhausted);
});
for (const action of actions) test(`native held ${action} excludes all six direct owned actions`, async ({ page }) => {
  await open(page, false, action === "blank"); const before = await rows(page);
  const input = action === "blank" ? { documentId: BROWSER_DOCUMENT, revisionId: "absent", elementId: "shape", width: 40, height: 20 } : await request(page);
  await page.evaluate(({ action, input }) => {
    window.dimensions.hold(); window.dimensions.launch(action, input);
    if (action === "dimensions") Object.assign(input, { documentId: "foreign", revisionId: "late", elementId: "root", width: 999, height: 999 });
  }, { action, input });
  await expect.poll(async () => (await snapshot(page)).pending).toBe(true);
  for (const name of actions) expect(await page.evaluate(async ({ name, input }) => {
    try { await window.dimensions.action(name, input); return false; } catch { return true; }
  }, { name, input })).toBe(true);
  expect(await rows(page)).toEqual(before);
  await page.evaluate(() => window.dimensions.settle(false)); await expect.poll(async () => (await snapshot(page)).result).toBe("complete");
  expect((await rows(page)).revisions).toHaveLength((before.revisions as unknown[]).length + 1);
  if (action === "dimensions") await publication(page, before);
});
for (const during of [false, true]) test(`native CAS winner prevents retarget/retry (during=${during})`, async ({ page, context }) => {
  await open(page); const input = await request(page); const prior = await snapshot(page);
  const other = await context.newPage(); await other.goto(route); await expect(other.locator("#status")).toHaveText("ready");
  if (during) {
    await page.evaluate((input) => { window.dimensions.hold(); window.dimensions.launch("dimensions", input); }, input);
    await expect.poll(async () => (await snapshot(page)).pending).toBe(true);
  }
  const candidate = during ? await page.evaluate(() => window.dimensions.ids.at(-1)!) : null;
  const winner = scene(false); winner.seed = 123;
  await other.evaluate((json) => window.dimensions.publish(json), JSON.stringify(winner)); const winningRows = await rows(other);
  if (during) await page.evaluate(() => window.dimensions.settle(false));
  else await page.evaluate((input) => window.dimensions.launch("dimensions", input), input);
  await expect.poll(async () => (await snapshot(page)).result).toBe("rejected");
  expect(await rows(page)).toEqual(winningRows); expect((await snapshot(page)).current).toEqual(prior.current);
  if (candidate) expect((winningRows.revisions as { revisionId: string }[]).some((row) => row.revisionId === candidate)).toBe(false);
  expect((await snapshot(page)).pixels).toEqual(prior.pixels); await other.close();
});
test("native committed current survives render failure without rollback", async ({ page }) => {
  await open(page); const before = await rows(page); const prior = await snapshot(page);
  await page.evaluate((input) => { window.dimensions.fault(true); window.dimensions.launch("dimensions", input); }, await request(page));
  await expect.poll(async () => (await snapshot(page)).result).toBe("published, but rendering failed");
  const after = await publication(page, before); expect((await snapshot(page)).current).toMatchObject(current(after));
  expect((await snapshot(page)).pixels).toEqual(prior.pixels);
});
for (const reject of [false, true]) test(`native disposal awaits owned dimensions without late rendering/DOM/notify (reject=${reject})`, async ({ page }) => {
  await open(page); const before = await rows(page);
  await page.evaluate((input) => { window.dimensions.hold(); window.dimensions.launch("dimensions", input); }, await request(page));
  await expect.poll(async () => (await snapshot(page)).pending).toBe(true);
  const frozen = await page.evaluate(() => {
    const first = window.dimensions.browser.dispose(); if (first !== window.dimensions.browser.dispose()) throw new Error("Disposal identity changed");
    return window.dimensions.snapshot();
  });
  expect(frozen.current).toBeNull(); expect(frozen.handles.filter((handle) => handle.closes === 0)).toHaveLength(1);
  await page.evaluate((reject) => window.dimensions.settle(reject), reject);
  await page.evaluate(() => window.dimensions.browser.dispose()); const after = await snapshot(page);
  for (const handle of after.handles) { expect(handle.closes).toBe(1); expect(handle.useful).toBe(false); }
  for (const key of ["renders", "notifications", "dom", "pixels", "current"] as const) expect(after[key]).toEqual(frozen[key]);
  if (reject) expect(await rows(page)).toEqual(before); else await publication(page, before);
});
