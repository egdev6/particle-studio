import { expect, test } from "@playwright/test";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/VscvDQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_SHA256 =
  "sha256:49e1dad481e94dfab7c9573a9a81d56aa2ca629fe15a3f7a910aa4f47601c00d";

const IMAGE_DOCUMENT = {
  schemaVersion: 1,
  durationUs: 1_000_000,
  playbackRange: { startUs: 0, endUs: 1_000_000 },
  loop: true,
  seed: 42,
  rootIds: ["image-1"],
  elements: [
    {
      id: "image-1",
      type: "image",
      asset: {
        sha256: PNG_SHA256,
        mimeType: "image/png",
        byteLength: PNG.byteLength,
        intrinsicWidth: 1,
        intrinsicHeight: 1,
      },
      x: 2,
      y: 3,
      width: 4,
      height: 5,
      opacity: 1,
    },
  ],
  tracks: [],
};

test("exports a directly approved durable image document as one self-contained time-zero HTML download", async ({
  page,
  browser,
}) => {
  await page.addInitScript(() => {
    const draws: unknown[] = [];
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (
      source,
      x,
      y,
      width,
      height,
    ) {
      draws.push({
        source: source.constructor.name,
        sourceWidth: (source as ImageBitmap).width,
        sourceHeight: (source as ImageBitmap).height,
        x,
        y,
        width,
        height,
      });
      return original.call(this, source, x, y, width, height);
    };
    (
      window as unknown as Window & { editorExportDraws: unknown[] }
    ).editorExportDraws = draws;
  });
  await page.goto("/");

  await page.getByLabel("Image to import").setInputFiles({
    name: "fixture.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await page.getByRole("button", { name: "Import image" }).click();
  await expect(page.getByTestId("durable-asset-state")).toHaveText(
    "asset persisted",
  );

  await page.getByLabel("Editable JSON").fill(JSON.stringify(IMAGE_DOCUMENT));
  await page.evaluate(() => {
    (
      window as unknown as Window & { editorExportDraws: unknown[] }
    ).editorExportDraws.length = 0;
  });
  await page.getByRole("button", { name: "Import editable JSON" }).click();
  await expect(page.getByTestId("durable-draft-state")).toHaveText(
    "draft active",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as Window & { editorExportDraws: unknown[] })
            .editorExportDraws,
      ),
    )
    .toEqual([
      {
        source: "ImageBitmap",
        sourceWidth: 1,
        sourceHeight: 1,
        x: 2,
        y: 3,
        width: 4,
        height: 5,
      },
    ]);
  const previewDraws = await page.evaluate(
    () =>
      (window as unknown as Window & { editorExportDraws: unknown[] })
        .editorExportDraws,
  );
  await expect(page.getByTestId("preview-time-us")).toHaveText("0");

  await page.getByRole("button", { name: "Approve local snapshot" }).click();
  await expect(page.getByTestId("export-state")).toHaveText("ready");
  await expect(
    page.getByRole("button", { name: "Download approved HTML" }),
  ).toBeEnabled();

  const downloads: string[] = [];
  page.on("download", (download) =>
    downloads.push(download.suggestedFilename()),
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download approved HTML" }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  if (stream === null) throw new Error("EDITOR_EXPORT_DOWNLOAD_MISSING");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);

  expect(downloads).toEqual(["particle-studio.html"]);
  expect(download.suggestedFilename()).toBe("particle-studio.html");
  expect(bytes.byteLength).toBeGreaterThan(0);

  const standaloneOrigin = "https://downloaded-export.test";
  const standaloneUrl = `${standaloneOrigin}/editor-export/particle-studio.html`;
  const exportedContext = await browser.newContext();
  try {
    const exportedPage = await exportedContext.newPage();
    const requests: string[] = [];
    exportedPage.on("request", (request) => {
      const url = new URL(request.url());
      if (url.protocol === "http:" || url.protocol === "https:") {
        requests.push(url.href);
      }
    });
    await exportedPage.addInitScript(() => {
      const draws: unknown[] = [];
      const storageAtDocumentStart = {
        cookie: document.cookie,
        localStorageKeys: Object.keys(localStorage),
        sessionStorageKeys: Object.keys(sessionStorage),
        databaseNames: null as string[] | null,
      };
      const original = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (
        source,
        x,
        y,
        width,
        height,
      ) {
        draws.push({
          source: source.constructor.name,
          sourceWidth: (source as ImageBitmap).width,
          sourceHeight: (source as ImageBitmap).height,
          x,
          y,
          width,
          height,
        });
        return original.call(this, source, x, y, width, height);
      };
      (
        window as unknown as Window & {
          downloadedExportDraws: unknown[];
          downloadedExportStorageAtDocumentStart: typeof storageAtDocumentStart;
        }
      ).downloadedExportDraws = draws;
      (
        window as unknown as Window & {
          downloadedExportStorageAtDocumentStart: typeof storageAtDocumentStart;
        }
      ).downloadedExportStorageAtDocumentStart = storageAtDocumentStart;
      void indexedDB.databases().then((databases) => {
        storageAtDocumentStart.databaseNames = databases.flatMap(({ name }) =>
          name === undefined ? [] : [name],
        );
      });
    });
    await exportedPage.route(standaloneUrl, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: bytes,
      }),
    );
    await exportedPage.goto(standaloneUrl);
    await expect
      .poll(() =>
        exportedPage.evaluate(
          () =>
            (
              window as unknown as Window & {
                downloadedExportStorageAtDocumentStart: {
                  readonly cookie: string;
                  readonly localStorageKeys: string[];
                  readonly sessionStorageKeys: string[];
                  readonly databaseNames: string[] | null;
                };
              }
            ).downloadedExportStorageAtDocumentStart,
        ),
      )
      .toEqual({
        cookie: "",
        localStorageKeys: [],
        sessionStorageKeys: [],
        databaseNames: [],
      });
    await expect(
      exportedPage.locator('[data-particle-studio-export-host="true"] canvas'),
    ).toHaveCount(1);
    await expect
      .poll(() =>
        exportedPage.evaluate(
          () =>
            (window as unknown as Window & { downloadedExportDraws: unknown[] })
              .downloadedExportDraws,
        ),
      )
      .toEqual(previewDraws);

    expect(requests).toEqual([standaloneUrl]);
    expect(
      await exportedPage.evaluate(async () => {
        const api = globalThis.ParticleStudio;
        const target = document.createElement("div");
        document.body.append(target);
        const controller = api.mount(target);
        await controller.ready;
        const result = controller.renderAt(0);
        controller.destroy();
        return {
          frozen: Object.isFrozen(api),
          keys: Object.keys(api),
          timeUs: result.state.timeUs,
        };
      }),
    ).toEqual({ frozen: true, keys: ["mount"], timeUs: 0 });
  } finally {
    await exportedContext.close();
  }
});
