import { expect, test } from "@playwright/test";

import type { Page } from "@playwright/test";

const DEEP_PATH = "/scenes/first/edit";

type AssetResponse = { href: string; pathname: string; status: number };

function collectScriptAndStyleResponses(page: Page): AssetResponse[] {
  const responses: AssetResponse[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (/\.(js|mjs|css)$/.test(url.pathname)) {
      responses.push({
        href: url.href,
        pathname: url.pathname,
        status: response.status(),
      });
    }
  });
  return responses;
}
test("deep fallback route loads the editor shell from root-absolute assets", async ({
  page,
}) => {
  const assetResponses = collectScriptAndStyleResponses(page);

  await page.goto(DEEP_PATH);

  await expect(page).toHaveTitle("Particle Studio");
  await expect(
    page.getByRole("heading", { name: "Editor foundation" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "This static shell establishes the UI boundary without loading a scene or editing product data.",
    ),
  ).toBeVisible();

  expect(
    assetResponses.length,
    "the editor shell must load through script and style assets",
  ).toBeGreaterThan(0);
  for (const asset of assetResponses) {
    expect(
      asset.pathname.startsWith("/assets/"),
      `${asset.href} must resolve from root /assets/, not beneath the deep path`,
    ).toBe(true);
    expect(asset.status, asset.href).toBe(200);
  }
});

test("root navigation loads the editor shell from the same root-absolute assets", async ({
  page,
}) => {
  const assetResponses = collectScriptAndStyleResponses(page);

  await page.goto("/");

  await expect(page).toHaveTitle("Particle Studio");
  await expect(
    page.getByRole("heading", { name: "Editor foundation" }),
  ).toBeVisible();

  expect(assetResponses.length).toBeGreaterThan(0);
  for (const asset of assetResponses) {
    expect(
      asset.pathname.startsWith("/assets/"),
      `${asset.href} must resolve from root /assets/`,
    ).toBe(true);
    expect(asset.status, asset.href).toBe(200);
  }
});
