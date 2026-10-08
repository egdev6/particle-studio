import { expect, test } from "@playwright/test";

const FIRST_SLICE_CANONICAL_SHA256 =
  "ce66f9f252023a1594da348c03577c506ca89766e56e1bfefe19b577fcb89387";

test("loads the static editor shell in Chromium", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Particle Studio");
  await expect(
    page.getByRole("heading", { name: "Editor foundation" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "This static shell establishes the UI boundary without loading a scene or editing product data.",
    ),
  ).toBeVisible();
});

test("canonicalizes the root fixture with Chromium Web Crypto", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByTestId("canonicalization-identifier")).toHaveText(
    "jcs-1",
  );
  await expect(page.getByTestId("canonicalization-hex")).toHaveText(
    "7b226475726174696f6e5573223a313030303030302c22656c656d656e7473223a5b7b22686569676874223a38302c22" +
      "6964223a2273686170652d31222c226f706163697479223a312c2274797065223a227368617065222c22776964746822" +
      "3a3132302c2278223a31362c2279223a32347d5d2c226c6f6f70223a747275652c22706c61796261636b52616e676522" +
      "3a7b22656e645573223a313030303030302c2273746172745573223a307d2c22726f6f74496473223a5b227368617065" +
      "2d31225d2c22736368656d6156657273696f6e223a312c2273656564223a34322c22747261636b73223a5b7b22656173" +
      "696e67223a2265617365496e4f757451756164222c22656c656d656e744964223a2273686170652d31222c22696e7465" +
      "72706f6c6174696f6e223a226c696e656172222c226b65796672616d6573223a5b7b2274696d655573223a302c227661" +
      "6c7565223a302e32357d2c7b2274696d655573223a313030303030302c2276616c7565223a302e37357d5d2c2270726f" +
      "7065727479223a226f706163697479227d5d7d",
  );
  await expect(page.getByTestId("canonicalization-sha256")).toHaveText(
    FIRST_SLICE_CANONICAL_SHA256,
  );

  await page.reload();
  await expect(page.getByTestId("canonicalization-sha256")).toHaveText(
    FIRST_SLICE_CANONICAL_SHA256,
  );
});

test("uses the real Canvas text seam with its effective transform and font", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      text,
      x,
      y,
      maxWidth,
    ) {
      calls.push({
        text,
        x,
        y,
        font: this.font,
        alpha: this.globalAlpha,
        transform: this.getTransform().toString(),
      });
      return original.call(this, text, x, y, maxWidth);
    };
    (window as unknown as Window & { textCalls: unknown[] }).textCalls = calls;
  });
  await page.goto("/");

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as Window & { textCalls: unknown[] }).textCalls,
      ),
    )
    .toEqual([
      {
        text: "Hello Canvas",
        x: 4,
        y: 12,
        font: "18px sans-serif",
        alpha: 0.5,
        transform: "matrix(1, 0, 0, 1, 150, 20)",
      },
    ]);
});

test("uses the real Canvas image seam with resolved destination geometry", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (
      source,
      x,
      y,
      width,
      height,
    ) {
      calls.push({
        sourceType: source.constructor.name,
        sourceWidth: (source as HTMLCanvasElement).width,
        sourceHeight: (source as HTMLCanvasElement).height,
        x,
        y,
        width,
        height,
        alpha: this.globalAlpha,
        transform: this.getTransform().toString(),
      });
      return original.call(this, source, x, y, width, height);
    };
    (window as unknown as Window & { imageCalls: unknown[] }).imageCalls =
      calls;
  });
  await page.goto("/");

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as Window & { imageCalls: unknown[] }).imageCalls,
      ),
    )
    .toEqual([
      {
        sourceType: "HTMLCanvasElement",
        sourceWidth: 2,
        sourceHeight: 2,
        x: 8,
        y: 16,
        width: 32,
        height: 24,
        alpha: 0.4,
        transform: "matrix(1, 0, 0, 1, 150, 20)",
      },
    ]);
});

test("drives the configured loop transport through Canvas redraw and cleanup", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const callbacks = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];
    let nextId = 0;
    window.requestAnimationFrame = (callback) => {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      cancelled.push(id);
      callbacks.delete(id);
    };
    (
      window as unknown as {
        timelineRaf: {
          cancelled: number[];
          run(timestamp: number): void;
          scheduled(): number[];
        };
      }
    ).timelineRaf = {
      cancelled,
      run(timestamp) {
        const next = callbacks.entries().next().value;
        if (!next) throw new Error("RAF callback missing");
        const [id, callback] = next;
        callbacks.delete(id);
        callback(timestamp);
      },
      scheduled() {
        return [...callbacks.keys()];
      },
    };
  });
  await page.goto("/");

  await expect(page.getByTestId("transport-loop")).toHaveText("enabled");
  await page.getByRole("slider", { name: "Timeline position" }).fill("750000");
  await expect(page.getByTestId("transport-playhead-us")).toHaveText("750000");

  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByTestId("transport-status")).toHaveText("playing");
  await page.evaluate(() =>
    (
      window as unknown as {
        timelineRaf: { run(timestamp: number): void };
      }
    ).timelineRaf.run(100),
  );
  await page.evaluate(() =>
    (
      window as unknown as {
        timelineRaf: { run(timestamp: number): void };
      }
    ).timelineRaf.run(350),
  );
  await expect(page.getByTestId("transport-playhead-us")).toHaveText("1000000");
  await expect(page.getByTestId("transport-status")).toHaveText("playing");

  await page.evaluate(() =>
    (
      window as unknown as {
        timelineRaf: { run(timestamp: number): void };
      }
    ).timelineRaf.run(600),
  );
  await expect(page.getByTestId("transport-playhead-us")).toHaveText("250000");
  await expect(page.getByTestId("preview-opacity")).toHaveText("0.3125");

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByTestId("transport-status")).toHaveText("paused");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const timelineRaf = (
          window as unknown as {
            timelineRaf: { scheduled(): number[]; cancelled: number[] };
          }
        ).timelineRaf;
        return {
          scheduled: timelineRaf.scheduled(),
          cancelled: timelineRaf.cancelled,
        };
      }),
    )
    .toEqual({ scheduled: [], cancelled: [4] });
});

test("draws a grouped fixture at its effective Canvas transform", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByTestId("preview-time-us")).toHaveText("0");
  await expect(page.getByTestId("scene-preview")).toBeVisible();
  await page.getByRole("slider", { name: "Timeline position" }).fill("500000");
  await expect(page.getByTestId("preview-opacity")).toHaveText("0.5");

  const alphaAt500000 = await page
    .getByTestId("scene-preview")
    .evaluate((canvas) => {
      const context = (canvas as HTMLCanvasElement).getContext("2d");
      return {
        local: context?.getImageData(20, 28, 1, 1).data[3],
        grouped: context?.getImageData(170, 48, 1, 1).data[3],
      };
    });
  expect(alphaAt500000.local).toBe(0);
  expect(alphaAt500000.grouped).toBeGreaterThan(0);

  await page.getByRole("slider", { name: "Timeline position" }).fill("750000");
  await expect(page.getByTestId("preview-time-us")).toHaveText("750000");
  await expect(page.getByTestId("preview-opacity")).toHaveText("0.6875");

  const alphaAt750000 = await page
    .getByTestId("scene-preview")
    .evaluate((canvas) => {
      const context = (canvas as HTMLCanvasElement).getContext("2d");
      return context?.getImageData(170, 48, 1, 1).data[3];
    });
  expect(alphaAt750000).toBeGreaterThan(alphaAt500000.grouped ?? 0);
});
