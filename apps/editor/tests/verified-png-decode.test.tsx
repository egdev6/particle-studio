import { describe, expect, it, vi } from "vitest";

import {
  importDurablePngAsset,
  type DurablePngAssetPort,
} from "../src/durable-png-import.js";
import {
  decodeVerifiedPngAsset,
  type PngDecodePrimitive,
} from "../src/verified-png-decode.js";

const PNG_SHA256 =
  "sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
const PNG_BYTES = new Uint8Array([1, 2, 3]);

function createDependencies() {
  const events: string[] = [];
  const assets: DurablePngAssetPort = {
    writeAsset: vi.fn(async () => {
      events.push("write");
      return {
        sha256: PNG_SHA256,
        mimeType: "image/png",
        byteLength: 3,
        bytes: PNG_BYTES.slice(),
      };
    }),
    readAsset: vi.fn(async () => {
      events.push("read");
      return {
        sha256: PNG_SHA256,
        mimeType: "image/png",
        byteLength: 3,
        bytes: PNG_BYTES.slice(),
      };
    }),
  };
  const sha256 = async (bytes: Uint8Array) => {
    events.push(`hash:${Array.from(bytes).join(",")}`);
    return PNG_SHA256;
  };
  return { assets, sha256, events };
}

async function importedVerifiedPng() {
  return importDurablePngAsset(
    { mimeType: "image/png", bytes: PNG_BYTES.slice() },
    createDependencies(),
  );
}

async function expectStableDecodeFailure(
  operation: Promise<unknown>,
): Promise<void> {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }
  expect(String(failure)).not.toContain("private decoder");
  expect(failure).toMatchObject({
    name: "DurablePngIntegrityError",
    code: "EDITOR_PNG_DECODE_FAILED",
    message: "EDITOR_PNG_DECODE_FAILED",
  });
}

function decodeVerifiedPngAssetWith(
  asset: Awaited<ReturnType<typeof importedVerifiedPng>>,
  decodePng: PngDecodePrimitive["decodePng"],
) {
  return decodeVerifiedPngAsset(asset, { decodePng });
}

describe("verified PNG decode primitive", () => {
  it("decodes an isolated verified-byte copy and returns isolated exact metadata", async () => {
    const dependencies = createDependencies();
    const verified = await importDurablePngAsset(
      { mimeType: "image/png", bytes: PNG_BYTES.slice() },
      dependencies,
    );
    const suppliedHandle = { source: "decoder" };
    let decoderBytes: Uint8Array | undefined;

    const decoded = await decodeVerifiedPngAssetWith(verified, (bytes) => {
      decoderBytes = bytes.slice();
      dependencies.events.push("decode");
      bytes[0] = 9;
      return { width: 20, height: 10, handle: suppliedHandle };
    });

    expect(dependencies.events).toEqual([
      "write",
      "read",
      "hash:1,2,3",
      "hash:1,2,3",
      "decode",
    ]);
    expect(decoderBytes).toEqual(PNG_BYTES);
    expect(decoded).toMatchObject({
      sha256: PNG_SHA256,
      mimeType: "image/png",
      byteLength: PNG_BYTES.byteLength,
      width: 20,
      height: 10,
      handle: suppliedHandle,
    });
    expect(decoded.bytes).toEqual(PNG_BYTES);
    const leakedBytes = decoded.bytes;
    leakedBytes[1] = 8;
    expect(decoded.bytes).toEqual(PNG_BYTES);
  });

  it("keeps returned verified bytes and metadata stable when the decoder mutates during await", async () => {
    const verified = await importedVerifiedPng();
    let releaseDecode: (() => void) | undefined;
    const operation = decodeVerifiedPngAssetWith(verified, async (bytes) => {
      bytes[0] = 9;
      await new Promise<void>((resolve) => {
        releaseDecode = resolve;
      });
      bytes[1] = 8;
      return { width: 2, height: 3, handle: { mutable: true } };
    });

    verified.bytes[2] = 7;
    releaseDecode?.();

    await expect(operation).resolves.toMatchObject({
      sha256: PNG_SHA256,
      mimeType: "image/png",
      byteLength: PNG_BYTES.byteLength,
      bytes: PNG_BYTES,
      width: 2,
      height: 3,
      handle: { mutable: true },
    });
  });

  it.each([
    [
      "throw",
      (): unknown => {
        throw new Error("private decoder throw");
      },
    ],
    [
      "rejection",
      (): Promise<unknown> =>
        Promise.reject(new Error("private decoder rejection")),
    ],
    ["null", (): unknown => null],
    ["primitive", (): unknown => 4],
    ["malformed output", () => ({ width: 1, height: 1 })],
    [
      "hostile property access",
      () =>
        new Proxy(
          {},
          {
            get() {
              throw new Error("private decoder property trap");
            },
          },
        ),
    ],
  ] as const)(
    "maps decoder %s to a stable failure",
    async (_label, decodePng) => {
      await expectStableDecodeFailure(
        decodeVerifiedPngAssetWith(await importedVerifiedPng(), decodePng),
      );
    },
  );

  it.each([
    [0, 1],
    [-1, 1],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
    [1, 0],
    [1, Number.NEGATIVE_INFINITY],
  ])(
    "rejects non-positive or non-finite intrinsic dimensions %s by %s",
    async (width, height) => {
      await expectStableDecodeFailure(
        decodeVerifiedPngAssetWith(await importedVerifiedPng(), () => ({
          width,
          height,
          handle: {},
        })),
      );
    },
  );
});
