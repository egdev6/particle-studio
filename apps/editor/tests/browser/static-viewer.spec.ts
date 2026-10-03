import { expect, test } from "@playwright/test";
import type { SceneDocumentV1 } from "@particle-studio/scene-document";
import { BROWSER_DOCUMENT, nativeRows, type NativeRows } from "../raw-indexeddb-seed.js";

test("built preview renders the first-slice scene at playback start", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Read-only scene viewer" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Rendered unpersisted sample at 0 µs.");
  const before = await nativeRows(page);
  expect(Object.values(before).every((rows) => Array.isArray(rows) && rows.length === 0)).toBe(true);
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("Rendered unpersisted sample at 0 µs.");
  expect(await nativeRows(page)).toEqual(before);
  const pixels = await page.locator("#scene").evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext("2d")!;
    return {
      width: element.width, height: element.height,
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
  await page.addInitScript(() => { HTMLCanvasElement.prototype.getContext = () => null; });
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("Error: Canvas2D context is unavailable.");
  await expect(page.getByRole("status")).toBeVisible();
  await expect(page.getByRole("status")).not.toContainText("Rendered");
  expect(pageErrors).toEqual([]);
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_HASH = "sha256:431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460";
const cases = ["saved-only", "draft-image", "dangling", "corrupt-pointer", "corrupt-content",
  "missing-asset", "hash-failure", "decode-failure", "pointer-read-failure", "asset-read-failure"] as const;

for (const scenario of cases) {
  test(`built preview ${scenario} preserves actual durable rows`, async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("status")).toContainText("Rendered");
    const bytes = scenario === "decode-failure" ? [1, 2, 3] : Array.from(atob(PNG), (char) => char.charCodeAt(0));
    const hash = scenario === "decode-failure"
      ? `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))),
        (byte) => byte.toString(16).padStart(2, "0")).join("")}` : PNG_HASH;
    const document: SceneDocumentV1 = {
      schemaVersion: 1, durationUs: 1_000_000, seed: 42, loop: true,
      playbackRange: { startUs: 500_000, endUs: 1_000_000 },
      rootIds: ["shape-1", "image"],
      tracks: [{ elementId: "shape-1", property: "opacity", interpolation: "linear", easing: "linear",
        keyframes: [{ timeUs: 0, value: 0.25 }, { timeUs: 1_000_000, value: 0.75 }] }],
      elements: [{ id: "shape-1", type: "shape", x: 16, y: 24, width: 120, height: 80, opacity: 1 }, {
        id: "image", type: "image", x: 180, y: 24, width: 4, height: 4, opacity: 1,
        asset: { sha256: hash, mimeType: "image/png", byteLength: bytes.length, intrinsicWidth: 1, intrinsicHeight: 1 },
      }],
    };
    // JCS fixture: finite JSON values with lexicographically sorted object keys.
    // Production revalidates both this document and these canonical bytes.
    const canonicalJson = JSON.stringify(document, (_key, value: unknown) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
      return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    });
    const canonicalBytes = Array.from(new TextEncoder().encode(canonicalJson));
    const revision = { documentId: BROWSER_DOCUMENT, revisionId: "revision-1", sequence: 1, document,
      canonicalization: { identifier: "jcs-1", byteLength: canonicalBytes.length }, canonicalBytes };
    const saved = scenario === "saved-only";
    const pointer = { kind: saved ? "saved" : "draft", documentId: BROWSER_DOCUMENT, revisionId: "revision-1", sequence: 1 };
    const rows: NativeRows = {
      revisions: [{ ...revision, canonicalBytes: Array.from(revision.canonicalBytes) }],
      pointers: [{ documentId: BROWSER_DOCUMENT, saved: saved ? pointer : null, draft: saved ? null : pointer }],
      assets: [{ sha256: hash, mimeType: "image/png", byteLength: bytes.length, bytes }],
    };
    if (scenario === "dangling") rows.revisions = [];
    if (scenario === "corrupt-pointer") rows.pointers![0]!.draft = { ...pointer, sequence: -1 };
    if (scenario === "corrupt-content") rows.revisions![0]!.canonicalBytes = [1];
    if (scenario === "missing-asset") rows.assets = [];
    if (scenario === "hash-failure") rows.assets![0]!.bytes = bytes.map(() => 0);
    const before = await nativeRows(page, rows);
    if (scenario === "pointer-read-failure" || scenario === "asset-read-failure") {
      // Browser API fault, not a product hook. Snapshot reads use getAll, unaffected.
      await page.addInitScript((store) => {
        const get = IDBObjectStore.prototype.get;
        IDBObjectStore.prototype.get = function (key) {
          if (this.name === store) throw new DOMException("Injected native read failure", "UnknownError");
          return get.call(this, key);
        };
      }, scenario === "pointer-read-failure" ? "pointers" : "assets");
    }
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.reload();
    const status = page.getByRole("status");
    if (saved) await expect(status).toHaveText("Rendered unpersisted sample at 0 µs.");
    else if (scenario === "draft-image") {
      await expect(status).toHaveText("Rendered restored draft at 500000 µs.");
      const pixels = await page.locator("#scene").evaluate((canvas: HTMLCanvasElement) => {
        const context = canvas.getContext("2d")!;
        return [60, 181, 240].map((x) => Array.from(context.getImageData(x, 25, 1, 1).data));
      });
      expect(pixels).toEqual([[0, 0, 0, 128], [0, 0, 0, 255], [0, 0, 0, 0]]);
    } else {
      await expect(status).toContainText("Error:");
      await expect(status).toBeVisible();
      await expect(status).not.toContainText("Rendered");
      const alpha = await page.locator("#scene").evaluate((canvas: HTMLCanvasElement) =>
        Array.from(canvas.getContext("2d")!.getImageData(0, 0, 256, 160).data).filter((_value, index) => index % 4 === 3));
      expect(alpha.every((value) => value === 0)).toBe(true);
    }
    expect(await nativeRows(page)).toEqual(before);
    expect(pageErrors).toEqual([]);
    if (scenario === "draft-image") {
      // Delay the real browser decode; pagehide must suppress late entry output.
      await page.addInitScript(() => {
        const decode = globalThis.createImageBitmap;
        globalThis.createImageBitmap = async (image: ImageBitmapSource) => {
          const bitmap = await decode(image);
          globalThis.document.documentElement.dataset.decode = "pending";
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const close = bitmap.close.bind(bitmap);
          bitmap.close = () => {
            close();
            globalThis.document.documentElement.dataset.closes = String(Number(globalThis.document.documentElement.dataset.closes ?? 0) + 1);
          };
          return bitmap;
        };
      });
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-decode", "pending");
      await page.evaluate(() => {
        window.dispatchEvent(new Event("pagehide"));
        window.dispatchEvent(new Event("pagehide"));
      });
      await expect(page.locator("html")).toHaveAttribute("data-closes", "1");
      await expect(status).toHaveText("Loading local scene…");
      const alpha = await page.locator("#scene").evaluate((canvas: HTMLCanvasElement) =>
        Array.from(canvas.getContext("2d")!.getImageData(0, 0, 256, 160).data).filter((_value, index) => index % 4 === 3));
      expect(alpha.every((value) => value === 0)).toBe(true);
      expect(await nativeRows(page)).toEqual(before);
      expect(pageErrors).toEqual([]);
    }
  });
}
