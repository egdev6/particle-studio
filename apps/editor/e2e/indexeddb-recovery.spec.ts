import { expect, test } from "@playwright/test";

const VITE_SEAM_URL = "http://127.0.0.1:4173";

test("reloads a fresh IndexedDB adapter and returns its persisted recovery offer", async ({
  page,
}) => {
  const databaseName = `chromium-recovery-${Date.now()}`;
  await page.goto(`${VITE_SEAM_URL}/?indexeddb-recovery=1`);
  await expect
    .poll(() =>
      page.evaluate(() => typeof window.indexedDbRecoverySeam === "object"),
    )
    .toBe(true);
  await page.evaluate(
    (name) => window.indexedDbRecoverySeam?.seed(name),
    databaseName,
  );

  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => typeof window.indexedDbRecoverySeam === "object"),
    )
    .toBe(true);
  const offer = await page.evaluate(
    (name) => window.indexedDbRecoverySeam?.read(name),
    databaseName,
  );

  expect(offer).toMatchObject({
    offer: {
      kind: "recovery-offer",
      revision: { revisionId: "autosave-2", sequence: 2 },
    },
    diagnostics: [],
  });
});

const DURABLE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLefwAAAABJRU5ErkJggg==",
  "base64",
);
const DURABLE_PNG_SHA256 =
  "sha256:e6fd6bb6780014703cd94dfb78e8e1037cb2bdf294bdd2a8de6078089efe98a0";

function durableImageDocument(seed = 42) {
  return JSON.stringify({
    schemaVersion: 1,
    durationUs: 1_000_000,
    playbackRange: { startUs: 0, endUs: 1_000_000 },
    loop: true,
    seed,
    rootIds: ["image-1"],
    elements: [
      {
        id: "image-1",
        type: "image",
        asset: {
          sha256: DURABLE_PNG_SHA256,
          mimeType: "image/png",
          byteLength: DURABLE_PNG.byteLength,
          intrinsicWidth: 1,
          intrinsicHeight: 1,
        },
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        opacity: 1,
      },
    ],
    tracks: [],
  });
}

test("persists a visible PNG and rehydrates its durable draft after a same-context reload", async ({
  page,
}) => {
  await page.goto(VITE_SEAM_URL);
  await page.getByLabel("Image to import").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: DURABLE_PNG,
  });
  await page.getByRole("button", { name: "Import image" }).click();
  await expect(page.getByTestId("durable-asset-state")).toHaveText(
    "asset persisted",
  );

  await page.getByLabel("Editable JSON").fill(durableImageDocument());
  await page.getByRole("button", { name: "Import editable JSON" }).click();
  await expect(page.getByTestId("durable-draft-state")).toHaveText(
    "draft active",
  );
  const publishedRevision = await page
    .getByTestId("durable-revision")
    .textContent();
  expect(publishedRevision).toMatch(/^draft-/);
  await expect(page.getByTestId("scene-preview")).toBeVisible();
  await expect(page.getByTestId("transport-status")).toHaveText("paused");

  await page.reload();
  await expect(page.getByTestId("durable-rehydration-state")).toHaveText(
    "rehydrated",
  );
  await expect(page.getByTestId("durable-draft-state")).toHaveText(
    "draft active",
  );
  await expect(page.getByTestId("durable-revision")).toHaveText(
    publishedRevision!,
  );
  await expect(page.getByTestId("scene-preview")).toBeVisible();
  await expect(page.getByTestId("transport-status")).toHaveText("paused");
});

test("persists a local approval, restores it, then forks a changed draft from it", async ({
  page,
}) => {
  await page.goto(VITE_SEAM_URL);
  await page.getByLabel("Image to import").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: DURABLE_PNG,
  });
  await page.getByRole("button", { name: "Import image" }).click();
  await page.getByLabel("Editable JSON").fill(durableImageDocument());
  await page.getByRole("button", { name: "Import editable JSON" }).click();
  await expect(
    page.getByRole("button", { name: "Approve local snapshot" }),
  ).toBeEnabled();

  await page.getByRole("button", { name: "Approve local snapshot" }).click();
  await expect(page.getByTestId("approval-state")).toHaveText("approved");
  const approvedRevision = await page
    .getByTestId("approval-revision")
    .textContent();
  const approvedHash = await page
    .getByTestId("approval-snapshot-hash")
    .textContent();
  await expect(page.getByTestId("approval-snapshot-hash")).toHaveText(
    /^sha256:[a-f0-9]{64}$/,
  );

  await page.reload();
  await expect(page.getByTestId("approval-state")).toHaveText("approved");
  await expect(page.getByTestId("approval-revision")).toHaveText(
    approvedRevision!,
  );

  await page.getByLabel("Editable JSON").fill(durableImageDocument(43));
  await page.getByRole("button", { name: "Import editable JSON" }).click();
  await expect(page.getByTestId("durable-draft-state")).toHaveText(
    "draft active",
  );
  await expect(page.getByTestId("durable-revision")).not.toHaveText(
    approvedRevision!,
  );
  await expect(page.getByTestId("approval-state")).toHaveText("draft");
  await expect(page.getByTestId("approval-parent-hash")).toHaveText(
    approvedHash!,
  );
  await expect(page.getByTestId("approval-invalidation-reason")).toHaveText(
    "content",
  );

  await page.reload();
  await expect(page.getByTestId("approval-parent-hash")).toHaveText(
    approvedHash!,
  );
});
