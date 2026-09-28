import { describe, expect, it, vi } from "vitest";

import {
  importDurablePngAsset,
  type DurablePngAssetPort,
  type Sha256,
} from "../src/durable-png-import.js";

const PNG_SHA256 =
  "sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
const OTHER_SHA256 = `sha256:${"f".repeat(64)}`;
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

function recordWithThrowingProperty(
  property: keyof AssetRecord,
  privateDetail: string,
): AssetRecord {
  const record = asset();
  Object.defineProperty(record, property, {
    get() {
      throw new Error(privateDetail);
    },
  });
  return record;
}

async function expectStablePngFailure(
  operation: Promise<unknown>,
  code: string,
  privateDetail: string,
): Promise<void> {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }

  expect(String(failure)).not.toContain(privateDetail);
  expect(failure).toMatchObject({
    name: "DurablePngIntegrityError",
    code,
    message: code,
  });
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

  it.each([
    [
      "write rejection",
      { write: () => Promise.reject(new Error("write")) },
      "EDITOR_PNG_PERSISTENCE_WRITE_FAILED",
    ],
    [
      "read rejection",
      { read: () => Promise.reject(new Error("read")) },
      "EDITOR_PNG_PERSISTENCE_READ_FAILED",
    ],
    [
      "missing record",
      { read: () => Promise.resolve(null) },
      "EDITOR_PNG_ASSET_UNAVAILABLE",
    ],
    [
      "malformed record",
      { read: () => Promise.resolve({}) },
      "EDITOR_PNG_ASSET_VERIFICATION_FAILED",
    ],
  ])("returns a stable error for %s", async (_label, options, code) => {
    await expect(importPng(createDependencies(options))).rejects.toMatchObject({
      code,
    });
  });

  it("sanitizes a persistence rejection whose code accessor throws", async () => {
    const privateDetail = "private write cause code";
    const cause = Object.defineProperty({}, "code", {
      get() {
        throw new Error(privateDetail);
      },
    });
    const dependencies = createDependencies({
      write: async () => Promise.reject(cause),
    });

    await expectStablePngFailure(
      importPng(dependencies),
      "EDITOR_PNG_PERSISTENCE_WRITE_FAILED",
      privateDetail,
    );
  });

  it.each([
    ["bytes getter", "bytes", "read"],
    ["SHA address getter", "sha256", "write"],
    ["MIME getter", "mimeType", "read"],
    ["length getter", "byteLength", "read"],
  ] as const)(
    "sanitizes a throwing %s without leaking its private detail",
    async (_label, property, stage) => {
      const privateDetail = `private ${property} getter`;
      const record = recordWithThrowingProperty(property, privateDetail);
      const dependencies = createDependencies(
        stage === "write"
          ? { write: async () => record }
          : { read: async () => record },
      );

      await expectStablePngFailure(
        importPng(dependencies),
        "EDITOR_PNG_ASSET_VERIFICATION_FAILED",
        privateDetail,
      );
    },
  );

  it("sanitizes a proxy metadata trap without leaking its private detail", async () => {
    const privateDetail = "private proxy MIME trap";
    const record = new Proxy(asset(), {
      get(target, property, receiver) {
        if (property === "mimeType") throw new Error(privateDetail);
        return Reflect.get(target, property, receiver);
      },
    });
    const dependencies = createDependencies({ read: async () => record });

    await expectStablePngFailure(
      importPng(dependencies),
      "EDITOR_PNG_ASSET_VERIFICATION_FAILED",
      privateDetail,
    );
  });

  it("sanitizes a write-record proxy bytes trap", async () => {
    const privateDetail = "private write proxy bytes trap";
    const record = new Proxy(asset(), {
      get(target, property, receiver) {
        if (property === "bytes") throw new Error(privateDetail);
        return Reflect.get(target, property, receiver);
      },
    });
    const dependencies = createDependencies({ write: async () => record });

    await expectStablePngFailure(
      importPng(dependencies),
      "EDITOR_PNG_ASSET_VERIFICATION_FAILED",
      privateDetail,
    );
  });

  it("rejects consistent forged SHA metadata after independent hashing", async () => {
    const dependencies = createDependencies({
      write: async () => asset({ sha256: OTHER_SHA256 }),
      read: async () => asset({ sha256: OTHER_SHA256 }),
    });

    await expect(importPng(dependencies)).rejects.toMatchObject({
      code: "EDITOR_PNG_ASSET_VERIFICATION_FAILED",
    });
  });

  it("hashes the durable reread bytes independently of accepted input", async () => {
    const hashInputs: number[][] = [];
    const rereadBytes = new Uint8Array([1, 2, 4]);
    const dependencies = createDependencies({
      read: async () => asset({ bytes: rereadBytes }),
      sha256: async (bytes) => {
        hashInputs.push(Array.from(bytes));
        return PNG_SHA256;
      },
    });

    await expect(importPng(dependencies)).rejects.toMatchObject({
      code: "EDITOR_PNG_ASSET_VERIFICATION_FAILED",
    });
    expect(hashInputs).toEqual([Array.from(PNG_BYTES), Array.from(rereadBytes)]);
  });

  it.each([
    ["written address", { write: async () => asset({ sha256: OTHER_SHA256 }) }],
    ["reread address", { read: async () => asset({ sha256: OTHER_SHA256 }) }],
    [
      "reread hash",
      {
        sha256: (() => {
          let calls = 0;
          return async () => (calls++ === 0 ? PNG_SHA256 : OTHER_SHA256);
        })(),
      },
    ],
    ["MIME", { read: async () => asset({ mimeType: "image/jpeg" }) }],
    ["length", { read: async () => asset({ byteLength: 2 }) }],
    [
      "bytes",
      { read: async () => asset({ bytes: new Uint8Array([1, 2, 4]) }) },
    ],
  ])("rejects a %s mismatch", async (_label, options) => {
    await expect(importPng(createDependencies(options))).rejects.toMatchObject({
      code: "EDITOR_PNG_ASSET_VERIFICATION_FAILED",
    });
  });
});
