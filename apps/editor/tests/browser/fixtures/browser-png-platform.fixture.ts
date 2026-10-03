import {
  browserPngDecodePrimitive,
  browserSha256,
} from "../../../src/browser-png-platform.js";
import { importDurablePngAsset } from "../../../src/durable-png-import.js";
import { decodeVerifiedPngAsset } from "../../../src/verified-png-decode.js";

// Fixed 1x1 PNG; digest independently pinned using Node's createHash, not this adapter.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_HASH =
  "sha256:431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460";

async function verify(bytes: Uint8Array, sha256: string) {
  const record = { sha256, mimeType: "image/png", byteLength: bytes.length, bytes };
  return importDurablePngAsset(
    { mimeType: "image/png", bytes },
    {
      sha256: browserSha256,
      assets: { writeAsset: async () => record, readAsset: async () => record },
    },
  );
}

async function run() {
  const bytes = Uint8Array.from(atob(PNG_BASE64), (char) => char.charCodeAt(0));
  const verified = await verify(bytes, PNG_HASH);
  const decoded = await decodeVerifiedPngAsset(verified, browserPngDecodePrimitive);
  const bitmap = decoded.handle;
  try {
    if (!(bitmap instanceof ImageBitmap)) throw new Error("Expected real ImageBitmap");
    document.querySelector("#hash")!.textContent = decoded.sha256;
    document.querySelector("#bitmap")!.textContent =
      `${bitmap.constructor.name}:${decoded.width}x${decoded.height}:${bitmap.width}x${bitmap.height}`;

    const corrupt = new Uint8Array([1, 2, 3]);
    const corruptAsset = await verify(corrupt, await browserSha256(corrupt));
    let corruptHandle: unknown;
    try {
      corruptHandle = (await decodeVerifiedPngAsset(corruptAsset, browserPngDecodePrimitive)).handle;
      throw new Error("Corrupt PNG unexpectedly decoded");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) ||
          error.code !== "EDITOR_PNG_DECODE_FAILED") throw error;
      document.querySelector("#failure")!.textContent = error.code;
    } finally {
      if (corruptHandle instanceof ImageBitmap) corruptHandle.close();
    }
  } finally {
    if (bitmap instanceof ImageBitmap) bitmap.close();
  }
  document.querySelector("#status")!.textContent = "passed";
}

void run().catch((error: unknown) => {
  document.querySelector("#status")!.textContent = `failed: ${String(error)}`;
});
