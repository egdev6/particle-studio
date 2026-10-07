import { Buffer } from "node:buffer";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

// Genuine 1x1 black PNG bytes, the same canonical asset the sibling production specs import.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

const action = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const field = (page: Page, name: string) => page.getByLabel(name, { exact: true });
const selector = (page: Page) => page.getByRole("combobox", { name: "Scene element", exact: true });
const details = (page: Page) => field(page, "Published element JSON");
const status = (page: Page, name: string) => page.getByRole("status", { name, exact: true });
const inspector = (page: Page) => status(page, "Element inspection status");
const revision = (text: string | null) => text?.match(/Published source ([^.]+)\./)?.[1] ?? "";
const pixel = (page: Page, x: number, y: number) =>
  page.locator("#scene").evaluate((canvas: HTMLCanvasElement, point: number[]) =>
    Array.from(canvas.getContext("2d")!.getImageData(point[0]!, point[1]!, 1, 1).data), [x, y]);
async function element(page: Page) {
  return JSON.parse((await details(page).textContent())!) as Record<string, unknown>;
}
async function apply(page: Page, name: string, statusName: string) {
  await action(page, name).click();
  await expect(status(page, statusName)).toContainText("complete");
  await expect(selector(page)).toHaveValue("");
}
// Public layout guard: the document must not scroll horizontally and must not hide or clip
// overflow, so a clipped viewport can never masquerade as a fixed one.
async function expectNoHorizontalOverflow(page: Page) {
  const layout = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      rootOverflowX: root.overflowX,
      bodyOverflowX: body.overflowX,
    };
  });
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  for (const overflowX of [layout.rootOverflowX, layout.bodyOverflowX]) {
    expect(overflowX).not.toBe("hidden");
    expect(overflowX).not.toBe("clip");
  }
}
// Full-page and canvas PNGs are attached as review artifacts, never as brittle baseline snapshots.
async function shot(page: Page, testInfo: TestInfo, name: string) {
  await expectNoHorizontalOverflow(page);
  const full = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: full, fullPage: true });
  await testInfo.attach(name, { path: full, contentType: "image/png" });
  const canvas = testInfo.outputPath(`${name}-canvas.png`);
  await page.locator("#scene").screenshot({ path: canvas });
  await testInfo.attach(`${name}-canvas`, { path: canvas, contentType: "image/png" });
}
// One root group plus one shape and one line sibling; the line sits away from every shape pixel.
const scene = (nested = false, rootVisible = true) => ({
  schemaVersion: 1, durationUs: 1_000_000, seed: 99, loop: false,
  playbackRange: { startUs: 0, endUs: 1_000_000 }, tracks: [],
  rootIds: nested ? ["root"] : ["root", "shape"],
  elements: [
    { id: "root", type: "group", childrenIds: nested ? ["shape", "line"] : ["line"], transform: [1, 0, 0, 1, 24, 12], visible: rootVisible },
    { id: "shape", type: "shape", x: 16, y: 24, width: 40, height: 20, opacity: 1 },
    { id: "line", type: "line", x1: 190, y1: 110, x2: 200, y2: 120, opacity: 1 },
  ],
});
async function importScene(page: Page, nested: boolean, rootVisible = true) {
  await field(page, "Editable JSON").fill(JSON.stringify(scene(nested, rootVisible)));
  await action(page, "Import editable JSON").click();
  await expect(page.locator("#status")).toContainText("Import complete");
}

// The whole public production journey: every one of the nine product actions is exercised
// through real DOM controls, then verified through public metadata, status lines and canvas paint.
async function journey(page: Page, testInfo: TestInfo, nested: boolean) {
  const anchor = { x: nested ? 48 : 24, y: nested ? 116 : 104 };
  const editors = ["Apply position", "Apply dimensions", "Apply opacity", "Apply fill color", "Apply visibility"];

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("unpersisted sample");
  await expectNoHorizontalOverflow(page);
  for (const name of editors) await expect(action(page, name)).toBeDisabled();

  // Create blank scene is enabled on the healthy sample; the fresh root has no shape and no paint.
  await action(page, "Create blank scene").click();
  await expect(page.locator("#status")).toContainText("Scene created");
  expect(await pixel(page, 4, 4)).toEqual([0, 0, 0, 0]);
  await expect(selector(page).locator('option[value="shape"]')).toHaveCount(0);

  // Add rectangle: the new shape UUID is derived from the public option list, never hardcoded.
  for (const [key, value] of Object.entries({ x: 2, y: 2, width: 6, height: 6 })) await field(page, `Rectangle ${key}`).fill(String(value));
  await action(page, "Add rectangle").click();
  await expect(status(page, "Rectangle creation status")).toContainText("complete");
  const rectangleId = await selector(page).locator("option").last().getAttribute("value");
  expect(rectangleId).toMatch(/^image-[0-9a-f-]{36}$/);
  await selector(page).selectOption(rectangleId!);
  expect(await element(page)).toMatchObject({ id: rectangleId, type: "shape", x: 2, y: 2, width: 6, height: 6, opacity: 1 });
  expect(await pixel(page, 4, 4)).toEqual([0, 0, 0, 255]);
  await shot(page, testInfo, "01-blank-rectangle");

  // Import the authored own scene; authored local values are inspected, not baked world transforms.
  await importScene(page, nested);
  for (const id of ["shape", "root", "line"]) await expect(selector(page).locator(`option[value="${id}"]`)).toHaveCount(1);
  await selector(page).selectOption("shape");
  const authored = await element(page);
  expect(authored).toMatchObject({ x: 16, y: 24 });
  expect(authored).not.toHaveProperty("visible");
  expect(authored).not.toHaveProperty("fillColor");
  await expect(field(page, "Shape visible")).toBeChecked();
  await selector(page).selectOption("root");
  expect((await element(page)).transform).toEqual([1, 0, 0, 1, 24, 12]);
  await selector(page).selectOption("shape");

  // Position and dimensions edit authored local geometry and clear the selection source epoch.
  await field(page, "Position X").fill("20");
  await field(page, "Position Y").fill("100");
  await apply(page, "Apply position", "Position status");
  await selector(page).selectOption("shape");
  expect(await pixel(page, anchor.x, anchor.y)).toEqual([0, 0, 0, 255]);
  await field(page, "Dimension width").fill("24");
  await field(page, "Dimension height").fill("14");
  await apply(page, "Apply dimensions", "Dimension status");
  await selector(page).selectOption("shape");
  expect(await element(page)).toMatchObject({ id: "shape", x: 20, y: 100, width: 24, height: 14 });
  await shot(page, testInfo, "02-geometry");

  // Fill color keeps the authored #AbC123 case; opacity halves the alpha with premultiplied tolerance.
  await field(page, "Shape fill color").fill("#AbC123");
  await apply(page, "Apply fill color", "Fill color status");
  await selector(page).selectOption("shape");
  expect((await element(page)).fillColor).toBe("#AbC123");
  expect(await pixel(page, anchor.x, anchor.y)).toEqual([171, 193, 35, 255]);
  await field(page, "Shape opacity").fill("0.5");
  await apply(page, "Apply opacity", "Opacity status");
  await selector(page).selectOption("shape");
  expect((await element(page)).opacity).toBe(0.5);
  const styled = await pixel(page, anchor.x, anchor.y);
  expect(styled[3]).toBe(128);
  for (const [index, channel] of [171, 193, 35].entries()) expect(Math.abs(styled[index]! - channel)).toBeLessThanOrEqual(1);
  await shot(page, testInfo, "03-styled");

  // PNG import inserts the canonical asset at 180/40; its own metadata is public through the inspector.
  await field(page, "PNG file").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: png });
  for (const [key, value] of Object.entries({ x: 180, y: 40, width: 8, height: 8 })) await field(page, `PNG ${key}`).fill(String(value));
  await action(page, "Import PNG").click();
  await expect(status(page, "PNG import status")).toContainText("complete");
  expect(await pixel(page, 181, 45)).toEqual([0, 0, 0, 255]);
  const imageId = await selector(page).locator("option").filter({ hasText: "(image)" }).getAttribute("value");
  await selector(page).selectOption(imageId!);
  expect(await element(page)).toMatchObject({ id: imageId, type: "image", asset: { mimeType: "image/png" } });
  await expectNoHorizontalOverflow(page);
  await selector(page).selectOption("shape");

  // Hiding the shape removes its paint while the imported PNG stays untouched.
  await field(page, "Shape visible").uncheck();
  await apply(page, "Apply visibility", "Visibility status");
  await selector(page).selectOption("shape");
  expect((await element(page)).visible).toBe(false);
  expect(await pixel(page, anchor.x, anchor.y)).toEqual([0, 0, 0, 0]);
  expect(await pixel(page, 181, 45)).toEqual([0, 0, 0, 255]);
  await shot(page, testInfo, "04-hidden-png");

  // Reload restores the same draft: hidden shape stays hidden, every authored value survives.
  await page.reload();
  await expect(page.locator("#status")).toContainText("restored draft");
  await expect(selector(page)).toHaveValue("");
  expect(await pixel(page, anchor.x, anchor.y)).toEqual([0, 0, 0, 0]);
  expect(await pixel(page, 181, 45)).toEqual([0, 0, 0, 255]);
  await shot(page, testInfo, "05-restored");
  await selector(page).selectOption("shape");
  expect(await element(page)).toMatchObject({ x: 20, y: 100, width: 24, height: 14, opacity: 0.5, fillColor: "#AbC123", visible: false });
  await expect(field(page, "Shape visible")).toBeEnabled();
  await expect(field(page, "Shape visible")).not.toBeChecked();

  // Re-showing publishes explicit true; an equal explicit Apply still republishes a new revision.
  await field(page, "Shape visible").check();
  await apply(page, "Apply visibility", "Visibility status");
  await selector(page).selectOption("shape");
  expect((await element(page)).visible).toBe(true);
  expect((await pixel(page, anchor.x, anchor.y))[3]).toBe(128);
  const firstRevision = revision(await inspector(page).textContent());
  await apply(page, "Apply visibility", "Visibility status");
  await selector(page).selectOption("shape");
  const secondRevision = revision(await inspector(page).textContent());
  expect(secondRevision.length).toBeGreaterThan(0);
  expect(secondRevision).not.toBe(firstRevision);

  // A second reload keeps the explicit source revision and the final authored metadata plus paint.
  await page.reload();
  await expect(page.locator("#status")).toContainText("restored draft");
  await selector(page).selectOption("shape");
  expect(await inspector(page).textContent()).toContain(secondRevision);
  expect(await element(page)).toMatchObject({ id: "shape", x: 20, y: 100, width: 24, height: 14, opacity: 0.5, fillColor: "#AbC123", visible: true });
  expect((await pixel(page, anchor.x, anchor.y))[3]).toBe(128);
  expect(await pixel(page, 181, 45)).toEqual([0, 0, 0, 255]);
  await shot(page, testInfo, "06-final");
}

const viewports = { desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 900 } };
for (const nested of [false, true]) {
  for (const [viewport, size] of Object.entries(viewports)) test(
    `production journey: ${nested ? "nested" : "root"} shape flow on ${viewport} viewport (nested=${nested}, viewport=${viewport})`,
    async ({ page }, testInfo) => {
      await page.setViewportSize(size);
      await journey(page, testInfo, nested);
    });
}

// A hidden ancestor keeps the authored visibility default and publishes only the shape's own flag.
test("production journey: a hidden ancestor keeps the authored default and publishes only the shape", async ({ page }, testInfo) => {
  await page.setViewportSize(viewports.desktop);
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("unpersisted sample");
  await importScene(page, true, false);
  await selector(page).selectOption("shape");
  await expect(field(page, "Shape visible")).toBeEnabled();
  await expect(field(page, "Shape visible")).toBeChecked();
  await expect(status(page, "Visibility status")).toContainText("hidden ancestor");
  expect(await pixel(page, 50, 40)).toEqual([0, 0, 0, 0]);
  await action(page, "Apply visibility").click();
  await expect(status(page, "Visibility status")).toContainText("complete");
  await expect(selector(page)).toHaveValue("");
  await selector(page).selectOption("shape");
  expect(await element(page)).toHaveProperty("visible", true);
  await selector(page).selectOption("root");
  expect(await element(page)).toHaveProperty("visible", false);
  for (const name of ["Apply position", "Apply dimensions", "Apply opacity", "Apply fill color", "Apply visibility"]) {
    await expect(action(page, name)).toBeDisabled();
  }
  await shot(page, testInfo, "ancestor");
  await page.reload();
  await expect(page.locator("#status")).toContainText("restored draft");
  await selector(page).selectOption("root");
  expect(await element(page)).toHaveProperty("visible", false);
  await selector(page).selectOption("shape");
  expect(await element(page)).toHaveProperty("visible", true);
  expect(await pixel(page, 50, 40)).toEqual([0, 0, 0, 0]);
});

// Non-shape guards stay read-only; rejected edits publish nothing; one explicit correction then publishes.
test("production journey: non-shape guards and rejected edits leave the publication unchanged", async ({ page }, testInfo) => {
  await page.setViewportSize(viewports.desktop);
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("unpersisted sample");
  await importScene(page, false);
  const editors = ["Apply position", "Apply dimensions", "Apply opacity", "Apply fill color", "Apply visibility"];
  for (const id of ["root", "line"]) {
    await selector(page).selectOption(id);
    for (const name of editors) await expect(action(page, name)).toBeDisabled();
  }
  await shot(page, testInfo, "guards-non-shape");

  await selector(page).selectOption("shape");
  const source = (await inspector(page).textContent())!;
  const before = await element(page);
  const frame = await pixel(page, 20, 30);
  await field(page, "Position X").fill("");
  await action(page, "Apply position").click();
  await expect(status(page, "Position status")).toContainText("requires nonempty finite");
  await field(page, "Position X").fill("16");
  await field(page, "Dimension width").fill("0");
  await action(page, "Apply dimensions").click();
  await expect(status(page, "Dimension status")).toContainText("finite positive");
  await field(page, "Dimension width").fill("40");
  await field(page, "Shape opacity").fill("1.1");
  await action(page, "Apply opacity").click();
  await expect(status(page, "Opacity status")).toContainText("from 0 to 1");
  await field(page, "Shape opacity").fill("1");
  await field(page, "Shape fill color").fill("#ABC");
  await action(page, "Apply fill color").click();
  await expect(status(page, "Fill color status")).toContainText("exact seven-character");
  expect(await inspector(page).textContent()).toBe(source);
  expect(await element(page)).toEqual(before);
  expect(await pixel(page, 20, 30)).toEqual(frame);

  await field(page, "Shape fill color").fill("#00FF00");
  await apply(page, "Apply fill color", "Fill color status");
  await selector(page).selectOption("shape");
  expect((await element(page)).fillColor).toBe("#00FF00");
  expect(await pixel(page, 20, 30)).toEqual([0, 255, 0, 255]);

  await field(page, "Editable JSON").fill("{");
  await action(page, "Import editable JSON").click();
  await expect(page.locator("#status")).toContainText("import failed");
  await selector(page).selectOption("shape");
  expect((await element(page)).fillColor).toBe("#00FF00");
});
