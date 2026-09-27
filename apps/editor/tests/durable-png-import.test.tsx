import { describe, expect, it, vi } from "vitest";

import {
  importDurablePngAsset,
  type DurablePngAssetPort,
  type Sha256,
} from "../src/durable-png-import.js";

const PNG_SHA256 =
  "sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
const PNG_BYTES = new Uint8Array([1, 2, 3]);

type AssetRecord = {
  sha256: string;
  mimeType: string;
  byteLength: number;
  bytes: Uint8Array;
};

function asset(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    sha256: PNG_SHA256,
    mimeType: "image/png",
    byteLength: PNG_BYTES.byteLength,
    bytes: PNG_BYTES.slice(),
    ...overrides,
  };
}

function createDependencies(
  options: {
    readonly write?: () => Promise<unknown>;
    readonly read?: () => Promise<unknown>;
    readonly sha256?: Sha256;
  } = {},
) {
  const events: string[] = [];
  const assets: DurablePngAssetPort = {
    writeAsset: vi.fn(async () => {
      events.push("write");
      return options.write ? options.write() : asset();
    }),
    readAsset: vi.fn(async () => {
      events.push("read");
      return options.read ? options.read() : asset();
    }),
  };
  const sha256: Sha256 =
    options.sha256 ??
    (async (bytes) => {
      events.push(`hash:${Array.from(bytes).join(",")}`);
      return PNG_SHA256;
    });
  return { assets, events, sha256 };
}

async function importPng(
  dependencies = createDependencies(),
  bytes = PNG_BYTES.slice(),
) {
  return importDurablePngAsset({ mimeType: "image/png", bytes }, dependencies);
}

describe("durable PNG integrity primitive", () => {
  it("writes, rereads, independently hashes, and isolates a verified PNG", async () => {
    const dependencies = createDependencies();

    const imported = await importPng(dependencies);

    expect(dependencies.events).toEqual([
      "write",
      "read",
      "hash:1,2,3",
      "hash:1,2,3",
    ]);
    expect(imported).toMatchObject({
      sha256: PNG_SHA256,
      mimeType: "image/png",
      byteLength: PNG_BYTES.byteLength,
    });
    expect(imported.bytes).toEqual(PNG_BYTES);
    const leaked = imported.bytes;
    leaked[0] = 9;
    expect(imported.bytes).toEqual(PNG_BYTES);
  });

  it("copies caller bytes before the first await", async () => {
    let releaseWrite: (() => void) | undefined;
    const dependencies = createDependencies({
      write: () =>
        new Promise((resolve) => {
          releaseWrite = () => resolve(asset());
        }),
    });
    const callerBytes = PNG_BYTES.slice();
    const operation = importPng(dependencies, callerBytes);
    callerBytes[0] = 9;
    releaseWrite?.();

    await expect(operation).resolves.toMatchObject({ sha256: PNG_SHA256 });
    expect(dependencies.assets.writeAsset).toHaveBeenCalledWith({
      mimeType: "image/png",
      bytes: PNG_BYTES,
    });
  });

  it("rejects unsupported MIME types before persistence", async () => {
    const dependencies = createDependencies();

    await expect(
      importDurablePngAsset(
        { mimeType: "image/jpeg", bytes: PNG_BYTES },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "EDITOR_PNG_MIME_TYPE_INVALID" });
    expect(dependencies.events).toEqual([]);
  });
});
