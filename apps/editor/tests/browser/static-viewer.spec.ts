import { expect, test } from "@playwright/test";

test("built preview renders the first-slice scene at playback start", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Static example viewer" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Rendered example at 0 µs.");
  const canvas = page.locator("#scene");
  const pixels = await canvas.evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext("2d")!;
    return {
      width: element.width,
      height: element.height,
      inside: Array.from(context.getImageData(60, 60, 1, 1).data),
      outside: Array.from(context.getImageData(240, 10, 1, 1).data),
    };
  });
  expect([pixels.width, pixels.height]).toEqual([256, 160]);
  expect(pixels.inside.slice(0, 3)).toEqual([0, 0, 0]);
  expect(pixels.inside[3]).toBeGreaterThanOrEqual(63);
  expect(pixels.inside[3]).toBeLessThanOrEqual(64);
  expect(pixels.outside).toEqual([0, 0, 0, 0]);
  expect(pageErrors).toEqual([]);
});

test("unavailable Canvas2D context reports an error, not a rendered scene", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.getContext = () => null;
  });
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText(
    "Error: Canvas2D context is unavailable.",
  );
  await expect(page.getByRole("status")).toBeVisible();
  await expect(page.getByRole("status")).not.toContainText("Rendered");
  expect(pageErrors).toEqual([]);
});
