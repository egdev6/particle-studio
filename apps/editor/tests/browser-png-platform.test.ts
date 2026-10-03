import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserPngDecodePrimitive,
  browserSha256,
} from "../src/browser-png-platform.js";
import { importDurablePngAsset } from "../src/durable-png-import.js";
import { decodeVerifiedPngAsset } from "../src/verified-png-decode.js";

const webcrypto = globalThis.crypto;
const HASH =
  "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const bytes = () => new TextEncoder().encode("abc");

afterEach(() => vi.unstubAllGlobals());

describe("browser PNG platform", () => {
  it("imports without accessing browser globals", async () => {
    vi.stubGlobal("crypto", undefined);
    vi.stubGlobal("createImageBitmap", undefined);
    vi.resetModules();
    const platform = await import("../src/browser-png-platform.js");
    vi.stubGlobal("crypto", webcrypto);
    await expect(platform.browserSha256(bytes())).resolves.toBe(HASH);
  });

  it("returns an independently known prefixed SHA-256", async () => {
    vi.stubGlobal("crypto", webcrypto);
    await expect(browserSha256(bytes())).resolves.toBe(HASH);
  });

  it("isolates hash bytes before a blocked asynchronous digest", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const digest = vi.fn(async (algorithm: string, input: ArrayBuffer) => {
      await gate;
      return webcrypto.subtle.digest(algorithm, input);
    });
    vi.stubGlobal("crypto", { subtle: { digest } });
    const input = bytes();
    const result = browserSha256(input);
    input.fill(0);
    release();
    await expect(result).resolves.toBe(HASH);
    expect(digest).toHaveBeenCalledOnce();
  });

  it("uses an isolated PNG Blob and preserves the live bitmap handle", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const bitmap = { width: 7, height: 9, close: vi.fn() };
    let observedBlob!: Blob;
    vi.stubGlobal("createImageBitmap", vi.fn(async (blob: Blob) => {
      observedBlob = blob;
      await gate;
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes());
      return bitmap;
    }));
    const input = bytes();
    const result = browserPngDecodePrimitive.decodePng(input);
    input.fill(0);
    release();
    const decoded = await result;
    expect(observedBlob.type).toBe("image/png");
    expect(decoded).toEqual({ width: 7, height: 9, handle: bitmap });
    expect((decoded as { handle: unknown }).handle).toBe(bitmap);
    expect(bitmap.close).not.toHaveBeenCalled();
  });

  it("propagates primitive rejection to the existing verified decode boundary", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const failure = new Error("browser decode failed");
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(failure));
    await expect(browserPngDecodePrimitive.decodePng(bytes())).rejects.toBe(failure);
    const record = { sha256: HASH, mimeType: "image/png", byteLength: 3, bytes: bytes() };
    const verified = await importDurablePngAsset(
      { mimeType: "image/png", bytes: bytes() },
      {
        sha256: browserSha256,
        assets: { writeAsset: async () => record, readAsset: async () => record },
      },
    );
    await expect(decodeVerifiedPngAsset(verified, browserPngDecodePrimitive))
      .rejects.toMatchObject({ code: "EDITOR_PNG_DECODE_FAILED" });
  });
});
