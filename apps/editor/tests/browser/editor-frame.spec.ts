import { expect, test } from "@playwright/test";

test("editor frames draw real PNG pixels, preserve rejected frames, and clear replacements", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/apps/editor/tests/browser/fixtures/editor-frame.fixture.html");
  await expect(page.locator("#status")).toHaveText("passed");
  await expect(page.locator("#bitmap")).toHaveText("ImageBitmap:1x1");
  await expect(page.locator("#pixels")).toHaveText("255,255,255,255;0,0,0,255");
  await expect(page.locator("#unknown")).toHaveText("RUNTIME_IMAGE_ASSET_UNRESOLVED:true");
  await expect(page.locator("#mismatch")).toHaveText("RUNTIME_IMAGE_ASSET_METADATA_MISMATCH:true");
  await expect(page.locator("#replacement")).toHaveText("0,0,0,0;0,0,0,0;255,255,255,255");
  expect(pageErrors).toEqual([]);
});
