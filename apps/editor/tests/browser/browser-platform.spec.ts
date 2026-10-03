import { expect, test } from "@playwright/test";

test("browser adapters hash and decode a verified PNG and reject corrupt bytes", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/apps/editor/tests/browser/fixtures/browser-png-platform.html");
  await expect(page.locator("#status")).toHaveText("passed");
  await expect(page.locator("#hash")).toHaveText(
    "sha256:431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460",
  );
  await expect(page.locator("#bitmap")).toHaveText("ImageBitmap:1x1:1x1");
  await expect(page.locator("#failure")).toHaveText("EDITOR_PNG_DECODE_FAILED");
  expect(pageErrors).toEqual([]);
});
