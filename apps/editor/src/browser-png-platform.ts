import type { Sha256 } from "./durable-png-import.js";
import type { PngDecodePrimitive } from "./verified-png-decode.js";

/** Browser adapters only; importing this module does not access browser globals. */
export const browserSha256: Sha256 = async (bytes) => {
  const ownedBytes = bytes.slice();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", ownedBytes.buffer);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
};

export const browserPngDecodePrimitive: PngDecodePrimitive = {
  async decodePng(bytes) {
    const ownedBytes = bytes.slice();
    const blob = new Blob([ownedBytes.buffer], { type: "image/png" });
    const handle = await globalThis.createImageBitmap(blob);
    // Ownership passes to the caller; a successful bitmap must remain open.
    return { width: handle.width, height: handle.height, handle };
  },
};
