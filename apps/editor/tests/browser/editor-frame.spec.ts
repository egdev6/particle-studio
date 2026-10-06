import { expect, test } from "@playwright/test";

import type {} from "./fixtures/editor-frame.fixture.js";

const route = "/apps/editor/tests/browser/fixtures/editor-frame.fixture.html";

test("editor frames draw real PNG pixels, preserve rejected frames, and clear replacements", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(route);
  await expect(page.locator("#status")).toHaveText("passed");
  await expect(page.locator("#bitmap")).toHaveText("ImageBitmap:1x1");
  await expect(page.locator("#pixels")).toHaveText("0,0,0,255;0,0,0,255");
  await expect(page.locator("#unknown")).toHaveText("RUNTIME_IMAGE_ASSET_UNRESOLVED:true");
  await expect(page.locator("#mismatch")).toHaveText("RUNTIME_IMAGE_ASSET_METADATA_MISMATCH:true");
  await expect(page.locator("#replacement")).toHaveText("0,0,0,0;0,0,0,0;0,0,0,255");
  expect(pageErrors).toEqual([]);
});

test("editor frames apply authored shape colors and restore caller fill state", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(route);
  await expect(page.locator("#status")).toHaveText("passed");
  expect(await page.evaluate(() => window.editorFrameColors.colorShapes())).toEqual({
    defaultBlack: [0, 0, 0, 255],
    authoredOpaque: [63, 169, 245, 255],
    alphaGreen: [0, 255, 0, 128],
    particleCallerWhite: [255, 255, 255, 255],
    restoredFillStyle: "#ffffff",
  });
  expect(pageErrors).toEqual([]);
});
