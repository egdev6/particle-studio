import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  App,
  createDurableBrowserCompositionForTesting,
  deliverFinalizedHtmlForTesting,
  type EditorWorkflowRequest,
} from "../src/App.js";
import * as recoveryHarness from "../src/testing/indexeddb-recovery-harness.js";
import { createBrowserAgentWorkspaceAdapter } from "../src/browser-agent-workspace-port.js";
import {
  importDurablePngAsset,
  type DurablePngAssetPort,
  type Sha256,
  VerifiedAssetStagingError,
} from "../src/testing/indexeddb-recovery-harness.js";
import {
  createIndexedDbPersistenceAdapter,
  deleteIndexedDbPersistenceDatabase,
} from "@particle-studio/persistence-indexeddb";
import {
  canonicalizeSceneDocument,
  FIRST_SLICE_DOCUMENT,
  validateSceneDocument,
  type SceneDocumentV1,
} from "@particle-studio/scene-document";

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

type DecodePng = (bytes: Uint8Array) => Promise<unknown> | unknown;

type VerifiedDecodedPng = {
  readonly sha256: string;
  readonly mimeType: "image/png";
  readonly byteLength: number;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly handle: unknown;
};

type PngDecodeRuntime = {
  decodeVerifiedPngAsset(
    asset: {
      readonly sha256: string;
      readonly mimeType: "image/png";
      readonly byteLength: number;
      readonly bytes: Uint8Array;
    },
    dependencies: { readonly decodePng: DecodePng },
  ): Promise<VerifiedDecodedPng>;
};

const pngDecodeRuntime = recoveryHarness as unknown as PngDecodeRuntime;

function decodeVerifiedPngAsset(
  asset: {
    readonly sha256: string;
    readonly mimeType: "image/png";
    readonly byteLength: number;
    readonly bytes: Uint8Array;
  },
  decodePng: DecodePng,
): Promise<VerifiedDecodedPng> {
  return pngDecodeRuntime.decodeVerifiedPngAsset(asset, { decodePng });
}

async function importedVerifiedPng() {
  return importPng(createDependencies());
}

async function expectStableDecodeFailure(
  operation: Promise<unknown>,
): Promise<void> {
  await expect(operation).rejects.toMatchObject({
    name: "DurablePngIntegrityError",
    code: "EDITOR_PNG_DECODE_FAILED",
    message: "EDITOR_PNG_DECODE_FAILED",
  });
}

describe("verified PNG decode primitive", () => {
  it("decodes an isolated verified-byte copy and returns isolated exact metadata", async () => {
    const dependencies = createDependencies();
    const verified = await importPng(dependencies);
    const suppliedHandle = { source: "decoder" };
    let decoderBytes: Uint8Array | undefined;

    const decoded = await decodeVerifiedPngAsset(verified, (bytes) => {
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
    const operation = decodeVerifiedPngAsset(verified, async (bytes) => {
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
        decodeVerifiedPngAsset(await importedVerifiedPng(), decodePng),
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
        decodeVerifiedPngAsset(await importedVerifiedPng(), () => ({
          width,
          height,
          handle: {},
        })),
      );
    },
  );
});

type CachedPng = {
  readonly sha256: string;
  readonly mimeType: "image/png";
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly handle: unknown;
};

type PngCache = {
  importPng(input: {
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<CachedPng>;
  resolveImage(reference: Omit<CachedPng, "handle">): CachedPng | null;
};

type PngCacheRuntime = {
  createPngImageCache(dependencies: {
    readonly importVerifiedPng: (input: {
      readonly mimeType: string;
      readonly bytes: Uint8Array;
    }) => Promise<{
      readonly sha256: string;
      readonly mimeType: "image/png";
      readonly byteLength: number;
      readonly bytes: Uint8Array;
    }>;
    readonly decodeVerifiedPng: (asset: {
      readonly sha256: string;
      readonly mimeType: "image/png";
      readonly byteLength: number;
      readonly bytes: Uint8Array;
    }) => Promise<CachedPng>;
  }): PngCache;
};

const pngCacheRuntime = recoveryHarness as unknown as PngCacheRuntime;

function cachedReference(overrides: Partial<Omit<CachedPng, "handle">> = {}) {
  return {
    sha256: PNG_SHA256,
    mimeType: "image/png" as const,
    byteLength: PNG_BYTES.byteLength,
    width: 20,
    height: 10,
    ...overrides,
  };
}

function verifiedAsset(overrides: Partial<AssetRecord> = {}) {
  const record = asset(overrides);
  return { ...record, mimeType: "image/png" as const };
}

describe("atomic PNG cache publication and exact resolver", () => {
  it("keeps a pending import unresolved, then atomically publishes frozen defensive metadata", async () => {
    let releaseDecode: (() => void) | undefined;
    const handle = { decoded: true };
    const cache = pngCacheRuntime.createPngImageCache({
      importVerifiedPng: async () =>
        verifiedAsset({ bytes: PNG_BYTES.slice() }),
      decodeVerifiedPng: async () =>
        new Promise<CachedPng>((resolve) => {
          releaseDecode = () => resolve({ ...cachedReference(), handle });
        }),
    });

    const pending = cache.importPng({
      mimeType: "image/png",
      bytes: PNG_BYTES.slice(),
    });
    await Promise.resolve();
    expect(cache.resolveImage(cachedReference())).toBeNull();

    releaseDecode?.();
    const imported = await pending;
    const resolved = cache.resolveImage(cachedReference());

    expect(imported).toMatchObject({ ...cachedReference(), handle });
    expect(resolved).toMatchObject({ ...cachedReference(), handle });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(() => {
      (resolved as { width: number }).width = 99;
    }).toThrow(TypeError);
    expect(cache.resolveImage(cachedReference())).toMatchObject({ width: 20 });
  });

  it("resolves only exact Object.is metadata synchronously without dependency calls", async () => {
    const counters = { imported: 0, decoded: 0 };
    const cache = pngCacheRuntime.createPngImageCache({
      importVerifiedPng: async () => {
        counters.imported += 1;
        return verifiedAsset({ byteLength: 0, bytes: new Uint8Array() });
      },
      decodeVerifiedPng: async (verified) => {
        counters.decoded += 1;
        return {
          sha256: verified.sha256,
          mimeType: verified.mimeType,
          byteLength: verified.byteLength,
          width: 1,
          height: 1,
          handle: { decoded: true },
        };
      },
    });
    await cache.importPng({ mimeType: "image/png", bytes: new Uint8Array() });
    counters.imported = 0;
    counters.decoded = 0;

    const result = cache.resolveImage(
      cachedReference({ byteLength: 0, width: 1, height: 1 }),
    );

    expect(result).toMatchObject({ byteLength: 0, width: 1, height: 1 });
    expect(result).not.toHaveProperty("then");
    expect(counters).toEqual({ imported: 0, decoded: 0 });
    const mismatches: Array<Partial<Omit<CachedPng, "handle">>> = [
      { sha256: OTHER_SHA256 },
      { mimeType: "image/jpeg" as "image/png" },
      { byteLength: 1 },
      { width: 2 },
      { height: 2 },
    ];
    for (const mismatch of mismatches) {
      expect(
        cache.resolveImage(
          cachedReference({ byteLength: 0, width: 1, height: 1, ...mismatch }),
        ),
      ).toBeNull();
    }
    expect(
      cache.resolveImage(
        cachedReference({ byteLength: -0, width: 1, height: 1 }),
      ),
    ).toBeNull();
    expect(
      cache.resolveImage(
        cachedReference({ byteLength: Number.NaN, width: 1, height: 1 }),
      ),
    ).toBeNull();
  });

  it("keeps the established handle for an exact duplicate and preserves it through conflicts and failures", async () => {
    const establishedHandle = { source: "first" };
    const redundantHandle = { source: "duplicate" };
    let decodeCall = 0;
    const cache = pngCacheRuntime.createPngImageCache({
      importVerifiedPng: async () =>
        verifiedAsset({ bytes: PNG_BYTES.slice() }),
      decodeVerifiedPng: async () => {
        decodeCall += 1;
        if (decodeCall === 4) throw new Error("private decoder failure");
        return {
          ...cachedReference({ width: decodeCall === 3 ? 21 : 20 }),
          handle: decodeCall === 1 ? establishedHandle : redundantHandle,
        };
      },
    });

    await cache.importPng({ mimeType: "image/png", bytes: PNG_BYTES.slice() });
    const duplicate = await cache.importPng({
      mimeType: "image/png",
      bytes: PNG_BYTES.slice(),
    });
    await expect(
      cache.importPng({ mimeType: "image/png", bytes: PNG_BYTES.slice() }),
    ).rejects.toMatchObject({ code: "EDITOR_PNG_CACHE_METADATA_CONFLICT" });
    let failure: unknown;
    try {
      await cache.importPng({
        mimeType: "image/png",
        bytes: PNG_BYTES.slice(),
      });
    } catch (error) {
      failure = error;
    }

    expect(duplicate.handle).toBe(establishedHandle);
    expect(failure).toMatchObject({ code: "EDITOR_PNG_CACHE_IMPORT_FAILED" });
    expect(String(failure)).not.toContain("private decoder failure");
    expect(cache.resolveImage(cachedReference())).toMatchObject({
      handle: establishedHandle,
      width: 20,
    });
  });
});

type PngCacheLifecycle = PngCache & {
  removeImage(reference: Omit<CachedPng, "handle">): boolean;
  clear(): void;
  isDisposing(): boolean;
};

function lifecycleCache(
  candidates: ReadonlyArray<
    Omit<CachedPng, "handle"> & { readonly handle: unknown }
  >,
): PngCacheLifecycle {
  let next = 0;
  return pngCacheRuntime.createPngImageCache({
    importVerifiedPng: async () => {
      const candidate = candidates[next]!;
      return verifiedAsset({
        sha256: candidate.sha256,
        byteLength: candidate.byteLength,
        bytes: new Uint8Array(candidate.byteLength),
      });
    },
    decodeVerifiedPng: async () => candidates[next++]!,
  }) as PngCacheLifecycle;
}

async function cacheImages(
  cache: PngCacheLifecycle,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await cache.importPng({ mimeType: "image/png", bytes: PNG_BYTES });
  }
}

describe("decoded PNG handle ownership lifecycle", () => {
  it("removes an owner before closing its distinct handle exactly once", async () => {
    const handle = { close: vi.fn() };
    const cache = lifecycleCache([{ ...cachedReference(), handle }]);
    await cacheImages(cache, 1);

    expect(cache.removeImage(cachedReference())).toBe(true);
    expect(cache.resolveImage(cachedReference())).toBeNull();
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(cache.removeImage(cachedReference())).toBe(false);
    cache.clear();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("keeps an identical same-SHA candidate shared and closes it only after removal", async () => {
    const handle = { close: vi.fn() };
    const cache = lifecycleCache([
      { ...cachedReference(), handle },
      { ...cachedReference(), handle },
    ]);
    await cacheImages(cache, 2);

    expect(handle.close).not.toHaveBeenCalled();
    expect(cache.removeImage(cachedReference())).toBe(true);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("disposes a redundant exact candidate with a different handle", async () => {
    const established = { close: vi.fn() };
    const redundant = { close: vi.fn() };
    const cache = lifecycleCache([
      { ...cachedReference(), handle: established },
      { ...cachedReference(), handle: redundant },
    ]);
    await cacheImages(cache, 1);

    await cacheImages(cache, 1);
    expect(redundant.close).toHaveBeenCalledTimes(1);
    expect(established.close).not.toHaveBeenCalled();
  });

  it("disposes only a distinct conflicting candidate and retains the established owner", async () => {
    const established = { close: vi.fn() };
    const conflicting = { close: vi.fn() };
    const cache = lifecycleCache([
      { ...cachedReference(), handle: established },
      { ...cachedReference({ width: 21 }), handle: conflicting },
    ]);
    await cacheImages(cache, 1);

    await expect(cacheImages(cache, 1)).rejects.toMatchObject({
      code: "EDITOR_PNG_CACHE_METADATA_CONFLICT",
    });
    expect(conflicting.close).toHaveBeenCalledTimes(1);
    expect(cache.resolveImage(cachedReference())).toMatchObject({
      handle: established,
    });
  });

  it("never disposes an owned same-handle conflict before its established owner ends", async () => {
    const handle = { close: vi.fn() };
    const cache = lifecycleCache([
      { ...cachedReference(), handle },
      { ...cachedReference({ height: 11 }), handle },
    ]);
    await cacheImages(cache, 1);

    await expect(cacheImages(cache, 1)).rejects.toMatchObject({
      code: "EDITOR_PNG_CACHE_METADATA_CONFLICT",
    });
    expect(handle.close).not.toHaveBeenCalled();
    cache.removeImage(cachedReference());
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("shares one handle across SHA entries until the final owner is removed", async () => {
    const handle = { close: vi.fn() };
    const otherReference = cachedReference({ sha256: OTHER_SHA256 });
    const cache = lifecycleCache([
      { ...cachedReference(), handle },
      { ...otherReference, handle },
    ]);
    await cacheImages(cache, 2);

    expect(cache.removeImage(cachedReference())).toBe(true);
    expect(handle.close).not.toHaveBeenCalled();
    expect(cache.removeImage(otherReference)).toBe(true);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("clears aliases once and treats previously disposed identities idempotently", async () => {
    const handle = { close: vi.fn() };
    const otherReference = cachedReference({ sha256: OTHER_SHA256 });
    const cache = lifecycleCache([
      { ...cachedReference(), handle },
      { ...otherReference, handle },
      { ...cachedReference(), handle },
    ]);
    await cacheImages(cache, 2);

    cache.clear();
    cache.clear();
    await cacheImages(cache, 1);
    cache.removeImage(cachedReference());
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("publishes coherent state while a reentrant close resolves, removes, and clears", async () => {
    const otherReference = cachedReference({ sha256: OTHER_SHA256 });
    let cache: PngCacheLifecycle;
    const other = { close: vi.fn() };
    const first = {
      close: vi.fn(() => {
        expect(cache.resolveImage(cachedReference())).toBeNull();
        expect(cache.resolveImage(otherReference)).toMatchObject({
          handle: other,
        });
        expect(cache.removeImage(cachedReference())).toBe(false);
        expect(cache.removeImage(otherReference)).toBe(false);
        cache.clear();
        expect(cache.resolveImage(otherReference)).toMatchObject({
          handle: other,
        });
      }),
    };
    cache = lifecycleCache([
      { ...cachedReference(), handle: first },
      { ...otherReference, handle: other },
    ]);
    await cacheImages(cache, 2);

    cache.removeImage(cachedReference());
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(other.close).not.toHaveBeenCalled();
    expect(cache.resolveImage(otherReference)).toMatchObject({
      handle: other,
    });
  });

  it("contains hostile close access/calls and supports primitive, function, and non-callable identities", async () => {
    const privateDetail = "private close failure";
    const hostile = Object.defineProperty({}, "close", {
      get() {
        throw new Error(privateDetail);
      },
    });
    const throwing = {
      close() {
        throw new Error(privateDetail);
      },
    };
    const callable = Object.assign(() => undefined, { close: vi.fn() });
    const cache = lifecycleCache([
      { ...cachedReference(), handle: hostile },
      { ...cachedReference({ sha256: OTHER_SHA256 }), handle: 7 },
      {
        ...cachedReference({ sha256: `sha256:${"a".repeat(64)}` }),
        handle: callable,
      },
      {
        ...cachedReference({ sha256: `sha256:${"b".repeat(64)}` }),
        handle: throwing,
      },
      {
        ...cachedReference({ sha256: `sha256:${"c".repeat(64)}` }),
        handle: { close: 3 },
      },
    ]);
    await cacheImages(cache, 5);

    expect(() => cache.clear()).not.toThrow();
    expect(callable.close).toHaveBeenCalledTimes(1);
    expect(cache.resolveImage(cachedReference())).toBeNull();
  });
});

type StagedCacheLease = {
  readonly image: CachedPng;
  readonly candidateAccepted: boolean;
  release(): void;
};

type StagedCacheCandidateDisposition = {
  dispose(): void;
};

type StagedCacheAdoption = {
  readonly status: "inserted" | "reused" | "conflict" | "invalid";
  readonly candidateAccepted: boolean;
  readonly candidateDisposition: StagedCacheCandidateDisposition | null;
  readonly lease: StagedCacheLease | null;
};

type StagedLeaseCache = PngCacheLifecycle & {
  acquireStagedPng(input: unknown): StagedCacheAdoption;
};

function stagedCache(
  candidates: ReadonlyArray<
    Omit<CachedPng, "handle"> & { readonly handle: unknown }
  > = [],
): StagedLeaseCache {
  return lifecycleCache(candidates) as StagedLeaseCache;
}

function stagedPng(
  handle: unknown,
  overrides: Partial<Omit<CachedPng, "handle">> = {},
) {
  return { ...cachedReference(), ...overrides, handle };
}

describe("staged PNG cache leases", () => {
  it("adopts a staged-only image and removes/closes it on the final idempotent release", () => {
    const handle = { close: vi.fn() };
    const cache = stagedCache();
    const result = cache.acquireStagedPng(stagedPng(handle));

    expect(result).toMatchObject({
      status: "inserted",
      candidateAccepted: true,
      lease: { image: { handle } },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.lease)).toBe(true);
    result.lease?.release();
    result.lease?.release();
    expect(cache.resolveImage(cachedReference())).toBeNull();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("keeps staged leases independent until the last release", () => {
    const handle = { close: vi.fn() };
    const cache = stagedCache();
    const first = cache.acquireStagedPng(stagedPng(handle));
    const second = cache.acquireStagedPng(stagedPng(handle));

    expect(second).toMatchObject({ status: "reused", candidateAccepted: true });
    first.lease?.release();
    expect(cache.resolveImage(cachedReference())).toMatchObject({ handle });
    expect(handle.close).not.toHaveBeenCalled();
    second.lease?.release();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("returns the established persistent image for a redundant candidate without disposing it", async () => {
    const persistent = { close: vi.fn() };
    const redundant = { close: vi.fn() };
    const cache = stagedCache([{ ...cachedReference(), handle: persistent }]);
    await cache.importPng({ mimeType: "image/png", bytes: PNG_BYTES });
    const result = cache.acquireStagedPng(stagedPng(redundant));

    expect(result).toMatchObject({
      status: "reused",
      candidateAccepted: false,
    });
    result.lease?.release();
    expect(redundant.close).not.toHaveBeenCalled();
    expect(cache.resolveImage(cachedReference())).toMatchObject({
      handle: persistent,
    });
    expect(persistent.close).not.toHaveBeenCalled();
  });

  it("promotes a lease-only entry through import and retains it after its lease releases", async () => {
    const adopted = { close: vi.fn() };
    const decoded = { close: vi.fn() };
    const cache = stagedCache([{ ...cachedReference(), handle: decoded }]);
    const adoption = cache.acquireStagedPng(stagedPng(adopted));

    await cache.importPng({ mimeType: "image/png", bytes: PNG_BYTES });
    adoption.lease?.release();

    expect(cache.resolveImage(cachedReference())).toMatchObject({
      handle: adopted,
    });
    expect(decoded.close).toHaveBeenCalledTimes(1);
    expect(adopted.close).not.toHaveBeenCalled();
  });

  it("preserves a lease-only entry for metadata conflicts and persistent removal during a lease", async () => {
    const adopted = { close: vi.fn() };
    const conflict = { close: vi.fn() };
    const persistent = { close: vi.fn() };
    const cache = stagedCache([{ ...cachedReference(), handle: persistent }]);
    const leaseOnly = cache.acquireStagedPng(stagedPng(adopted));

    expect(
      cache.acquireStagedPng(stagedPng(conflict, { width: 21 })),
    ).toMatchObject({
      status: "conflict",
      candidateAccepted: false,
      lease: null,
    });
    expect(cache.removeImage(cachedReference())).toBe(false);
    await cache.importPng({ mimeType: "image/png", bytes: PNG_BYTES });
    expect(cache.removeImage(cachedReference())).toBe(true);
    expect(cache.resolveImage(cachedReference())).toMatchObject({
      handle: adopted,
    });
    leaseOnly.lease?.release();
    expect(cache.resolveImage(cachedReference())).toBeNull();
    expect(adopted.close).toHaveBeenCalledTimes(1);
    expect(conflict.close).not.toHaveBeenCalled();
    expect(persistent.close).toHaveBeenCalledTimes(1);
  });

  it("uses Object.is metadata and shares one close across SHA-distinct staged entries", () => {
    const handle = { close: vi.fn() };
    const cache = stagedCache();
    const first = cache.acquireStagedPng(stagedPng(handle, { byteLength: -0 }));
    const conflict = cache.acquireStagedPng(stagedPng({}, { byteLength: 0 }));
    const second = cache.acquireStagedPng(
      stagedPng(handle, { sha256: OTHER_SHA256, byteLength: -0 }),
    );

    expect(conflict).toMatchObject({
      status: "conflict",
      candidateAccepted: false,
    });
    first.lease?.release();
    expect(handle.close).not.toHaveBeenCalled();
    second.lease?.release();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("contains hostile candidates and release reentrancy without mutating the cache", () => {
    const cache = stagedCache();
    const hostile = Object.defineProperty({}, "sha256", {
      get() {
        throw new Error("private staged getter");
      },
    });
    let lease: StagedCacheLease | null = null;
    const handle = { close: vi.fn(() => lease?.release()) };
    const adopted = cache.acquireStagedPng(stagedPng(handle));
    lease = adopted.lease;

    expect(cache.acquireStagedPng(hostile)).toMatchObject({
      status: "invalid",
      candidateAccepted: false,
      lease: null,
    });
    lease?.release();
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(cache.resolveImage(cachedReference())).toBeNull();
  });

  it("makes clear invalidate active leases without closing twice and normalizes invalid staged inputs", () => {
    const handle = { close: vi.fn() };
    const cache = stagedCache();
    const adopted = cache.acquireStagedPng(stagedPng(handle));

    cache.clear();
    adopted.lease?.release();
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(cache.acquireStagedPng(null)).toMatchObject({
      status: "invalid",
      candidateAccepted: false,
      lease: null,
    });
  });

  it("snapshots staged getters once and gives the publisher a frozen disposition", () => {
    const cache = stagedCache();
    const handle = { close: vi.fn() };
    const observations = new Map<string, number>();
    const candidate = Object.defineProperties(
      {},
      Object.fromEntries(
        Object.entries(stagedPng(handle)).map(([key, value]) => [
          key,
          {
            enumerable: true,
            get() {
              observations.set(key, (observations.get(key) ?? 0) + 1);
              return value;
            },
          },
        ]),
      ),
    );

    const adoption = cache.acquireStagedPng(candidate);

    expect(adoption).toMatchObject({
      status: "inserted",
      candidateAccepted: true,
      candidateDisposition: { dispose: expect.any(Function) },
    });
    expect(Object.isFrozen(adoption)).toBe(true);
    expect(Object.isFrozen(adoption.candidateDisposition)).toBe(true);
    expect([...observations.values()]).toEqual([1, 1, 1, 1, 1, 1]);
    adoption.candidateDisposition?.dispose();
    adoption.lease?.release();
    expect(handle.close).toHaveBeenCalledTimes(1);

    const privateDetail = "private staged getter";
    const hostile = Object.defineProperty({}, "sha256", {
      get() {
        throw new Error(privateDetail);
      },
    });
    const invalid = cache.acquireStagedPng(hostile);
    expect(invalid).toMatchObject({
      status: "invalid",
      candidateAccepted: false,
      candidateDisposition: null,
      lease: null,
    });
    expect(Object.isFrozen(invalid)).toBe(true);
    expect(JSON.stringify(invalid)).not.toContain(privateDetail);
  });

  it("retires a claimed staging handle through the disposition without closing its cache lease", async () => {
    const handle = { close: vi.fn() };
    const batch = await staging.stageCanonicalReferencePlan(
      stagingPlan(1),
      stagingDependencies([handle]),
    );
    const [candidate] = batch.claim();
    const cache = stagedCache();
    const adoption = cache.acquireStagedPng(candidate);

    adoption.candidateDisposition?.dispose();
    adoption.candidateDisposition?.dispose();
    expect(handle.close).not.toHaveBeenCalled();
    adoption.lease?.release();
    expect(handle.close).toHaveBeenCalledTimes(1);
    await expect(
      staging.stageCanonicalReferencePlan(
        stagingPlan(1),
        stagingDependencies([handle]),
      ),
    ).rejects.toMatchObject({ code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED" });
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("lets cache authority dispose candidates without closing cache-owned identities", async () => {
    const established = { close: vi.fn() };
    const redundant = { close: vi.fn() };
    const conflicting = { close: vi.fn() };
    const crossSha = { close: vi.fn() };
    const otherReference = cachedReference({ sha256: OTHER_SHA256 });

    const seeded = stagedCache([{ ...cachedReference(), handle: established }]);
    await seeded.importPng({ mimeType: "image/png", bytes: PNG_BYTES });
    const sameIdentityConflict = seeded.acquireStagedPng(
      stagedPng(established, { width: 21 }),
    );
    const distinctConflict = seeded.acquireStagedPng(
      stagedPng(conflicting, { width: 21 }),
    );
    const duplicate = seeded.acquireStagedPng(stagedPng(redundant));

    sameIdentityConflict.candidateDisposition?.dispose();
    sameIdentityConflict.candidateDisposition?.dispose();
    distinctConflict.candidateDisposition?.dispose();
    duplicate.candidateDisposition?.dispose();
    duplicate.lease?.release();
    expect(established.close).not.toHaveBeenCalled();
    expect(conflicting.close).toHaveBeenCalledTimes(1);
    expect(redundant.close).toHaveBeenCalledTimes(1);
    expect(seeded.removeImage(cachedReference())).toBe(true);
    expect(established.close).toHaveBeenCalledTimes(1);

    const crossShaCache = stagedCache([
      { ...otherReference, handle: crossSha },
    ]);
    await crossShaCache.importPng({ mimeType: "image/png", bytes: PNG_BYTES });
    const crossShaAdoption = crossShaCache.acquireStagedPng(
      stagedPng(crossSha),
    );
    crossShaAdoption.candidateDisposition?.dispose();
    crossShaAdoption.candidateDisposition?.dispose();
    crossShaAdoption.lease?.release();
    expect(crossSha.close).not.toHaveBeenCalled();
    expect(crossShaCache.removeImage(otherReference)).toBe(true);
    expect(crossSha.close).toHaveBeenCalledTimes(1);
  });

  it("rejects reentrant staging and import publication before observing hostile input", async () => {
    let cache: StagedLeaseCache;
    let reentrantImport: Promise<unknown> | undefined;
    const observations = { staged: 0, imported: 0, decoded: 0 };
    const handle = {
      close: vi.fn(() => {
        const hostileStaged = new Proxy(
          {},
          {
            get() {
              observations.staged += 1;
              throw new Error("private staged reentrancy");
            },
          },
        );
        const rejected = cache.acquireStagedPng(hostileStaged);
        expect(rejected).toMatchObject({
          status: "invalid",
          candidateAccepted: false,
          candidateDisposition: null,
          lease: null,
        });
        expect(Object.isFrozen(rejected)).toBe(true);

        const hostileImport = new Proxy(
          {},
          {
            get() {
              observations.imported += 1;
              throw new Error("private import reentrancy");
            },
          },
        );
        reentrantImport = cache.importPng(
          hostileImport as { mimeType: string; bytes: Uint8Array },
        );
      }),
    };
    cache = pngCacheRuntime.createPngImageCache({
      importVerifiedPng: async () => {
        observations.imported += 1;
        return verifiedAsset();
      },
      decodeVerifiedPng: async () => {
        observations.decoded += 1;
        return { ...cachedReference(), handle };
      },
    }) as StagedLeaseCache;
    await cache.importPng({ mimeType: "image/png", bytes: PNG_BYTES });

    expect(cache.removeImage(cachedReference())).toBe(true);
    await expect(reentrantImport).rejects.toMatchObject({
      code: "EDITOR_PNG_CACHE_IMPORT_FAILED",
    });
    expect(observations).toEqual({ staged: 0, imported: 1, decoded: 1 });
    expect(handle.close).toHaveBeenCalledTimes(1);
  });
});

type PlannedImageReference = {
  readonly elementId: string;
  readonly sha256: string;
  readonly mimeType: "image/png";
  readonly byteLength: number;
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
};

type CanonicalReferencePlanningResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly document: object;
        readonly canonicalEditableJson: string;
        readonly references: readonly PlannedImageReference[];
      };
    }
  | { readonly ok: false; readonly error: { readonly code: string } };

type CanonicalReferencePlanDependencies = {
  readonly importEditableJson: typeof validateSceneDocument.importEditableJson;
  readonly exportEditableJson: typeof canonicalizeSceneDocument.exportEditableJson;
};

type CanonicalReferencePlanningRuntime = {
  createCanonicalReferencePlan(
    editableJson: string,
    dependencies?: CanonicalReferencePlanDependencies,
  ): CanonicalReferencePlanningResult;
};

const canonicalReferencePlanningRuntime =
  recoveryHarness as unknown as CanonicalReferencePlanningRuntime;

function createCanonicalReferencePlan(
  editableJson: string,
  dependencies?: CanonicalReferencePlanDependencies,
) {
  return canonicalReferencePlanningRuntime.createCanonicalReferencePlan(
    editableJson,
    dependencies,
  );
}

function imageDocument(
  images: ReadonlyArray<{
    readonly id: string;
    readonly sha256?: string;
    readonly intrinsicWidth?: number;
  }>,
) {
  return {
    ...FIRST_SLICE_DOCUMENT,
    rootIds: images.map((image) => image.id),
    elements: images.map((image) => ({
      id: image.id,
      type: "image" as const,
      asset: {
        sha256: image.sha256 ?? PNG_SHA256,
        mimeType: "image/png" as const,
        byteLength: PNG_BYTES.byteLength,
        intrinsicWidth: image.intrinsicWidth ?? 20,
        intrinsicHeight: 10,
      },
      x: 0,
      y: 0,
      width: 20,
      height: 10,
      opacity: 1,
    })),
    tracks: [],
  };
}

describe("canonical editable JSON reference plan", () => {
  it("plans a valid no-reference document with frozen isolated canonical output", () => {
    const source = structuredClone(FIRST_SLICE_DOCUMENT);
    const input = JSON.stringify(source);
    const result = createCanonicalReferencePlan(input);
    (source.elements[0] as { id: string }).id = "caller-mutated";

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.references).toEqual([]);
    expect(result.value.canonicalEditableJson).toBe(
      new TextDecoder().decode(
        canonicalizeSceneDocument.exportEditableJson(FIRST_SLICE_DOCUMENT),
      ),
    );
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.document)).toBe(true);
    expect(Object.isFrozen(result.value.references)).toBe(true);
    expect(result.value.document).toMatchObject(FIRST_SLICE_DOCUMENT);

    const roundTrip = createCanonicalReferencePlan(
      result.value.canonicalEditableJson,
    );
    expect(roundTrip).toEqual(result);
  });

  it("enumerates image assets in document order and deduplicates equal declarations", () => {
    const result = createCanonicalReferencePlan(
      JSON.stringify(
        imageDocument([
          { id: "image-b" },
          { id: "image-b-repeat" },
          { id: "image-a", sha256: OTHER_SHA256 },
        ]),
      ),
    );

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.references).toEqual([
      {
        elementId: "image-b",
        sha256: PNG_SHA256,
        mimeType: "image/png",
        byteLength: PNG_BYTES.byteLength,
        intrinsicWidth: 20,
        intrinsicHeight: 10,
      },
      {
        elementId: "image-a",
        sha256: OTHER_SHA256,
        mimeType: "image/png",
        byteLength: PNG_BYTES.byteLength,
        intrinsicWidth: 20,
        intrinsicHeight: 10,
      },
    ]);
    expect(Object.isFrozen(result.value.references[0])).toBe(true);
    expect(() => {
      (result.value.references[0] as { elementId: string }).elementId =
        "changed";
    }).toThrow(TypeError);
    expect(
      createCanonicalReferencePlan(result.value.canonicalEditableJson),
    ).toEqual(result);
  });

  it("rejects conflicting metadata for one content declaration with a stable error", () => {
    const result = createCanonicalReferencePlan(
      JSON.stringify(
        imageDocument([
          { id: "image-a" },
          { id: "image-b", intrinsicWidth: 21 },
        ]),
      ),
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "SCENE_DOCUMENT_REFERENCE_METADATA_CONFLICT" },
    });
  });

  it("preserves accepted editable JSON import failures without planning references", () => {
    const imports = [
      "not JSON",
      JSON.stringify({ ...FIRST_SLICE_DOCUMENT, schemaVersion: 2 }),
      JSON.stringify({ ...FIRST_SLICE_DOCUMENT, unknown: true }),
    ];

    for (const editableJson of imports) {
      const expected = validateSceneDocument.importEditableJson(editableJson);
      const exportEditableJson = vi.fn(() => new Uint8Array());
      expect(
        createCanonicalReferencePlan(editableJson, {
          importEditableJson: validateSceneDocument.importEditableJson,
          exportEditableJson,
        }),
      ).toEqual(expected);
      expect(exportEditableJson).not.toHaveBeenCalled();
    }
  });
});

const HOSTILE_PLANNER_FAILURE = {
  ok: false as const,
  error: { code: "SCENE_DOCUMENT_REFERENCE_PLAN_DEPENDENCY_FAILED" },
};

function hostilePlanDependencies(
  dependencies: Record<string, unknown>,
): CanonicalReferencePlanDependencies {
  return dependencies as unknown as CanonicalReferencePlanDependencies;
}

function expectStableHostilePlannerFailure(
  dependencies: CanonicalReferencePlanDependencies,
  privateDetail: string,
): void {
  const result = createCanonicalReferencePlan("ignored", dependencies);

  expect(result).toEqual(HOSTILE_PLANNER_FAILURE);
  expect(JSON.stringify(result)).not.toContain(privateDetail);
}

describe("hostile canonical reference planner dependencies", () => {
  it("returns fresh frozen dependency failures that cannot poison later calls", () => {
    const dependencies = hostilePlanDependencies({
      importEditableJson: () => ({ ok: true, value: FIRST_SLICE_DOCUMENT }),
      exportEditableJson: () => "invalid",
    });
    const first = createCanonicalReferencePlan("ignored", dependencies);
    if (first.ok) throw new Error("expected dependency failure");
    expect(Object.isFrozen(first) && Object.isFrozen(first.error)).toBe(true);
    expect(() => {
      (first.error as { code: string }).code = "poisoned";
    }).toThrow(TypeError);
    const next = createCanonicalReferencePlan("ignored", dependencies);
    expect(next).toEqual(HOSTILE_PLANNER_FAILURE);
    expect(next).not.toBe(first);
  });

  it.each([
    [
      "throwing importer call",
      "private importer call",
      () => ({
        importEditableJson() {
          throw new Error("private importer call");
        },
        exportEditableJson: canonicalizeSceneDocument.exportEditableJson,
      }),
    ],
    [
      "throwing importer dependency getter",
      "private importer getter",
      () =>
        Object.defineProperty(
          { exportEditableJson: canonicalizeSceneDocument.exportEditableJson },
          "importEditableJson",
          {
            get() {
              throw new Error("private importer getter");
            },
          },
        ),
    ],
    [
      "revoked importer dependency proxy",
      "private revoked importer",
      () => {
        const revoked = Proxy.revocable(
          {
            importEditableJson: validateSceneDocument.importEditableJson,
            exportEditableJson: canonicalizeSceneDocument.exportEditableJson,
          },
          {},
        );
        revoked.revoke();
        return revoked.proxy;
      },
    ],
    [
      "malformed success result",
      "private malformed success",
      () => ({
        importEditableJson: () => ({ ok: true }),
        exportEditableJson: canonicalizeSceneDocument.exportEditableJson,
      }),
    ],
    [
      "throwing importer result discriminant",
      "private result getter",
      () => ({
        importEditableJson: () =>
          Object.defineProperty({}, "ok", {
            get() {
              throw new Error("private result getter");
            },
          }),
        exportEditableJson: canonicalizeSceneDocument.exportEditableJson,
      }),
    ],
    [
      "throwing imported value getter",
      "private value getter",
      () => ({
        importEditableJson: () =>
          Object.defineProperties(
            { ok: true },
            {
              value: {
                get() {
                  throw new Error("private value getter");
                },
              },
            },
          ),
        exportEditableJson: canonicalizeSceneDocument.exportEditableJson,
      }),
    ],
    [
      "malformed image-elements iterable",
      "private elements iterable",
      () => ({
        importEditableJson: () => ({
          ok: true,
          value: { elements: { [Symbol.iterator]: 3 } },
        }),
        exportEditableJson: canonicalizeSceneDocument.exportEditableJson,
      }),
    ],
    [
      "throwing planned element getter",
      "private element getter",
      () => ({
        importEditableJson: () => ({
          ok: true,
          value: {
            elements: [
              Object.defineProperty({}, "type", {
                get() {
                  throw new Error("private element getter");
                },
              }),
            ],
          },
        }),
        exportEditableJson: canonicalizeSceneDocument.exportEditableJson,
      }),
    ],
    [
      "throwing planned asset getter",
      "private asset getter",
      () => {
        const document = imageDocument([{ id: "image-a" }]);
        Object.defineProperty(document.elements[0]!, "asset", {
          get() {
            throw new Error("private asset getter");
          },
        });
        return {
          importEditableJson: () => ({ ok: true, value: document }),
          exportEditableJson: canonicalizeSceneDocument.exportEditableJson,
        };
      },
    ],
    [
      "throwing canonical exporter",
      "private exporter call",
      () => ({
        importEditableJson: () => ({ ok: true, value: FIRST_SLICE_DOCUMENT }),
        exportEditableJson() {
          throw new Error("private exporter call");
        },
      }),
    ],
    [
      "throwing exporter dependency getter",
      "private exporter getter",
      () =>
        Object.defineProperty(
          {
            importEditableJson: () => ({
              ok: true,
              value: FIRST_SLICE_DOCUMENT,
            }),
          },
          "exportEditableJson",
          {
            get() {
              throw new Error("private exporter getter");
            },
          },
        ),
    ],
    [
      "non-byte canonical exporter output",
      "private exporter output",
      () => ({
        importEditableJson: () => ({ ok: true, value: FIRST_SLICE_DOCUMENT }),
        exportEditableJson: () => "private exporter output",
      }),
    ],
    [
      "ArrayBuffer canonical exporter output",
      "private exporter output",
      () => ({
        importEditableJson: () => ({ ok: true, value: FIRST_SLICE_DOCUMENT }),
        exportEditableJson: () => new ArrayBuffer(0),
      }),
    ],
    [
      "DataView canonical exporter output",
      "private exporter output",
      () => ({
        importEditableJson: () => ({ ok: true, value: FIRST_SLICE_DOCUMENT }),
        exportEditableJson: () => new DataView(new ArrayBuffer(0)),
      }),
    ],
  ])(
    "normalizes %s without leaking injected details",
    (_label, privateDetail, createDependencies) => {
      expectStableHostilePlannerFailure(
        hostilePlanDependencies(createDependencies()),
        privateDetail,
      );
    },
  );

  it("returns an accepted P2a import failure exactly and never exports", () => {
    const acceptedFailure = {
      ok: false as const,
      error: { code: "P2A_IMPORT_FAILED", message: "ordinary P2a error" },
    };
    const exportEditableJson = vi.fn();

    const result = createCanonicalReferencePlan(
      "ignored",
      hostilePlanDependencies({
        importEditableJson: () => acceptedFailure,
        exportEditableJson,
      }),
    );

    expect(result).toBe(acceptedFailure);
    expect(result).toEqual(acceptedFailure);
    expect(exportEditableJson).not.toHaveBeenCalled();
  });
});

type StagingRuntime = {
  stageCanonicalReferencePlan(
    plan: unknown,
    dependencies: unknown,
  ): Promise<{
    readonly plan: { readonly document: object };
    readonly entries: readonly {
      readonly reference: { readonly elementId: string };
      readonly bytes: Uint8Array;
      readonly handle: unknown;
    }[];
    release(): void;
    claim(): readonly unknown[];
  }>;
};

const staging = recoveryHarness as unknown as StagingRuntime;

function stagingPlan(count: number) {
  return {
    document: { nested: { stable: true } },
    canonicalEditableJson: "{}",
    references: Array.from({ length: count }, (_, index) => ({
      elementId: `image-${index}`,
      sha256: index === 0 ? PNG_SHA256 : OTHER_SHA256,
      mimeType: "image/png" as const,
      byteLength: PNG_BYTES.byteLength,
      intrinsicWidth: 20,
      intrinsicHeight: 10,
    })),
  };
}

function stagingDependencies(handles: unknown[] = [], failure = -1) {
  let decoded = 0;
  return {
    rereadVerifiedPng: vi.fn(async (sha256: string) => ({
      sha256,
      mimeType: "image/png" as const,
      byteLength: PNG_BYTES.byteLength,
      bytes: PNG_BYTES.slice(),
    })),
    decodeVerifiedPng: vi.fn(
      async (asset: {
        readonly sha256: string;
        readonly mimeType: "image/png";
        readonly byteLength: number;
        readonly bytes: Uint8Array;
      }) => {
        const index = decoded++;
        if (index === failure) throw new Error("private decode detail");
        return {
          ...asset,
          width: 20,
          height: 10,
          handle: handles[index] ?? { index },
        };
      },
    ),
  };
}

describe("sequential verified-asset staging", () => {
  it("isolates the synchronous plan snapshot and processes durable references in order", async () => {
    const plan = stagingPlan(2);
    const dependencies = stagingDependencies();
    const pending = staging.stageCanonicalReferencePlan(plan, dependencies);
    plan.references[0]!.elementId = "changed";
    plan.document.nested.stable = false;
    const batch = await pending;

    expect(dependencies.rereadVerifiedPng.mock.calls).toEqual([
      [PNG_SHA256],
      [OTHER_SHA256],
    ]);
    expect(batch.entries.map((entry) => entry.reference.elementId)).toEqual([
      "image-0",
      "image-1",
    ]);
    expect(batch.plan.document).toEqual({ nested: { stable: true } });
    expect(Object.isFrozen(batch.entries[0])).toBe(true);
    expect(batch.entries[0]!.bytes).not.toBe(batch.entries[0]!.bytes);
  });

  it("does no dependency work for an empty plan and normalizes hostile metadata", async () => {
    const empty = await staging.stageCanonicalReferencePlan(stagingPlan(0), {
      get rereadVerifiedPng() {
        throw new Error("must not observe dependencies");
      },
    });
    expect(empty.entries).toEqual([]);

    const dependencies = stagingDependencies();
    dependencies.decodeVerifiedPng.mockResolvedValueOnce(
      Object.defineProperty({}, "handle", {
        get() {
          throw new Error("private decoded getter");
        },
      }) as never,
    );
    await expect(
      staging.stageCanonicalReferencePlan(stagingPlan(1), dependencies),
    ).rejects.toMatchObject({
      code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED",
      message: "EDITOR_VERIFIED_ASSET_STAGING_FAILED",
    });

    const signedZero = stagingPlan(1);
    signedZero.references[0]!.byteLength = -0;
    const zeros = stagingDependencies();
    zeros.rereadVerifiedPng.mockResolvedValueOnce({
      sha256: PNG_SHA256,
      mimeType: "image/png",
      byteLength: 0,
      bytes: new Uint8Array(),
    });
    await expect(
      staging.stageCanonicalReferencePlan(signedZero, zeros),
    ).rejects.toMatchObject({ code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED" });
  });

  it("releases only attempt-owned handles in reverse after each failure", async () => {
    for (const failure of [0, 1, 2]) {
      const released: number[] = [];
      const handles = Array.from({ length: 3 }, (_, index) => ({
        close: vi.fn(() => released.push(index)),
      }));
      await expect(
        staging.stageCanonicalReferencePlan(
          stagingPlan(3),
          stagingDependencies(handles, failure),
        ),
      ).rejects.toMatchObject({ code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED" });
      expect(released).toEqual(
        failure === 0 ? [] : failure === 1 ? [0] : [1, 0],
      );
    }
  });

  it("registers a decoded handle before later decoded getters can fail", async () => {
    for (const property of ["sha256", "bytes", "handle"] as const) {
      const released: number[] = [];
      const handles = Array.from({ length: 2 }, (_, index) => ({
        close: vi.fn(() => released.push(index)),
      }));
      let decoded = 0;
      const dependencies = {
        rereadVerifiedPng: async (sha256: string) => ({
          sha256,
          mimeType: "image/png" as const,
          byteLength: PNG_BYTES.byteLength,
          bytes: PNG_BYTES.slice(),
        }),
        decodeVerifiedPng: async (verified: AssetRecord) => {
          const index = decoded++;
          const value = {
            ...verified,
            width: 20,
            height: 10,
            handle: handles[index]!,
          };
          if (index > 0) {
            Object.defineProperty(value, property, {
              get() {
                throw new Error(`private decoded ${property} getter`);
              },
            });
          }
          return value;
        },
      };

      await expect(
        staging.stageCanonicalReferencePlan(stagingPlan(2), dependencies),
      ).rejects.toMatchObject({ code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED" });
      expect(released).toEqual(property === "handle" ? [0] : [1, 0]);
    }
  });

  it("releases idempotently, transfers exactly once, and keeps batches independent", async () => {
    const first = { close: vi.fn() };
    const released = await staging.stageCanonicalReferencePlan(
      stagingPlan(1),
      stagingDependencies([first]),
    );
    released.release();
    released.release();
    expect(first.close).toHaveBeenCalledTimes(1);

    const claimed = await staging.stageCanonicalReferencePlan(
      stagingPlan(1),
      stagingDependencies([{ close: vi.fn() }]),
    );
    expect(claimed.claim()).toHaveLength(1);
    claimed.release();
    await expect(
      Promise.resolve().then(() => claimed.claim()),
    ).rejects.toMatchObject({
      code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED",
    });
  });
});

describe("weak sequential staged-handle ownership", () => {
  it("rejects a shared object while active and after its owning batch releases it", async () => {
    const handle = { close: vi.fn() };
    const first = await staging.stageCanonicalReferencePlan(
      stagingPlan(1),
      stagingDependencies([handle]),
    );

    await expect(
      staging.stageCanonicalReferencePlan(
        stagingPlan(1),
        stagingDependencies([handle]),
      ),
    ).rejects.toMatchObject({ code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED" });
    expect(handle.close).not.toHaveBeenCalled();

    first.release();
    expect(handle.close).toHaveBeenCalledTimes(1);
    await expect(
      staging.stageCanonicalReferencePlan(
        stagingPlan(1),
        stagingDependencies([handle]),
      ),
    ).rejects.toMatchObject({ code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED" });
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("keeps claimed ownership reserved without closing the claimed handle", async () => {
    const handle = { close: vi.fn() };
    const batch = await staging.stageCanonicalReferencePlan(
      stagingPlan(1),
      stagingDependencies([handle]),
    );

    expect(batch.claim()).toHaveLength(1);
    batch.release();
    await expect(
      staging.stageCanonicalReferencePlan(
        stagingPlan(1),
        stagingDependencies([handle]),
      ),
    ).rejects.toMatchObject({ code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED" });
    expect(handle.close).not.toHaveBeenCalled();
  });

  it("keeps a decoder's one-shot push trap from interrupting reservation", async () => {
    const handle = { close: vi.fn() };
    const originalPush = Array.prototype.push;
    try {
      const batch = await staging.stageCanonicalReferencePlan(stagingPlan(1), {
        rereadVerifiedPng: async (sha256: string) => ({
          sha256,
          mimeType: "image/png" as const,
          byteLength: PNG_BYTES.byteLength,
          bytes: PNG_BYTES.slice(),
        }),
        decodeVerifiedPng: async (asset: AssetRecord) => {
          Array.prototype.push = () => {
            Array.prototype.push = originalPush;
            throw new Error("one-shot decoder push trap");
          };
          return { ...asset, width: 20, height: 10, handle };
        },
      });

      await expect(
        staging.stageCanonicalReferencePlan(
          stagingPlan(1),
          stagingDependencies([handle]),
        ),
      ).rejects.toMatchObject({ code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED" });
      expect(handle.close).not.toHaveBeenCalled();
      batch.release();
      expect(handle.close).toHaveBeenCalledTimes(1);
    } finally {
      Array.prototype.push = originalPush;
    }
  });

  it("rejects a duplicate object identity in one plan and closes its first owner once", async () => {
    const handle = { close: vi.fn() };

    await expect(
      staging.stageCanonicalReferencePlan(
        stagingPlan(2),
        stagingDependencies([handle, handle]),
      ),
    ).rejects.toMatchObject({ code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED" });
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("treats function handles as weak identities with their close behavior intact", async () => {
    const handle = Object.assign(() => undefined, { close: vi.fn() });
    const first = await staging.stageCanonicalReferencePlan(
      stagingPlan(1),
      stagingDependencies([handle]),
    );

    await expect(
      staging.stageCanonicalReferencePlan(
        stagingPlan(1),
        stagingDependencies([handle]),
      ),
    ).rejects.toMatchObject({ code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED" });
    first.release();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("retires before a throwing close can reenter staging", async () => {
    let reentrant: Promise<unknown> | undefined;
    const handle = {
      close() {
        reentrant = staging.stageCanonicalReferencePlan(
          stagingPlan(1),
          stagingDependencies([handle]),
        );
        throw new Error("private close failure");
      },
    };
    const batch = await staging.stageCanonicalReferencePlan(
      stagingPlan(1),
      stagingDependencies([handle]),
    );

    batch.release();
    await expect(reentrant).rejects.toMatchObject({
      code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED",
    });
    batch.release();
  });

  it("retires before a throwing close getter can be retried or reused", async () => {
    const closeGetter = vi.fn(() => {
      throw new Error("private close getter failure");
    });
    const handle = Object.defineProperty({}, "close", {
      get: closeGetter,
    });
    const batch = await staging.stageCanonicalReferencePlan(
      stagingPlan(1),
      stagingDependencies([handle]),
    );

    batch.release();
    batch.release();
    await expect(
      staging.stageCanonicalReferencePlan(
        stagingPlan(1),
        stagingDependencies([handle]),
      ),
    ).rejects.toMatchObject({ code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED" });
    expect(closeGetter).toHaveBeenCalledTimes(1);
  });

  it("allows distinct identities and primitive handles in independent batches", async () => {
    const first = { close: vi.fn() };
    const second = { close: vi.fn() };
    const firstBatch = await staging.stageCanonicalReferencePlan(
      stagingPlan(1),
      stagingDependencies([first]),
    );
    const secondBatch = await staging.stageCanonicalReferencePlan(
      stagingPlan(1),
      stagingDependencies([second]),
    );
    const primitiveBatch = await staging.stageCanonicalReferencePlan(
      stagingPlan(1),
      stagingDependencies([7]),
    );

    firstBatch.release();
    secondBatch.release();
    primitiveBatch.release();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
  });
});

function hostileStagingPlan(overrides: Record<string, unknown> = {}) {
  const plan = stagingPlan(1) as Record<string, unknown>;
  const reference = (plan.references as Array<Record<string, unknown>>)[0]!;
  for (const [field, value] of Object.entries(overrides)) {
    if (value === undefined) delete reference[field];
    else reference[field] = value;
  }
  return plan;
}

async function captureStagingFailure(
  plan: unknown,
  dependencies: unknown,
): Promise<unknown> {
  try {
    await staging.stageCanonicalReferencePlan(plan, dependencies);
  } catch (error) {
    return error;
  }
  throw new Error("expected staging failure");
}

function expectPublicStagingFailure(failure: unknown): void {
  expect(failure).toMatchObject({
    code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED",
    message: "EDITOR_VERIFIED_ASSET_STAGING_FAILED",
  });
}

async function expectPreflightStagingFailure(plan: unknown): Promise<void> {
  let observations = 0;
  const failure = await captureStagingFailure(plan, {
    get rereadVerifiedPng() {
      observations += 1;
      return async () => asset();
    },
  });
  expect(observations).toBe(0);
  expectPublicStagingFailure(failure);
}

describe("hostile verified-asset staging boundary", () => {
  it.each([
    ["missing element ID", { elementId: undefined }],
    ["invalid element ID", { elementId: "9-invalid" }],
    ["forged SHA", { sha256: "sha256:UPPER" }],
    ["wrong MIME", { mimeType: "image/jpeg" }],
    ["zero length", { byteLength: 0 }],
    ["non-integral width", { intrinsicWidth: 1.5 }],
    ["zero height", { intrinsicHeight: 0 }],
    ["unexpected field", { unexpected: true }],
    ["missing element ID", { elementId: undefined }],
    ["missing SHA", { sha256: undefined }],
    ["missing MIME", { mimeType: undefined }],
    ["missing byte length", { byteLength: undefined }],
    ["missing intrinsic width", { intrinsicWidth: undefined }],
    ["missing intrinsic height", { intrinsicHeight: undefined }],
  ])("rejects %s before dependency observation", async (_label, overrides) => {
    await expectPreflightStagingFailure(hostileStagingPlan(overrides));
  });

  it("returns fresh frozen staging failures despite poisoned Error prototype properties", () => {
    const descriptors = new Map(
      ["name", "stack", "cause"].map((property) => [
        property,
        Object.getOwnPropertyDescriptor(Error.prototype, property),
      ]),
    );
    try {
      Object.defineProperties(Error.prototype, {
        name: {
          configurable: true,
          set() {
            throw new Error("private inherited name setter");
          },
        },
        stack: {
          configurable: true,
          get() {
            return "private inherited stack getter";
          },
        },
        cause: {
          configurable: true,
          get() {
            return "private inherited cause getter";
          },
        },
      });
      const first = new VerifiedAssetStagingError();
      const second = new VerifiedAssetStagingError();

      expect(first).toBeInstanceOf(Error);
      expect(first).toBeInstanceOf(VerifiedAssetStagingError);
      expect(first).toMatchObject({
        name: "VerifiedAssetStagingError",
        code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED",
        message: "EDITOR_VERIFIED_ASSET_STAGING_FAILED",
      });
      expect(first.stack).toBeUndefined();
      expect(first.cause).toBeUndefined();
      expect(Object.isFrozen(first)).toBe(true);
      expect(() => {
        (first as { name: string }).name = "poisoned";
      }).toThrow(TypeError);
      expect(second).toMatchObject({
        name: "VerifiedAssetStagingError",
        code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED",
        message: "EDITOR_VERIFIED_ASSET_STAGING_FAILED",
      });
    } finally {
      for (const [property, descriptor] of descriptors) {
        if (descriptor === undefined) {
          delete (Error.prototype as unknown as Record<string, unknown>)[
            property
          ];
        } else {
          Object.defineProperty(Error.prototype, property, descriptor);
        }
      }
    }
  });

  it.each([
    [
      "dependency function getter",
      () =>
        Object.defineProperty({}, "rereadVerifiedPng", {
          get() {
            throw new Error("private dependency getter");
          },
        }),
    ],
    [
      "reread primitive rejection",
      () => ({ rereadVerifiedPng: () => Promise.reject("private rejection") }),
    ],
    [
      "reread metadata getter",
      () => ({
        rereadVerifiedPng: async () =>
          Object.defineProperty({}, "sha256", {
            get() {
              throw new Error("private metadata getter");
            },
          }),
        decodeVerifiedPng: vi.fn(),
      }),
    ],
    [
      "reread bytes getter",
      () => ({
        rereadVerifiedPng: async () =>
          Object.defineProperty(asset(), "bytes", {
            get() {
              throw new Error("private bytes getter");
            },
          }),
        decodeVerifiedPng: vi.fn(),
      }),
    ],
  ])("normalizes hostile %s", async (_label, createDependencies) => {
    const failure = await captureStagingFailure(
      stagingPlan(1),
      createDependencies(),
    );

    expect(failure).toMatchObject({
      code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED",
      message: "EDITOR_VERIFIED_ASSET_STAGING_FAILED",
    });
    expect(String(failure)).not.toContain("private");
  });

  it.each([
    ["ArrayBuffer", new ArrayBuffer(PNG_BYTES.byteLength)],
    ["DataView", new DataView(new ArrayBuffer(PNG_BYTES.byteLength))],
    ["Int8Array", new Int8Array(PNG_BYTES)],
    ["tag spoof", { [Symbol.toStringTag]: "Uint8Array" }],
    ["proxy", new Proxy(PNG_BYTES, {})],
  ])(
    "rejects %s reread bytes before decoder observation",
    async (_label, bytes) => {
      const decodeVerifiedPng = vi.fn();
      const failure = await captureStagingFailure(stagingPlan(1), {
        rereadVerifiedPng: async () => asset({ bytes: bytes as Uint8Array }),
        decodeVerifiedPng,
      });

      expect(failure).toMatchObject({
        code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED",
      });
      expect(decodeVerifiedPng).not.toHaveBeenCalled();
    },
  );

  it("copies a cross-realm Uint8Array and denies decoder byte mutation or retention", async () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const foreignWindow = iframe.contentWindow as unknown as {
      Uint8Array: Uint8ArrayConstructor;
    };
    const foreignBytes = new foreignWindow.Uint8Array(PNG_BYTES);
    iframe.remove();
    let retained: Uint8Array | undefined;
    const batch = await staging.stageCanonicalReferencePlan(stagingPlan(1), {
      rereadVerifiedPng: async () => asset({ bytes: foreignBytes }),
      decodeVerifiedPng: async (verified: AssetRecord) => {
        const first = verified.bytes;
        const second = verified.bytes;
        retained = first;
        first[0] = 9;
        second[1] = 8;
        return {
          sha256: verified.sha256,
          mimeType: verified.mimeType,
          byteLength: verified.byteLength,
          bytes: verified.bytes,
          width: 20,
          height: 10,
          handle: {},
        };
      },
    });

    retained![2] = 7;
    expect(batch.entries[0]!.bytes).toEqual(PNG_BYTES);
    expect(Array.from(foreignBytes)).toEqual(Array.from(PNG_BYTES));
  });
});

type PublishedImageWorkspace = {
  readonly plan: { readonly references: readonly PlannedImageReference[] };
  readonly images: readonly CachedPng[];
  release(): void;
};

type WorkspacePublicationRuntime = {
  publishStagedCanonicalReferenceBatch(
    batch: unknown,
    cache: unknown,
  ): PublishedImageWorkspace;
};

const workspacePublicationRuntime =
  recoveryHarness as unknown as WorkspacePublicationRuntime;

describe("atomic workspace publication orchestration", () => {
  it("claims once and atomically exposes frozen ordered images after exact resolution", async () => {
    const handles = [{ close: vi.fn() }, { close: vi.fn() }];
    const batch = await staging.stageCanonicalReferencePlan(
      stagingPlan(2),
      stagingDependencies(handles),
    );
    const cache = stagedCache();

    const workspace =
      workspacePublicationRuntime.publishStagedCanonicalReferenceBatch(
        batch,
        cache,
      );

    expect(workspace.images.map((image) => image.sha256)).toEqual([
      PNG_SHA256,
      OTHER_SHA256,
    ]);
    expect(workspace.images.map((image) => image.handle)).toEqual(handles);
    expect(
      workspace.plan.references.map((reference) => reference.elementId),
    ).toEqual(["image-0", "image-1"]);
    expect(Object.isFrozen(workspace)).toBe(true);
    expect(Object.isFrozen(workspace.images)).toBe(true);
    expect(Object.isFrozen(workspace.images[0])).toBe(true);
    workspace.release();
    workspace.release();
    expect(handles[1]!.close).toHaveBeenCalledTimes(1);
    expect(handles[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("claims empty batches, freezes isolated plan state, and preserves sequential workspaces", async () => {
    const empty = await staging.stageCanonicalReferencePlan(
      stagingPlan(0),
      stagingDependencies(),
    );
    const emptyWorkspace =
      workspacePublicationRuntime.publishStagedCanonicalReferenceBatch(
        empty,
        stagedCache(),
      );
    expect(emptyWorkspace.images).toEqual([]);
    expect(Object.isFrozen(emptyWorkspace.plan)).toBe(true);
    expect(() => empty.claim()).toThrow("EDITOR_VERIFIED_ASSET_STAGING_FAILED");

    const firstHandle = { close: vi.fn() };
    const secondHandles = [{ close: vi.fn() }, { close: vi.fn() }];
    const cache = stagedCache();
    const first =
      workspacePublicationRuntime.publishStagedCanonicalReferenceBatch(
        await staging.stageCanonicalReferencePlan(
          stagingPlan(1),
          stagingDependencies([firstHandle]),
        ),
        cache,
      );
    const second =
      workspacePublicationRuntime.publishStagedCanonicalReferenceBatch(
        await staging.stageCanonicalReferencePlan(
          stagingPlan(2),
          stagingDependencies(secondHandles),
        ),
        cache,
      );
    expect(first.images[0]!.handle).toBe(firstHandle);
    expect(second.images.map((image) => image.handle)).toEqual([
      firstHandle,
      secondHandles[1],
    ]);
    first.release();
    expect(firstHandle.close).not.toHaveBeenCalled();
    second.release();
    expect(firstHandle.close).toHaveBeenCalledTimes(1);
    expect(secondHandles[0]!.close).toHaveBeenCalledTimes(1);
    expect(secondHandles[1]!.close).toHaveBeenCalledTimes(1);
  });

  it("fails closed for conflict, invalid adoption, and resolver mismatch without leaking details", async () => {
    const conflictHandle = { close: vi.fn() };
    const persistent = { close: vi.fn() };
    const conflictCache = stagedCache([
      { ...cachedReference({ width: 21 }), handle: persistent },
    ]);
    await conflictCache.importPng({ mimeType: "image/png", bytes: PNG_BYTES });
    await expect(
      Promise.resolve().then(() =>
        workspacePublicationRuntime.publishStagedCanonicalReferenceBatch(
          {
            plan: stagingPlan(1),
            claim: () => [stagedPng(conflictHandle)],
          } as unknown,
          conflictCache,
        ),
      ),
    ).rejects.toMatchObject({
      code: "EDITOR_WORKSPACE_PUBLICATION_FAILED",
    });
    expect(conflictHandle.close).toHaveBeenCalledTimes(1);
    expect(
      conflictCache.resolveImage(cachedReference({ width: 21 })),
    ).toMatchObject({
      handle: persistent,
    });

    const disposition = { dispose: vi.fn() };
    const invalidCache = {
      isDisposing: () => false,
      acquireStagedPng: () => ({
        status: "invalid" as const,
        candidateAccepted: false,
        candidateDisposition: disposition,
        lease: null,
      }),
      resolveImage: () => null,
    };
    expect(() =>
      workspacePublicationRuntime.publishStagedCanonicalReferenceBatch(
        { plan: stagingPlan(1), claim: () => [stagedPng({})] } as unknown,
        invalidCache,
      ),
    ).toThrow("EDITOR_WORKSPACE_PUBLICATION_FAILED");
    expect(disposition.dispose).toHaveBeenCalledTimes(1);

    const mismatchHandle = { close: vi.fn() };
    const resolvedCache = stagedCache();
    const mismatchedResolver = {
      isDisposing: resolvedCache.isDisposing.bind(resolvedCache),
      acquireStagedPng: resolvedCache.acquireStagedPng.bind(resolvedCache),
      resolveImage: () => ({ ...cachedReference(), handle: {} }),
    };
    expect(() =>
      workspacePublicationRuntime.publishStagedCanonicalReferenceBatch(
        {
          plan: stagingPlan(1),
          claim: () => [stagedPng(mismatchHandle)],
        } as unknown,
        mismatchedResolver,
      ),
    ).toThrow("EDITOR_WORKSPACE_PUBLICATION_FAILED");
    expect(mismatchHandle.close).toHaveBeenCalledTimes(1);
  });

  it("rolls back only invocation leases while cache authority disposes pending candidates", async () => {
    const crossSha = { close: vi.fn() };
    const redundant = { close: vi.fn() };
    const otherReference = cachedReference({ sha256: OTHER_SHA256 });
    const cache = stagedCache([{ ...otherReference, handle: crossSha }]);
    await cache.importPng({ mimeType: "image/png", bytes: PNG_BYTES });
    const resolverFailure = {
      isDisposing: cache.isDisposing.bind(cache),
      acquireStagedPng: cache.acquireStagedPng.bind(cache),
      resolveImage: () => null,
    };
    const batch = await staging.stageCanonicalReferencePlan(
      stagingPlan(2),
      stagingDependencies([crossSha, redundant]),
    );

    expect(() =>
      workspacePublicationRuntime.publishStagedCanonicalReferenceBatch(
        batch,
        resolverFailure,
      ),
    ).toThrow("EDITOR_WORKSPACE_PUBLICATION_FAILED");
    expect(redundant.close).toHaveBeenCalledTimes(1);
    expect(crossSha.close).not.toHaveBeenCalled();
    expect(cache.resolveImage(otherReference)).toMatchObject({
      handle: crossSha,
    });
  });

  it("closes a final cache-owned workspace handle after Function.call is poisoned", async () => {
    const handle = { close: vi.fn() };
    const cache = stagedCache();
    const workspace =
      workspacePublicationRuntime.publishStagedCanonicalReferenceBatch(
        await staging.stageCanonicalReferencePlan(
          stagingPlan(1),
          stagingDependencies([handle]),
        ),
        cache,
      );
    const originalCall = Function.prototype.call;

    try {
      Function.prototype.call = () => {
        throw new Error("private Function.call poison");
      };
      workspace.release();
      workspace.release();
    } finally {
      Function.prototype.call = originalCall;
    }

    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(cache.resolveImage(cachedReference())).toBeNull();
    await expect(
      staging.stageCanonicalReferencePlan(
        stagingPlan(1),
        stagingDependencies([handle]),
      ),
    ).rejects.toMatchObject({ code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED" });
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("publishes and releases a directly acquired lease when push is poisoned after module load", async () => {
    const handle = { close: vi.fn() };
    const cache = stagedCache();
    const batch = await staging.stageCanonicalReferencePlan(
      stagingPlan(1),
      stagingDependencies([handle]),
    );
    const originalPush = Array.prototype.push;

    try {
      let workspace: PublishedImageWorkspace;
      try {
        Array.prototype.push = () => {
          Array.prototype.push = originalPush;
          throw new Error("private publication push trap");
        };
        workspace =
          workspacePublicationRuntime.publishStagedCanonicalReferenceBatch(
            batch,
            cache,
          );
      } finally {
        Array.prototype.push = originalPush;
      }
      workspace.release();

      expect(workspace.images).toHaveLength(1);
      expect(handle.close).toHaveBeenCalledTimes(1);
      expect(cache.resolveImage(cachedReference())).toBeNull();
    } finally {
      Array.prototype.push = originalPush;
      cache.clear();
    }
  });

  it("rolls back direct and pending acquisitions when push is poisoned", async () => {
    let firstCloseCount = 0;
    let secondCloseCount = 0;
    const handles = [
      {
        close() {
          firstCloseCount += 1;
        },
      },
      {
        close() {
          secondCloseCount += 1;
        },
      },
    ];
    const cache = stagedCache();
    const batch = await staging.stageCanonicalReferencePlan(
      stagingPlan(2),
      stagingDependencies(handles),
    );
    const resolverFailure = {
      isDisposing: cache.isDisposing.bind(cache),
      acquireStagedPng: cache.acquireStagedPng.bind(cache),
      resolveImage: () => null,
    };
    const originalPush = Array.prototype.push;

    try {
      try {
        Array.prototype.push = () => {
          Array.prototype.push = originalPush;
          throw new Error("private publication push trap");
        };
        expect(() =>
          workspacePublicationRuntime.publishStagedCanonicalReferenceBatch(
            batch,
            resolverFailure,
          ),
        ).toThrow("EDITOR_WORKSPACE_PUBLICATION_FAILED");
      } finally {
        Array.prototype.push = originalPush;
      }

      expect(firstCloseCount).toBe(1);
      expect(secondCloseCount).toBe(1);
      expect(cache.resolveImage(cachedReference())).toBeNull();
      expect(
        cache.resolveImage(cachedReference({ sha256: OTHER_SHA256 })),
      ).toBeNull();
    } finally {
      Array.prototype.push = originalPush;
      cache.clear();
    }
  });

  it("publishes ordered images when map is poisoned after module load", async () => {
    const handles = [{ close: vi.fn() }, { close: vi.fn() }];
    const cache = stagedCache();
    const batch = await staging.stageCanonicalReferencePlan(
      stagingPlan(2),
      stagingDependencies(handles),
    );
    const originalMap = Array.prototype.map;

    try {
      let workspace: PublishedImageWorkspace;
      try {
        Array.prototype.map = () => {
          Array.prototype.map = originalMap;
          throw new Error("private publication map trap");
        };
        workspace =
          workspacePublicationRuntime.publishStagedCanonicalReferenceBatch(
            batch,
            cache,
          );
      } finally {
        Array.prototype.map = originalMap;
      }
      workspace.release();

      expect(workspace.images.map((image) => image.handle)).toEqual(handles);
      expect(handles[0]!.close).toHaveBeenCalledTimes(1);
      expect(handles[1]!.close).toHaveBeenCalledTimes(1);
    } finally {
      Array.prototype.map = originalMap;
      cache.clear();
    }
  });

  it("rejects reentrant same-cache publication before claim and leaves its batch retryable", async () => {
    const outerHandle = { close: vi.fn() };
    const nestedHandle = { close: vi.fn() };
    const cache = stagedCache();
    const nestedBatch = await staging.stageCanonicalReferencePlan(
      stagingPlan(1),
      stagingDependencies([nestedHandle]),
    );
    const privateDetail = "private nested claim";
    let nestedClaimCount = 0;
    let nestedFailure: unknown;
    const reentrantBatch = {
      plan: nestedBatch.plan,
      claim() {
        nestedClaimCount += 1;
        throw new Error(privateDetail);
      },
    };
    outerHandle.close.mockImplementation(() => {
      try {
        workspacePublicationRuntime.publishStagedCanonicalReferenceBatch(
          reentrantBatch,
          cache,
        );
      } catch (error) {
        nestedFailure = error;
      }
    });
    const outer =
      workspacePublicationRuntime.publishStagedCanonicalReferenceBatch(
        await staging.stageCanonicalReferencePlan(
          stagingPlan(1),
          stagingDependencies([outerHandle]),
        ),
        cache,
      );

    outer.release();

    expect(nestedClaimCount).toBe(0);
    expect(nestedFailure).toMatchObject({
      name: "WorkspacePublicationError",
      code: "EDITOR_WORKSPACE_PUBLICATION_FAILED",
      message: "EDITOR_WORKSPACE_PUBLICATION_FAILED",
    });
    expect(Object.isFrozen(nestedFailure)).toBe(true);
    expect(String(nestedFailure)).not.toContain(privateDetail);
    expect(outerHandle.close).toHaveBeenCalledTimes(1);
    expect(nestedHandle.close).not.toHaveBeenCalled();
    expect(cache.resolveImage(cachedReference())).toBeNull();

    const nested =
      workspacePublicationRuntime.publishStagedCanonicalReferenceBatch(
        nestedBatch,
        cache,
      );
    expect(nested.images[0]!.handle).toBe(nestedHandle);
    nested.release();
    nested.release();
    expect(nestedHandle.close).toHaveBeenCalledTimes(1);
    expect(cache.resolveImage(cachedReference())).toBeNull();
  });
});

type CoordinatedPrehydrationRuntime = {
  prehydrateCanonicalReferencePlan(
    plan: unknown,
    dependencies: unknown,
  ): Promise<PublishedImageWorkspace>;
};

const coordinatedPrehydration =
  recoveryHarness as unknown as CoordinatedPrehydrationRuntime;

function deferred(): { readonly promise: Promise<void>; release(): void } {
  let resolve: (() => void) | undefined;
  return {
    promise: new Promise<void>((next) => {
      resolve = next;
    }),
    release() {
      resolve?.();
    },
  };
}

function coordinatedDependencies(
  handle: unknown,
  events: string[],
  label: string,
  gate?: Promise<void>,
) {
  return {
    rereadVerifiedPng: vi.fn(async (sha256: string) => {
      events.push(`${label}:reread`);
      await gate;
      return asset({ sha256 });
    }),
    decodeVerifiedPng: vi.fn(async (verified: AssetRecord) => {
      events.push(`${label}:decode`);
      return { ...verified, width: 20, height: 10, handle };
    }),
  };
}

describe("coordinated canonical reference prehydration", () => {
  it("waits same-plan calls in invocation order and returns independent workspaces", async () => {
    const cache = stagedCache();
    const events: string[] = [];
    const firstGate = deferred();
    const first = coordinatedPrehydration.prehydrateCanonicalReferencePlan(
      stagingPlan(1),
      {
        cache,
        ...coordinatedDependencies(
          { close: vi.fn() },
          events,
          "first",
          firstGate.promise,
        ),
      },
    );
    await Promise.resolve();
    const second = coordinatedPrehydration.prehydrateCanonicalReferencePlan(
      stagingPlan(1),
      {
        cache,
        ...coordinatedDependencies({ close: vi.fn() }, events, "second"),
      },
    );
    await Promise.resolve();
    expect(events).toEqual(["first:reread"]);

    firstGate.release();
    const [firstWorkspace, secondWorkspace] = await Promise.all([
      first,
      second,
    ]);
    expect(events).toEqual([
      "first:reread",
      "first:decode",
      "second:reread",
      "second:decode",
    ]);
    expect(firstWorkspace).not.toBe(secondWorkspace);
    expect(firstWorkspace.images).not.toBe(secondWorkspace.images);
    expect(Object.isFrozen(firstWorkspace)).toBe(true);
    expect(Object.isFrozen(secondWorkspace)).toBe(true);
    firstWorkspace.release();
    secondWorkspace.release();
  });

  it("starts disjoint same-cache and same-SHA different-cache plans independently", async () => {
    const events: string[] = [];
    const gates = [deferred(), deferred(), deferred()];
    const planWithOtherSha = stagingPlan(1);
    planWithOtherSha.references[0]!.sha256 = OTHER_SHA256;
    const sharedCache = stagedCache();
    const operations = [
      coordinatedPrehydration.prehydrateCanonicalReferencePlan(stagingPlan(1), {
        cache: sharedCache,
        ...coordinatedDependencies(
          { close: vi.fn() },
          events,
          "same-cache-a",
          gates[0]!.promise,
        ),
      }),
      coordinatedPrehydration.prehydrateCanonicalReferencePlan(
        planWithOtherSha,
        {
          cache: sharedCache,
          ...coordinatedDependencies(
            { close: vi.fn() },
            events,
            "same-cache-b",
            gates[1]!.promise,
          ),
        },
      ),
      coordinatedPrehydration.prehydrateCanonicalReferencePlan(stagingPlan(1), {
        cache: stagedCache(),
        ...coordinatedDependencies(
          { close: vi.fn() },
          events,
          "other-cache",
          gates[2]!.promise,
        ),
      }),
    ];
    await Promise.resolve();
    expect(events).toEqual([
      "same-cache-a:reread",
      "same-cache-b:reread",
      "other-cache:reread",
    ]);

    gates.forEach((gate) => gate.release());
    for (const workspace of await Promise.all(operations)) workspace.release();
  });

  it("cleans successful reservations for repeats while an empty plan does not block keyed work", async () => {
    const cache = stagedCache();
    const events: string[] = [];
    const gate = deferred();
    const pending = coordinatedPrehydration.prehydrateCanonicalReferencePlan(
      stagingPlan(1),
      {
        cache,
        ...coordinatedDependencies(
          { close: vi.fn() },
          events,
          "first",
          gate.promise,
        ),
      },
    );
    await Promise.resolve();
    const empty =
      await coordinatedPrehydration.prehydrateCanonicalReferencePlan(
        stagingPlan(0),
        {
          cache,
          ...coordinatedDependencies({ close: vi.fn() }, events, "empty"),
        },
      );
    expect(empty.images).toEqual([]);
    expect(events).toEqual(["first:reread"]);

    gate.release();
    (await pending).release();
    const repeated =
      await coordinatedPrehydration.prehydrateCanonicalReferencePlan(
        stagingPlan(1),
        {
          cache,
          ...coordinatedDependencies({ close: vi.fn() }, events, "repeat"),
        },
      );
    expect(events).toContain("repeat:reread");
    repeated.release();
  });

  it("waits whole partially-overlapping invocations while disjoint work progresses", async () => {
    const cache = stagedCache();
    const events: string[] = [];
    const firstGate = deferred();
    const thirdSha = `sha256:${"a".repeat(64)}`;
    const disjointSha = `sha256:${"b".repeat(64)}`;
    const planFor = (...sha256: string[]) => {
      const plan = stagingPlan(sha256.length);
      sha256.forEach((value, index) => {
        plan.references[index]!.sha256 = value;
      });
      return plan;
    };
    const first = coordinatedPrehydration.prehydrateCanonicalReferencePlan(
      planFor(PNG_SHA256, OTHER_SHA256),
      {
        cache,
        ...coordinatedDependencies(1, events, "first", firstGate.promise),
      },
    );
    await Promise.resolve();
    const overlap = coordinatedPrehydration.prehydrateCanonicalReferencePlan(
      planFor(OTHER_SHA256, thirdSha),
      {
        cache,
        ...coordinatedDependencies(2, events, "overlap"),
      },
    );
    const disjoint = coordinatedPrehydration.prehydrateCanonicalReferencePlan(
      planFor(disjointSha),
      {
        cache,
        ...coordinatedDependencies(3, events, "disjoint"),
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toContain("disjoint:reread");
    expect(events).not.toContain("overlap:reread");

    firstGate.release();
    for (const workspace of await Promise.all([first, overlap, disjoint])) {
      workspace.release();
    }
    expect(events.indexOf("overlap:reread")).toBeGreaterThan(
      events.lastIndexOf("first:decode"),
    );
  });

  it("orders transitive overlaps and lets a queued retry stage after failure", async () => {
    const cache = stagedCache();
    const events: string[] = [];
    const firstGate = deferred();
    const planFor = (...sha256: string[]) => {
      const plan = stagingPlan(sha256.length);
      sha256.forEach((value, index) => {
        plan.references[index]!.sha256 = value;
      });
      return plan;
    };
    const first = coordinatedPrehydration.prehydrateCanonicalReferencePlan(
      planFor(PNG_SHA256),
      {
        cache,
        ...coordinatedDependencies(1, events, "first", firstGate.promise),
      },
    );
    const second = coordinatedPrehydration.prehydrateCanonicalReferencePlan(
      planFor(PNG_SHA256, OTHER_SHA256),
      {
        cache,
        ...coordinatedDependencies(2, events, "second"),
      },
    );
    const third = coordinatedPrehydration.prehydrateCanonicalReferencePlan(
      planFor(OTHER_SHA256),
      {
        cache,
        ...coordinatedDependencies(3, events, "third"),
      },
    );
    await Promise.resolve();
    expect(events).toEqual(["first:reread"]);
    firstGate.release();
    (await first).release();
    (await second).release();
    (await third).release();
    expect(events.filter((event) => event.endsWith(":reread"))).toEqual([
      "first:reread",
      "second:reread",
      "second:reread",
      "third:reread",
    ]);

    const retryEvents: string[] = [];
    const failed = coordinatedPrehydration.prehydrateCanonicalReferencePlan(
      stagingPlan(1),
      {
        cache,
        rereadVerifiedPng: async () => {
          retryEvents.push("failed:reread");
          throw new Error("private staging failure");
        },
        decodeVerifiedPng: async () => {
          throw new Error("unreachable");
        },
      },
    );
    await Promise.resolve();
    const retried = coordinatedPrehydration.prehydrateCanonicalReferencePlan(
      stagingPlan(1),
      {
        cache,
        ...coordinatedDependencies({ close: vi.fn() }, retryEvents, "retry"),
      },
    );
    await expect(failed).rejects.toMatchObject({
      code: "EDITOR_VERIFIED_ASSET_STAGING_FAILED",
    });
    const retriedWorkspace = await retried;
    retriedWorkspace.release();
    expect(retryEvents).toEqual([
      "failed:reread",
      "retry:reread",
      "retry:decode",
    ]);
  });

  it("releases an unclaimed batch after guarded publication fails and preserves prior workspaces", async () => {
    const cache = stagedCache();
    const stableHandle = { close: vi.fn() };
    const stable =
      workspacePublicationRuntime.publishStagedCanonicalReferenceBatch(
        await staging.stageCanonicalReferencePlan(
          stagingPlan(1),
          stagingDependencies([stableHandle]),
        ),
        cache,
      );
    let rejecting = true;
    const guardedCache = {
      isDisposing: () => rejecting,
      acquireStagedPng: cache.acquireStagedPng.bind(cache),
      resolveImage: cache.resolveImage.bind(cache),
    };
    const failedHandle = { close: vi.fn() };
    await expect(
      coordinatedPrehydration.prehydrateCanonicalReferencePlan(stagingPlan(1), {
        cache: guardedCache,
        ...coordinatedDependencies(failedHandle, [], "failed"),
      }),
    ).rejects.toMatchObject({ code: "EDITOR_WORKSPACE_PUBLICATION_FAILED" });
    expect(failedHandle.close).toHaveBeenCalledTimes(1);
    expect(stable.images[0]!.handle).toBe(stableHandle);
    expect(cache.resolveImage(cachedReference())).toMatchObject({
      handle: stableHandle,
    });

    rejecting = false;
    const retryHandle = { close: vi.fn() };
    const retried =
      await coordinatedPrehydration.prehydrateCanonicalReferencePlan(
        stagingPlan(1),
        {
          cache: guardedCache,
          ...coordinatedDependencies(retryHandle, [], "retry"),
        },
      );
    expect(retried.images[0]!.handle).toBe(stableHandle);
    expect(retryHandle.close).toHaveBeenCalledTimes(1);
    expect(stableHandle.close).not.toHaveBeenCalled();
    retried.release();
    stable.release();
    expect(stableHandle.close).toHaveBeenCalledTimes(1);
  });
});

type DurableDraftWorkspace = {
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
  readonly createdAt: number;
  readonly canonicalEditableJson: string;
  readonly plan: { readonly document: object };
  readonly images: readonly CachedPng[];
  readonly canonicalBytes: Uint8Array;
  readonly parentApprovalHash: string | null;
  readonly approvalInvalidationReason: string | null;
  release(): void;
};

type DurableDraftWorkspaceService = {
  readonly current: DurableDraftWorkspace | null;
  publish(editableJson: string): Promise<DurableDraftWorkspace>;
  reload(record: ValidatedDurableDraftRecord): Promise<DurableDraftWorkspace>;
  release(): void;
};

type DurableDraftPublicationRuntime = {
  createDurableDraftWorkspaceService(
    dependencies: unknown,
  ): DurableDraftWorkspaceService;
};

const durableDraftPublication =
  recoveryHarness as unknown as DurableDraftPublicationRuntime;

describe("deterministic durable draft publication", () => {
  it("awaits canonical-plan prehydration before one exact draft-only durable publication and exposes a frozen workspace", async () => {
    const events: string[] = [];
    const gate = deferred();
    const handle = { close: vi.fn() };
    const writeCompleteRevision = vi.fn(async () => {
      events.push("durable");
    });
    const service = durableDraftPublication.createDurableDraftWorkspaceService({
      documentId: "draft-document",
      revisionId: () => "draft-2",
      sequence: () => 2,
      createdAt: () => 1234,
      repository: {
        readPointers: async () => {
          events.push("pointers");
          return { saved: null, draft: null };
        },
        writeCompleteRevision,
      },
      prehydration: {
        cache: stagedCache(),
        rereadVerifiedPng: async (sha256: string) => {
          events.push("reread");
          await gate.promise;
          return asset({ sha256 });
        },
        decodeVerifiedPng: async (verified: AssetRecord) => {
          events.push("decode");
          return { ...verified, width: 20, height: 10, handle };
        },
      },
    });
    const editableJson = JSON.stringify(imageDocument([{ id: "image-a" }]));

    const pending = service.publish(editableJson);
    await Promise.resolve();

    expect(events).toEqual(["reread"]);
    expect(service.current).toBeNull();
    expect(writeCompleteRevision).not.toHaveBeenCalled();

    gate.release();
    const published = await pending;
    const [revision, pointers] = (
      writeCompleteRevision.mock.calls as unknown as [unknown, unknown][]
    )[0]!;

    expect(events).toEqual(["reread", "decode", "pointers", "durable"]);
    expect(revision).toMatchObject({
      documentId: "draft-document",
      revisionId: "draft-2",
      sequence: 2,
      canonicalBytes: canonicalizeSceneDocument.exportEditableJson(
        imageDocument([{ id: "image-a" }]),
      ),
    });
    expect(pointers).toEqual({
      saved: null,
      draft: {
        kind: "draft",
        documentId: "draft-document",
        revisionId: "draft-2",
        sequence: 2,
      },
    });
    expect(published).toMatchObject({
      documentId: "draft-document",
      revisionId: "draft-2",
      sequence: 2,
      createdAt: 1234,
      images: [{ handle }],
    });
    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.isFrozen(published.plan)).toBe(true);
    expect(Object.isFrozen(published.images)).toBe(true);
    expect(() => {
      (published as { revisionId: string }).revisionId = "changed";
    }).toThrow(TypeError);
    expect(service.current).not.toBe(published);
    expect(service.current).toMatchObject({ revisionId: "draft-2" });

    published.release();
    published.release();
    service.release();
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(service.current).toBeNull();
  });

  it("preserves a saved pointer while publishing only the new complete draft revision", async () => {
    const saved = {
      kind: "saved" as const,
      documentId: "draft-document",
      revisionId: "saved-1",
      sequence: 1,
    };
    const writeCompleteRevision = vi.fn(async () => undefined);
    const service = durableDraftPublication.createDurableDraftWorkspaceService({
      documentId: "draft-document",
      revisionId: () => "draft-2",
      sequence: () => 2,
      createdAt: () => 5678,
      repository: {
        readPointers: async () => ({ saved, draft: null }),
        writeCompleteRevision,
      },
      prehydration: {
        cache: stagedCache(),
        ...coordinatedDependencies({ close: vi.fn() }, [], "draft"),
      },
    });

    const published = await service.publish(
      JSON.stringify(FIRST_SLICE_DOCUMENT),
    );
    const [, pointers] = (
      writeCompleteRevision.mock.calls as unknown as [unknown, unknown][]
    )[0]!;
    const leakedBytes = published.canonicalBytes;
    leakedBytes[0] = 0;

    expect(pointers).toEqual({
      saved,
      draft: {
        kind: "draft",
        documentId: "draft-document",
        revisionId: "draft-2",
        sequence: 2,
      },
    });
    expect(published.canonicalBytes).toEqual(
      canonicalizeSceneDocument.exportEditableJson(FIRST_SLICE_DOCUMENT),
    );
  });
});

it("keeps the successor usable when prior cleanup poisons Array.prototype.map", async () => {
  const originalMap = Array.prototype.map;
  const priorClose = vi.fn(() => {
    Array.prototype.map = function (this: unknown[], ...args: unknown[]) {
      if ((this[0] as CachedPng)?.handle === "next") throw Error();
      return Reflect.apply(originalMap, this, args);
    } as typeof Array.prototype.map;
  });
  let revisionId = "draft-1";
  const service = durableDraftPublication.createDurableDraftWorkspaceService({
    documentId: "draft-document",
    revisionId: () => revisionId,
    sequence: () => 1,
    createdAt: () => 1,
    repository: {
      readPointers: async () => ({ saved: null, draft: null }),
      writeCompleteRevision: async () => undefined,
    },
    prehydration: {
      cache: stagedCache(),
      rereadVerifiedPng: async (sha256: string) => asset({ sha256 }),
      decodeVerifiedPng: async (verified: AssetRecord) => ({
        ...verified,
        width: 20,
        height: 10,
        handle: revisionId === "draft-1" ? { close: priorClose } : "next",
      }),
    },
  });
  try {
    await service.publish(JSON.stringify(imageDocument([{ id: "image-a" }])));
    revisionId = "draft-2";
    const successor = await service.publish(
      JSON.stringify(imageDocument([{ id: "image-b", sha256: OTHER_SHA256 }])),
    );
    expect(Object.isFrozen(successor.images)).toBe(true);
    expect(Object.isFrozen(service.current!.images)).toBe(true);
    expect(priorClose).toHaveBeenCalledTimes(1);
  } finally {
    Array.prototype.map = originalMap;
  }
});
it.each(["plan", "prehydrate", "identity", "pointers", "durable"] as const)(
  "preserves the current workspace and releases only failed %s publication ownership",
  async (failure) => {
    let revisionId = "draft-1";
    let sequence = 1;
    let nextHandle: { close: ReturnType<typeof vi.fn> } | undefined;
    const handles: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const service = durableDraftPublication.createDurableDraftWorkspaceService({
      documentId: "draft-document",
      revisionId: () => revisionId,
      sequence: () => sequence,
      createdAt: () => 1234,
      repository: {
        readPointers: async () => {
          if (failure === "pointers" && revisionId === "draft-2") {
            throw new Error("private pointer failure");
          }
          return { saved: null, draft: null };
        },
        writeCompleteRevision: async () => {
          if (failure === "durable" && revisionId === "draft-2") {
            throw new Error("private durable failure");
          }
        },
      },
      prehydration: {
        cache: stagedCache(),
        rereadVerifiedPng: async (sha256: string) => asset({ sha256 }),
        decodeVerifiedPng: async (verified: AssetRecord) => {
          if (failure === "prehydrate" && revisionId === "draft-2") {
            throw new Error("private prehydrate failure");
          }
          nextHandle = { close: vi.fn() };
          handles.push(nextHandle);
          return { ...verified, width: 20, height: 10, handle: nextHandle };
        },
      },
    });
    const editableJson = JSON.stringify(imageDocument([{ id: "image-a" }]));
    const first = await service.publish(editableJson);
    const firstHandle = handles[0]!;
    revisionId = failure === "identity" ? "not an id!" : "draft-2";
    sequence = failure === "identity" ? Number.NaN : 2;
    nextHandle = undefined;

    const replacement = service.publish(
      failure === "plan" ? "not JSON" : editableJson,
    );
    if (failure === "plan") {
      await expect(replacement).rejects.toMatchObject({
        message: "SCENE_DOCUMENT_IMPORT_INVALID_JSON",
      });
    } else {
      await expect(replacement).rejects.toMatchObject({
        name: "DurableDraftWorkspaceError",
        code: "EDITOR_DURABLE_DRAFT_PUBLICATION_FAILED",
        message: "EDITOR_DURABLE_DRAFT_PUBLICATION_FAILED",
      });
    }

    expect(service.current).toMatchObject({ revisionId: "draft-1" });
    expect(firstHandle.close).not.toHaveBeenCalled();
    if (failure === "prehydrate" || failure === "plan") {
      expect(nextHandle).toBeUndefined();
    } else {
      expect(handles.at(-1)?.close).toHaveBeenCalledTimes(1);
    }
    first.release();
    expect(firstHandle.close).toHaveBeenCalledTimes(1);
  },
);

it("replaces after durable exposure, accepts deterministic repeats, and isolates stale snapshots", async () => {
  const events: string[] = [];
  const durable = deferred();
  let revisionId = "draft-1";
  let sequence = 1;
  const handles: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  const service = durableDraftPublication.createDurableDraftWorkspaceService({
    documentId: "draft-document",
    revisionId: () => revisionId,
    sequence: () => sequence,
    createdAt: () => 1234,
    repository: {
      readPointers: async () => ({ saved: null, draft: null }),
      writeCompleteRevision: async () => {
        events.push(`durable:${revisionId}`);
        if (revisionId === "draft-2") await durable.promise;
      },
    },
    prehydration: {
      cache: stagedCache(),
      rereadVerifiedPng: async (sha256: string) => asset({ sha256 }),
      decodeVerifiedPng: async (verified: AssetRecord) => {
        const handle = { close: vi.fn() };
        handles.push(handle);
        return { ...verified, width: 20, height: 10, handle };
      },
    },
  });
  const firstJson = JSON.stringify(imageDocument([{ id: "image-a" }]));
  const replacementJson = JSON.stringify(
    imageDocument([{ id: "image-b", sha256: OTHER_SHA256 }]),
  );
  const first = await service.publish(firstJson);
  revisionId = "draft-2";
  sequence = 2;
  const replacement = service.publish(replacementJson);
  await vi.waitFor(() => {
    expect(events).toEqual(["durable:draft-1", "durable:draft-2"]);
  });
  expect(handles[0]!.close).not.toHaveBeenCalled();
  expect(service.current).toMatchObject({ revisionId: "draft-1" });
  durable.release();
  const second = await replacement;
  expect(service.current).toMatchObject({ revisionId: "draft-2" });
  expect(handles[0]!.close).toHaveBeenCalledTimes(1);

  first.release();
  expect(service.current).toMatchObject({ revisionId: "draft-2" });
  expect(handles[1]!.close).not.toHaveBeenCalled();
  const repeated = await service.publish(replacementJson);
  expect(repeated).toMatchObject({ revisionId: "draft-2", sequence: 2 });
  expect(service.current).toMatchObject({ revisionId: "draft-2", sequence: 2 });
  second.release();
  expect(service.current).toMatchObject({ revisionId: "draft-2" });
  service.release();
  service.release();
  expect(handles[1]!.close).toHaveBeenCalledTimes(1);
});

it.each([
  ["revision ID", "revisionId", "private revision ID"],
  ["sequence", "sequence", "private sequence"],
  ["creation time", "createdAt", "private creation time"],
] as const)(
  "freezes a non-leaking publication failure for hostile %s input",
  async (_label, field, privateDetail) => {
    const handle = { close: vi.fn() };
    const hostile = () => {
      throw new Error(privateDetail);
    };
    const service = durableDraftPublication.createDurableDraftWorkspaceService({
      documentId: "draft-document",
      revisionId: () => (field === "revisionId" ? hostile() : "draft-1"),
      sequence: () => (field === "sequence" ? hostile() : 1),
      createdAt: () => (field === "createdAt" ? hostile() : 1),
      repository: {
        readPointers: async () => ({ saved: null, draft: null }),
        writeCompleteRevision: async () => undefined,
      },
      prehydration: {
        cache: stagedCache(),
        rereadVerifiedPng: async (sha256: string) => asset({ sha256 }),
        decodeVerifiedPng: async (verified: AssetRecord) => ({
          ...verified,
          width: 20,
          height: 10,
          handle,
        }),
      },
    });
    let failure: unknown;
    try {
      await service.publish(JSON.stringify(imageDocument([{ id: "image-a" }])));
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: "DurableDraftWorkspaceError",
      code: "EDITOR_DURABLE_DRAFT_PUBLICATION_FAILED",
      message: "EDITOR_DURABLE_DRAFT_PUBLICATION_FAILED",
    });
    expect(Object.isFrozen(failure)).toBe(true);
    expect(String(failure)).not.toContain("private");
    expect(handle.close).toHaveBeenCalledTimes(1);
  },
);

describe("editor import workflow surface", () => {
  function deferred<Value>() {
    let resolve: ((value: Value) => void) | undefined;
    let reject: ((reason?: unknown) => void) | undefined;
    const promise = new Promise<Value>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    return { promise, resolve: resolve!, reject: reject! };
  }

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("exposes labelled keyboard controls and commits a resolved renderable view only after image import succeeds", async () => {
    const completion = deferred<{ readonly label: string }>();
    const workflow = vi.fn(() => completion.promise);
    render(<App workflow={workflow} />);

    const image = screen.getByLabelText("Image to import");
    const json = screen.getByLabelText("Editable JSON");
    const imageButton = screen.getByRole("button", {
      name: "Import image",
    });
    const jsonButton = screen.getByRole("button", {
      name: "Import editable JSON",
    });
    expect((image as HTMLInputElement).type).toBe("file");
    expect((json as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByRole("status").textContent).toBe(
      "Ready to import an image or editable JSON.",
    );
    expect(screen.getByTestId("workflow-rendered-view").textContent).toBe(
      "Foundation preview",
    );

    fireEvent.change(image, {
      target: {
        files: [new File(["png"], "scene.png", { type: "image/png" })],
      },
    });
    imageButton.focus();
    fireEvent.keyDown(imageButton, { key: "Enter" });

    expect(workflow).toHaveBeenCalledWith({
      kind: "image-import",
      file: expect.objectContaining({ name: "scene.png", type: "image/png" }),
    });
    expect(screen.getByRole("status").textContent).toBe("Importing image…");
    expect((imageButton as HTMLButtonElement).disabled).toBe(true);
    expect((jsonButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("workflow-rendered-view").textContent).toBe(
      "Foundation preview",
    );

    let labelReads = 0;
    await act(async () =>
      completion.resolve({
        get label() {
          labelReads += 1;
          return labelReads === 1 ? "Imported scene" : "Stale scene";
        },
      }),
    );

    expect(screen.getByRole("status").textContent).toBe("Image imported.");
    expect(screen.getByTestId("workflow-rendered-view").textContent).toBe(
      "Imported scene",
    );
  });

  it("keeps the preceding renderable view after a workflow failure and reports a stable alert", async () => {
    const workflow = vi
      .fn()
      .mockResolvedValueOnce({ label: "Editable draft" })
      .mockRejectedValueOnce(new Error("private storage detail"));
    render(<App workflow={workflow} />);

    fireEvent.change(screen.getByLabelText("Editable JSON"), {
      target: { value: '{"schemaVersion":1}' },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Import editable JSON" }),
    );
    await act(async () => undefined);
    expect(screen.getByTestId("workflow-rendered-view").textContent).toBe(
      "Editable draft",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Import editable JSON" }),
    );
    await act(async () => undefined);

    expect(screen.getByRole("alert").textContent).toBe(
      "Unable to import editable JSON.",
    );
    expect(screen.getByTestId("workflow-rendered-view").textContent).toBe(
      "Editable draft",
    );
    expect(screen.queryByText("private storage detail")).toBeNull();
  });

  it.each([undefined, Promise.resolve(4), Promise.resolve({ label: 4 })])(
    "contains malformed result %# without replacing the view",
    async (result) => {
      const workflow = vi
        .fn()
        .mockResolvedValueOnce({ label: "Editable draft" })
        .mockImplementationOnce(() => result as never);
      render(<App workflow={workflow} />);
      const action = screen.getByRole("button", {
        name: "Import editable JSON",
      });
      fireEvent.click(action);
      await act(async () => undefined);
      fireEvent.click(action);
      await act(async () => undefined);

      expect(screen.getByRole("alert").textContent).toBe(
        "Unable to import editable JSON.",
      );
      expect(screen.getByTestId("workflow-rendered-view").textContent).toBe(
        "Editable draft",
      );
      expect((action as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByText("TypeError")).toBeNull();
    },
  );

  it("accepts only one overlapping action while pending and retains the JSON request value", async () => {
    const completion = deferred<{ readonly label: string }>();
    const workflow = vi.fn(() => completion.promise);
    render(<App workflow={workflow} />);

    fireEvent.change(screen.getByLabelText("Editable JSON"), {
      target: { value: '{"schemaVersion":1,"id":"draft"}' },
    });
    const jsonButton = screen.getByRole("button", {
      name: "Import editable JSON",
    });
    fireEvent.click(jsonButton);
    fireEvent.click(screen.getByRole("button", { name: "Import image" }));
    expect(screen.getByRole("status").textContent).toBe(
      "Importing editable JSON…",
    );
    fireEvent.click(jsonButton);

    expect(workflow).toHaveBeenCalledTimes(1);
    expect(workflow).toHaveBeenCalledWith({
      kind: "editable-json-import",
      editableJson: '{"schemaVersion":1,"id":"draft"}',
    });
    expect(screen.getByRole("status").textContent).toBe(
      "Importing editable JSON…",
    );

    await act(async () => completion.resolve({ label: "JSON draft" }));
    expect(screen.getByRole("status").textContent).toBe(
      "Editable JSON imported.",
    );
  });
});

describe("editor foundation shell", () => {
  it("renders the infrastructure boundary and acknowledges its scope intent", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Editor foundation" }),
    ).toBeTruthy();
    expect(screen.getByText("Foundation shell is ready.")).toBeTruthy();
    expect(window.indexedDB).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: "Review foundation scope" }),
    );

    expect(
      screen.getByText(
        "Editor authoring will begin after the deterministic core is available.",
      ),
    ).toBeTruthy();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders authoritative transport snapshots for seek, playback, and pause", () => {
    const frames: FrameRequestCallback[] = [];
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    const { unmount } = render(<App />);

    expect(screen.getByTestId("transport-playhead-us").textContent).toBe("0");
    expect(screen.getByTestId("transport-status").textContent).toBe("paused");
    expect(screen.getByTestId("transport-loop").textContent).toBe("enabled");

    fireEvent.change(
      screen.getByRole("slider", { name: "Timeline position" }),
      {
        target: { value: "750000" },
      },
    );
    expect(screen.getByTestId("transport-playhead-us").textContent).toBe(
      "750000",
    );
    expect(screen.getByTestId("preview-opacity").textContent).toBe("0.6875");

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(screen.getByTestId("transport-status").textContent).toBe("playing");
    expect(frames).toHaveLength(1);

    act(() => frames[0]!(100));
    act(() => frames[1]!(125.9));
    expect(screen.getByTestId("transport-playhead-us").textContent).toBe(
      "775900",
    );

    act(() => frames[2]!(120));
    expect(screen.getByTestId("transport-playhead-us").textContent).toBe(
      "775900",
    );

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByTestId("transport-status").textContent).toBe("paused");
    expect(cancelAnimationFrame).toHaveBeenCalledWith(4);

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(frames).toHaveLength(5);
    unmount();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(5);
  });
});

type ResolvedDurableDraftPointer = {
  readonly kind: "draft";
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
};

type DurableDraftPointerResolverRuntime = {
  resolveDurableDraftPointer(
    dependencies: unknown,
  ): Promise<ResolvedDurableDraftPointer>;
};

const durableDraftPointerResolver =
  recoveryHarness as unknown as DurableDraftPointerResolverRuntime;

function durablePointerRepository(
  readPointers: (documentId: string) => Promise<unknown>,
) {
  return {
    readPointers: vi.fn(readPointers),
    readRevision: vi.fn(),
    writeCompleteRevision: vi.fn(),
  };
}

async function expectStableDraftReloadFailure(operation: Promise<unknown>) {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    name: "DurableDraftReloadError",
    code: "EDITOR_DURABLE_DRAFT_RELOAD_FAILED",
    message: "EDITOR_DURABLE_DRAFT_RELOAD_FAILED",
  });
  expect(Object.isFrozen(failure)).toBe(true);
  return failure;
}

describe("durable draft pointer resolution", () => {
  it("snapshots one exact draft pointer before source mutation without observing saved or revision operations", async () => {
    const events: string[] = [];
    const observations = new Map<string, number>();
    const observe =
      <Value,>(name: string, value: Value) =>
      () => {
        observations.set(name, (observations.get(name) ?? 0) + 1);
        events.push(name);
        return value;
      };
    let sourceRevisionId = "revision-2";
    const pointer = Object.defineProperties(
      {},
      {
        kind: { get: observe("kind", "draft") },
        documentId: { get: observe("pointer-document", "document-1") },
        revisionId: {
          get() {
            observations.set(
              "revision",
              (observations.get("revision") ?? 0) + 1,
            );
            events.push("revision");
            return sourceRevisionId;
          },
        },
        sequence: { get: observe("sequence", 2) },
      },
    );
    const snapshot = Object.defineProperties(
      {},
      {
        draft: { get: observe("draft", pointer) },
        saved: {
          get() {
            throw new Error("saved must remain unread");
          },
        },
      },
    );
    const repository = durablePointerRepository(async function (
      this: unknown,
      documentId,
    ) {
      events.push(`read:${documentId}:${this === repository}`);
      return snapshot;
    });
    const dependencies = Object.defineProperties(
      {},
      {
        documentId: { get: observe("configured-document", "document-1") },
        repository: { get: observe("repository", repository) },
      },
    );
    Object.defineProperty(repository, "readPointers", {
      get: observe("readPointers", repository.readPointers),
    });

    const resolved =
      await durableDraftPointerResolver.resolveDurableDraftPointer(
        dependencies,
      );
    sourceRevisionId = "changed";

    expect(resolved).toEqual({
      kind: "draft",
      documentId: "document-1",
      revisionId: "revision-2",
      sequence: 2,
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.getPrototypeOf(resolved)).toBe(Object.prototype);
    expect(events).toEqual([
      "configured-document",
      "repository",
      "readPointers",
      "read:document-1:true",
      "draft",
      "kind",
      "pointer-document",
      "revision",
      "sequence",
    ]);
    expect([...observations.values()]).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(repository.readRevision).not.toHaveBeenCalled();
    expect(repository.writeCompleteRevision).not.toHaveBeenCalled();
  });

  it.each([
    ["missing pointer", undefined],
    ["null pointer", null],
    [
      "saved pointer",
      {
        kind: "saved",
        documentId: "document-1",
        revisionId: "revision-2",
        sequence: 2,
      },
    ],
    [
      "foreign document",
      {
        kind: "draft",
        documentId: "other",
        revisionId: "revision-2",
        sequence: 2,
      },
    ],
    [
      "empty revision",
      { kind: "draft", documentId: "document-1", revisionId: " ", sequence: 2 },
    ],
    [
      "negative sequence",
      {
        kind: "draft",
        documentId: "document-1",
        revisionId: "revision-2",
        sequence: -1,
      },
    ],
    [
      "fractional sequence",
      {
        kind: "draft",
        documentId: "document-1",
        revisionId: "revision-2",
        sequence: 1.5,
      },
    ],
    [
      "overflow sequence",
      {
        kind: "draft",
        documentId: "document-1",
        revisionId: "revision-2",
        sequence: Number.MAX_SAFE_INTEGER + 1,
      },
    ],
  ])(
    "rejects %s without revision or write operations",
    async (_label, draft) => {
      const repository = durablePointerRepository(async () => ({ draft }));
      await expectStableDraftReloadFailure(
        durableDraftPointerResolver.resolveDurableDraftPointer({
          documentId: "document-1",
          repository,
        }),
      );
      expect(repository.readRevision).not.toHaveBeenCalled();
      expect(repository.writeCompleteRevision).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "unsafe configured ID",
      {
        documentId: " ",
        repository: durablePointerRepository(async () => ({ draft: null })),
      },
    ],
    [
      "pointer draft getter",
      {
        documentId: "document-1",
        repository: durablePointerRepository(async () =>
          Object.defineProperty({}, "draft", {
            get() {
              throw new Error("private draft");
            },
          }),
        ),
      },
    ],
    [
      "pointer field getter",
      {
        documentId: "document-1",
        repository: durablePointerRepository(async () => ({
          draft: Object.defineProperty({}, "kind", {
            get() {
              throw new Error("private pointer");
            },
          }),
        })),
      },
    ],
    [
      "repository getter",
      Object.defineProperty({ documentId: "document-1" }, "repository", {
        get() {
          throw new Error("private repository");
        },
      }),
    ],
    [
      "readPointers getter",
      {
        documentId: "document-1",
        repository: Object.defineProperty({}, "readPointers", {
          get() {
            throw new Error("private callable");
          },
        }),
      },
    ],
    [
      "non-callable readPointers",
      { documentId: "document-1", repository: { readPointers: null } },
    ],
    [
      "non-callable readRevision",
      {
        documentId: "document-1",
        repository: {
          readPointers: async () => ({ draft: null }),
          readRevision: null,
        },
      },
    ],
    [
      "readPointers rejection",
      {
        documentId: "document-1",
        repository: durablePointerRepository(async () =>
          Promise.reject(new Error("private read")),
        ),
      },
    ],
  ])(
    "normalizes hostile %s without leaking details",
    async (_label, dependencies) => {
      const first = await expectStableDraftReloadFailure(
        durableDraftPointerResolver.resolveDurableDraftPointer(dependencies),
      );
      const second = await expectStableDraftReloadFailure(
        durableDraftPointerResolver.resolveDurableDraftPointer(dependencies),
      );
      expect(first).not.toBe(second);
      expect(String(first)).not.toContain("private");
    },
  );
});

type DurableDraftRevisionEnvelope = {
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
  readonly canonicalization: {
    readonly identifier: "jcs-1";
    readonly byteLength: number;
  };
  readonly document: object;
  readonly canonicalBytes: Uint8Array;
};

type DurableDraftRevisionEnvelopeRuntime =
  DurableDraftPointerResolverRuntime & {
    readDurableDraftRevisionEnvelope(
      pointer: ResolvedDurableDraftPointer,
    ): Promise<DurableDraftRevisionEnvelope>;
  };

const durableDraftRevisionEnvelope =
  recoveryHarness as unknown as DurableDraftRevisionEnvelopeRuntime;
const readRevisionEnvelope = (pointer: ResolvedDurableDraftPointer) =>
  durableDraftRevisionEnvelope.readDurableDraftRevisionEnvelope(pointer);
const DURABLE_DRAFT_POINTER = Object.freeze({
  kind: "draft" as const,
  documentId: "document-1",
  revisionId: "revision-2",
  sequence: 2,
});

describe("durable draft revision envelope validation", () => {
  it("reads one bound revision and returns frozen isolated structural content", async () => {
    const sourceDocument = structuredClone(FIRST_SLICE_DOCUMENT);
    const sourceBytes = new Uint8Array([1, 2, 3]);
    const repository = durablePointerRepository(async () => ({
      draft: DURABLE_DRAFT_POINTER,
    }));
    repository.readRevision = vi.fn(async () =>
      completeDraftRevision({
        document: sourceDocument,
        canonicalBytes: sourceBytes,
      }),
    );

    const pointer =
      await durableDraftRevisionEnvelope.resolveDurableDraftPointer({
        documentId: "document-1",
        repository,
      });
    const envelope = await readRevisionEnvelope(pointer);
    sourceBytes[0] = 9;
    (sourceDocument.elements[0] as { id: string }).id = "mutated";

    expect(repository.readRevision).toHaveBeenCalledTimes(1);
    expect(repository.readRevision).toHaveBeenCalledWith(
      "document-1",
      "revision-2",
    );
    expect(repository.writeCompleteRevision).not.toHaveBeenCalled();

    expect(envelope).toMatchObject({
      documentId: "document-1",
      revisionId: "revision-2",
      sequence: 2,
      canonicalization: { identifier: "jcs-1", byteLength: 3 },
      document: FIRST_SLICE_DOCUMENT,
      canonicalBytes: new Uint8Array([1, 2, 3]),
    });
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.document)).toBe(true);
    const leaked = envelope.canonicalBytes;
    leaked[1] = 8;
    expect(envelope.canonicalBytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  function completeDraftRevision(overrides: Record<string, unknown> = {}) {
    return {
      documentId: "document-1",
      revisionId: "revision-2",
      sequence: 2,
      document: structuredClone(FIRST_SLICE_DOCUMENT),
      canonicalization: { identifier: "jcs-1", byteLength: 3 },
      canonicalBytes: new Uint8Array([1, 2, 3]),
      ...overrides,
    };
  }

  async function resolvedPointerForRevision(revision: unknown) {
    const repository = durablePointerRepository(async () => ({
      draft: DURABLE_DRAFT_POINTER,
    }));

    repository.readRevision = vi.fn(async () => revision);
    const pointer =
      await durableDraftRevisionEnvelope.resolveDurableDraftPointer({
        documentId: "document-1",
        repository,
      });
    return { pointer, repository };
  }

  it("rejects forged pointers before reading a repository", async () => {
    const { repository } = await resolvedPointerForRevision(
      completeDraftRevision(),
    );

    await expectStableDraftReloadFailure(
      readRevisionEnvelope({ ...DURABLE_DRAFT_POINTER }),
    );

    expect(repository.readRevision).not.toHaveBeenCalled();
    expect(repository.writeCompleteRevision).not.toHaveBeenCalled();
  });

  it("reads genuine pointers despite post-load WeakMap poison", async () => {
    const repository = durablePointerRepository(async () => ({
      draft: DURABLE_DRAFT_POINTER,
    }));
    repository.readRevision = vi.fn(async () => completeDraftRevision());
    const originalGet = WeakMap.prototype.get;
    const originalSet = WeakMap.prototype.set;
    let envelope!: DurableDraftRevisionEnvelope;
    try {
      WeakMap.prototype.get = () => {
        throw new Error("poison");
      };
      WeakMap.prototype.set = () => {
        throw new Error("poison");
      };
      const pointer =
        await durableDraftRevisionEnvelope.resolveDurableDraftPointer({
          documentId: "document-1",
          repository,
        });
      envelope = await readRevisionEnvelope(pointer);
    } finally {
      WeakMap.prototype.get = originalGet;
      WeakMap.prototype.set = originalSet;
    }
    expect(envelope.revisionId).toBe("revision-2");
    expect(repository.readRevision).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing", null],
    ["foreign document", completeDraftRevision({ documentId: "other" })],
    ["mismatched revision", completeDraftRevision({ revisionId: "other" })],
    ["mismatched sequence", completeDraftRevision({ sequence: 3 })],
    ["missing document", completeDraftRevision({ document: undefined })],
    [
      "canonicalization identifier",
      completeDraftRevision({
        canonicalization: { identifier: "other", byteLength: 3 },
      }),
    ],
    [
      "canonical byte length",
      completeDraftRevision({
        canonicalization: { identifier: "jcs-1", byteLength: 2 },
      }),
    ],
    [
      "forged bytes",
      completeDraftRevision({
        canonicalBytes: Object.create(Uint8Array.prototype),
      }),
    ],
  ])(
    "rejects %s revision content after exactly one read",
    async (_label, revision) => {
      const { pointer, repository } =
        await resolvedPointerForRevision(revision);

      await expectStableDraftReloadFailure(
        durableDraftRevisionEnvelope.readDurableDraftRevisionEnvelope(pointer),
      );

      expect(repository.readRevision).toHaveBeenCalledTimes(1);
      expect(repository.writeCompleteRevision).not.toHaveBeenCalled();
    },
  );

  it("rejects hostile or uncloneable revision content without leaking it", async () => {
    const privateDetail = "private revision trap";
    const hostile = Object.defineProperty(
      completeDraftRevision(),
      "documentId",
      {
        get() {
          throw new Error(privateDetail);
        },
      },
    );
    const { pointer, repository } = await resolvedPointerForRevision(hostile);

    const first = await expectStableDraftReloadFailure(
      durableDraftRevisionEnvelope.readDurableDraftRevisionEnvelope(pointer),
    );
    expect(String(first)).not.toContain(privateDetail);
    expect(repository.readRevision).toHaveBeenCalledTimes(1);

    const uncloneable = await resolvedPointerForRevision(
      completeDraftRevision({ document: { value: () => undefined } }),
    );
    await expectStableDraftReloadFailure(
      readRevisionEnvelope(uncloneable.pointer),
    );
    expect(uncloneable.repository.readRevision).toHaveBeenCalledTimes(1);
  });

  it("reads each hostile revision field once and normalizes repository failures", async () => {
    const counts = new Map<string, number>();
    const observe =
      <Value,>(name: string, value: Value) =>
      () => {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        return value;
      };
    const canonicalization = Object.defineProperties(
      {},
      {
        identifier: { get: observe("identifier", "jcs-1") },
        byteLength: { get: observe("byteLength", 3) },
      },
    );
    const revision = Object.defineProperties(
      {},
      Object.fromEntries(
        Object.entries(completeDraftRevision({ canonicalization })).map(
          ([name, value]) => [name, { get: observe(name, value) }],
        ),
      ),
    );
    const { pointer } = await resolvedPointerForRevision(revision);
    await expect(
      durableDraftRevisionEnvelope.readDurableDraftRevisionEnvelope(pointer),
    ).resolves.toMatchObject({ revisionId: "revision-2" });
    expect([...counts.values()]).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);

    const rejected = await resolvedPointerForRevision(completeDraftRevision());
    rejected.repository.readRevision.mockRejectedValueOnce(
      new Error("private repository failure"),
    );
    const failure = await expectStableDraftReloadFailure(
      readRevisionEnvelope(rejected.pointer),
    );
    expect(String(failure)).not.toContain("private repository failure");
  });
});

type ValidatedDurableDraftRecord = {
  readonly revision: DurableDraftRevisionEnvelope;
  readonly plan: {
    readonly document: object;
    readonly canonicalEditableJson: string;
    readonly references: readonly PlannedImageReference[];
  };
};

type DurableDraftContentParityRuntime = DurableDraftRevisionEnvelopeRuntime & {
  validateDurableDraftCanonicalContent(
    envelope: DurableDraftRevisionEnvelope,
  ): ValidatedDurableDraftRecord;
};

const durableDraftContentParity =
  recoveryHarness as unknown as DurableDraftContentParityRuntime;

function canonicalDraftRevision(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const document = structuredClone(FIRST_SLICE_DOCUMENT);
  const canonicalBytes = canonicalizeSceneDocument.exportEditableJson(document);
  return {
    documentId: "document-1",
    revisionId: "revision-2",
    sequence: 2,
    document,
    canonicalization: {
      identifier: "jcs-1",
      byteLength: canonicalBytes.byteLength,
    },
    canonicalBytes,
    ...overrides,
  };
}

async function genuineRevisionEnvelope(revision = canonicalDraftRevision()) {
  const repository = durablePointerRepository(async () => ({
    draft: DURABLE_DRAFT_POINTER,
  }));
  repository.readRevision = vi.fn(async () => revision);
  const pointer = await durableDraftRevisionEnvelope.resolveDurableDraftPointer(
    {
      documentId: "document-1",
      repository,
    },
  );
  const envelope = await readRevisionEnvelope(pointer);
  return { envelope, repository };
}

describe("canonical durable draft content parity", () => {
  it("returns frozen isolated canonical plan and independently rebuilt revision without repository work", async () => {
    const { envelope, repository } = await genuineRevisionEnvelope();
    const readsBefore = repository.readRevision.mock.calls.length;
    const validated =
      durableDraftContentParity.validateDurableDraftCanonicalContent(envelope);

    expect(validated).toMatchObject({
      revision: {
        documentId: "document-1",
        revisionId: "revision-2",
        sequence: 2,
        document: FIRST_SLICE_DOCUMENT,
      },
      plan: {
        document: FIRST_SLICE_DOCUMENT,
        canonicalEditableJson: new TextDecoder().decode(
          canonicalizeSceneDocument.exportEditableJson(FIRST_SLICE_DOCUMENT),
        ),
        references: [],
      },
    });
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.revision)).toBe(true);
    expect(Object.isFrozen(validated.plan)).toBe(true);
    const copiedBytes = validated.revision.canonicalBytes;
    copiedBytes[0] = 0;
    expect(Array.from(validated.revision.canonicalBytes)).toEqual(
      Array.from(envelope.canonicalBytes),
    );
    expect(() => {
      (validated.plan.document as { durationUs: number }).durationUs = 0;
    }).toThrow(TypeError);
    expect(repository.readRevision).toHaveBeenCalledTimes(readsBefore);
    expect(repository.writeCompleteRevision).not.toHaveBeenCalled();
  });

  it("rejects copied or forged envelopes before observing their content", async () => {
    const { envelope, repository } = await genuineRevisionEnvelope();
    const readsBefore = repository.readRevision.mock.calls.length;

    await expectStableDraftReloadFailure(
      Promise.resolve().then(() =>
        durableDraftContentParity.validateDurableDraftCanonicalContent({
          ...envelope,
        }),
      ),
    );
    expect(
      durableDraftContentParity.validateDurableDraftCanonicalContent(envelope),
    ).toMatchObject({ revision: { revisionId: "revision-2" } });
    await expectStableDraftReloadFailure(
      Promise.resolve().then(() =>
        durableDraftContentParity.validateDurableDraftCanonicalContent(
          envelope,
        ),
      ),
    );
    expect(repository.readRevision).toHaveBeenCalledTimes(readsBefore);
    expect(repository.writeCompleteRevision).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid UTF-8", new Uint8Array([0xc3, 0x28]), FIRST_SLICE_DOCUMENT],
    ["invalid JSON", new TextEncoder().encode("{"), FIRST_SLICE_DOCUMENT],
    [
      "schema-invalid JSON",
      new TextEncoder().encode('{"schemaVersion":99}'),
      FIRST_SLICE_DOCUMENT,
    ],
    [
      "noncanonical whitespace",
      new TextEncoder().encode(JSON.stringify(FIRST_SLICE_DOCUMENT, null, 2)),
      FIRST_SLICE_DOCUMENT,
    ],
    [
      "valid altered canonical bytes",
      new TextEncoder().encode(
        new TextDecoder().decode(
          canonicalizeSceneDocument.exportEditableJson(FIRST_SLICE_DOCUMENT),
        ) + " ",
      ),
      FIRST_SLICE_DOCUMENT,
    ],
    [
      "revision document mismatch",
      canonicalizeSceneDocument.exportEditableJson(FIRST_SLICE_DOCUMENT),
      { ...FIRST_SLICE_DOCUMENT, durationUs: 2_000_000 },
    ],
  ] as const)(
    "normalizes %s without repository writes",
    async (_label, bytes, document) => {
      const { envelope, repository } = await genuineRevisionEnvelope(
        canonicalDraftRevision({
          document,
          canonicalization: {
            identifier: "jcs-1",
            byteLength: bytes.byteLength,
          },
          canonicalBytes: bytes,
        }),
      );
      const readsBefore = repository.readRevision.mock.calls.length;

      await expectStableDraftReloadFailure(
        Promise.resolve().then(() =>
          durableDraftContentParity.validateDurableDraftCanonicalContent(
            envelope,
          ),
        ),
      );
      expect(repository.readRevision).toHaveBeenCalledTimes(readsBefore);
      expect(repository.writeCompleteRevision).not.toHaveBeenCalled();
    },
  );

  it("uses load-captured UTF-8 intrinsics despite decoder and encoder prototype poison", async () => {
    const { envelope } = await genuineRevisionEnvelope();
    const originalDecode = TextDecoder.prototype.decode;
    const originalEncode = TextEncoder.prototype.encode;
    try {
      TextDecoder.prototype.decode = () => "poisoned";
      TextEncoder.prototype.encode = () => new Uint8Array([0]);
      expect(() =>
        durableDraftContentParity.validateDurableDraftCanonicalContent(
          envelope,
        ),
      ).not.toThrow();
    } finally {
      TextDecoder.prototype.decode = originalDecode;
      TextEncoder.prototype.encode = originalEncode;
    }
  });
});

async function validatedReloadRecord(
  images: ReadonlyArray<{ readonly id: string; readonly sha256?: string }> = [
    { id: "image-a" },
  ],
) {
  const document = imageDocument(images);
  const canonicalBytes = canonicalizeSceneDocument.exportEditableJson(document);
  const { envelope, repository } = await genuineRevisionEnvelope(
    canonicalDraftRevision({
      document,
      canonicalization: {
        identifier: "jcs-1",
        byteLength: canonicalBytes.byteLength,
      },
      canonicalBytes,
    }),
  );
  return {
    record:
      durableDraftContentParity.validateDurableDraftCanonicalContent(envelope),
    repository,
  };
}

describe("complete-only durable draft reload hydration", () => {
  it("hydrates a genuine record before atomically exposing its frozen workspace without repository I/O", async () => {
    const events: string[] = [];
    const handle = { close: vi.fn() };
    const { record, repository } = await validatedReloadRecord();
    const service = durableDraftPublication.createDurableDraftWorkspaceService({
      documentId: "draft-document",
      revisionId: () => "unused",
      sequence: () => 0,
      createdAt: () => 99,
      repository,
      prehydration: {
        cache: stagedCache(),
        rereadVerifiedPng: async (sha256: string) => {
          events.push("reread");
          return asset({ sha256 });
        },
        decodeVerifiedPng: async (verified: AssetRecord) => {
          events.push("decode");
          return { ...verified, width: 20, height: 10, handle };
        },
      },
    });
    const revisionReads = repository.readRevision.mock.calls.length;
    const pointerReads = repository.readPointers.mock.calls.length;
    const hydrated = await service.reload(record);

    expect(events).toEqual(["reread", "decode"]);
    expect(hydrated).toMatchObject({
      documentId: "document-1",
      revisionId: "revision-2",
      sequence: 2,
      createdAt: 99,
      images: [{ handle }],
    });
    expect(Object.isFrozen(hydrated)).toBe(true);
    expect(repository.readRevision).toHaveBeenCalledTimes(revisionReads);
    expect(repository.readPointers).toHaveBeenCalledTimes(pointerReads);
    expect(repository.writeCompleteRevision).not.toHaveBeenCalled();
  });

  it("rejects forged and reused records before prehydration", async () => {
    const events: string[] = [];
    const { record, repository } = await validatedReloadRecord();
    const service = durableDraftPublication.createDurableDraftWorkspaceService({
      documentId: "draft-document",
      revisionId: () => "unused",
      sequence: () => 0,
      createdAt: () => 1,
      repository,
      prehydration: {
        cache: stagedCache(),
        rereadVerifiedPng: async (sha256: string) => {
          events.push("reread");
          return asset({ sha256 });
        },
        decodeVerifiedPng: async (verified: AssetRecord) => ({
          ...verified,
          width: 20,
          height: 10,
          handle: {},
        }),
      },
    });
    const pointerReads = repository.readPointers.mock.calls.length;
    await expectStableDraftReloadFailure(service.reload({ ...record }));
    await service.reload(record);
    await expectStableDraftReloadFailure(service.reload(record));
    expect(events).toEqual(["reread"]);
    expect(repository.readPointers).toHaveBeenCalledTimes(pointerReads);
    expect(repository.writeCompleteRevision).not.toHaveBeenCalled();
  });

  it("prehydrates before swap, releases the prior after commit, and keeps stale snapshots bound to the prior workspace", async () => {
    const first = await validatedReloadRecord();
    const second = await validatedReloadRecord([
      { id: "image-b", sha256: OTHER_SHA256 },
    ]);
    const third = await validatedReloadRecord([
      { id: "image-c", sha256: `sha256:${"a".repeat(64)}` },
    ]);
    const gate = deferred();
    const handles = [
      { close: vi.fn() },
      { close: vi.fn() },
      { close: vi.fn() },
    ];
    let decoding = 0;
    const service = durableDraftPublication.createDurableDraftWorkspaceService({
      documentId: "draft-document",
      revisionId: () => "unused",
      sequence: () => 0,
      createdAt: () => 2,
      repository: first.repository,
      prehydration: {
        cache: stagedCache(),
        rereadVerifiedPng: async (sha256: string) => {
          if (sha256 === OTHER_SHA256) await gate.promise;
          return asset({ sha256 });
        },
        decodeVerifiedPng: async (verified: AssetRecord) => ({
          ...verified,
          width: 20,
          height: 10,
          handle: handles[decoding++]!,
        }),
      },
    });
    const stale = await service.reload(first.record);
    const pending = service.reload(second.record);
    await Promise.resolve();
    expect(service.current?.images[0]!.handle).toBe(handles[0]);
    expect(handles[0]!.close).not.toHaveBeenCalled();
    const intermediate = await service.reload(third.record);
    expect(intermediate.images[0]!.handle).toBe(handles[1]);
    expect(handles[0]!.close).toHaveBeenCalledTimes(1);
    gate.release();
    const current = await pending;
    expect(current.images[0]!.handle).toBe(handles[2]);
    expect(handles[1]!.close).toHaveBeenCalledTimes(1);
    stale.release();
    expect(service.current?.images[0]!.handle).toBe(handles[2]);
  });

  it("rolls back new-only ownership on hydration or hostile time failures and ignores prior cleanup poison", async () => {
    const first = await validatedReloadRecord();
    const failed = await validatedReloadRecord([
      { id: "image-b", sha256: OTHER_SHA256 },
      { id: "image-c", sha256: `sha256:${"a".repeat(64)}` },
    ]);
    const time = await validatedReloadRecord([
      { id: "image-d", sha256: `sha256:${"b".repeat(64)}` },
    ]);
    const success = await validatedReloadRecord([
      { id: "image-e", sha256: `sha256:${"c".repeat(64)}` },
    ]);
    const handles: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    let mode = "first";
    let createdAt: () => number = () => 3;
    let failures = 0;
    const service = durableDraftPublication.createDurableDraftWorkspaceService({
      documentId: "draft-document",
      revisionId: () => "unused",
      sequence: () => 0,
      createdAt: () => createdAt(),
      repository: first.repository,
      prehydration: {
        cache: stagedCache(),
        rereadVerifiedPng: async (sha256: string) => asset({ sha256 }),
        decodeVerifiedPng: async (verified: AssetRecord) => {
          if (mode === "hydrate" && failures++ === 1) throw Error("private");
          const handle = {
            close: vi.fn(() => {
              if (mode === "poison") {
                service.release();
                Array.prototype.map = () => [];
              }
            }),
          };
          handles.push(handle);
          return { ...verified, width: 20, height: 10, handle };
        },
      },
    });
    const originalMap = Array.prototype.map;
    try {
      await service.reload(first.record);
      mode = "hydrate";
      await expectStableDraftReloadFailure(service.reload(failed.record));
      expect(service.current?.images[0]!.handle).toBe(handles[0]);
      expect(handles[1]!.close).toHaveBeenCalledTimes(1);
      mode = "time";
      createdAt = () => Number.NaN;
      await expectStableDraftReloadFailure(service.reload(time.record));
      expect(handles.at(-1)?.close).toHaveBeenCalledTimes(1);
      createdAt = () => 4;
      mode = "poison";
      Array.prototype.map = () => [];
      const committed = await service.reload(success.record);
      expect(committed.images[0]!.handle).toBe(handles.at(-1));
      expect(service.current?.images[0]!.handle).toBe(handles.at(-1));
    } finally {
      Array.prototype.map = originalMap;
    }
  });

  it("accepts separately validated records for the same revision without durable I/O", async () => {
    const first = await validatedReloadRecord();
    const repeated = await validatedReloadRecord();
    const handles = [{ close: vi.fn() }, { close: vi.fn() }];
    let decoding = 0;
    const service = durableDraftPublication.createDurableDraftWorkspaceService({
      documentId: "draft-document",
      revisionId: () => "unused",
      sequence: () => 0,
      createdAt: () => 5,
      repository: first.repository,
      prehydration: {
        cache: stagedCache(),
        rereadVerifiedPng: async (sha256: string) => asset({ sha256 }),
        decodeVerifiedPng: async (verified: AssetRecord) => ({
          ...verified,
          width: 20,
          height: 10,
          handle: handles[decoding++]!,
        }),
      },
    });
    const pointerReads = first.repository.readPointers.mock.calls.length;
    await service.reload(first.record);
    const hydrated = await service.reload(repeated.record);

    expect(hydrated).toMatchObject({ revisionId: "revision-2", sequence: 2 });
    expect(service.current?.images[0]!.handle).toBe(handles[0]);
    expect(handles[1]!.close).toHaveBeenCalledTimes(1);
    expect(first.repository.readPointers).toHaveBeenCalledTimes(pointerReads);
    expect(first.repository.writeCompleteRevision).not.toHaveBeenCalled();
  });
});

type BrowserCompositionTestWorkspace = {
  readonly documentId: string;
  readonly revisionId: string;
  readonly plan: { readonly document: SceneDocumentV1 };
  readonly release: ReturnType<typeof vi.fn>;
};

type BrowserCompositionTestDependencies = {
  readonly repository: {
    readonly readApproval: ReturnType<typeof vi.fn>;
    readonly readAsset: ReturnType<typeof vi.fn>;
  };
  readonly cache: object;
  readonly service: {
    current: BrowserCompositionTestWorkspace | null;
    readonly publish: ReturnType<typeof vi.fn>;
    readonly reload: ReturnType<typeof vi.fn>;
    readonly release: ReturnType<typeof vi.fn>;
  };
  readonly buildApprovedHtml: ReturnType<typeof vi.fn>;

  readonly resolvePointer: ReturnType<typeof vi.fn>;
  readonly readEnvelope: ReturnType<typeof vi.fn>;
  readonly validateContent: ReturnType<typeof vi.fn>;
  readonly commandIdSource?: () =>
    | { readonly kind: "id"; readonly id: string }
    | { readonly kind: "unavailable" };
  readonly activateCommandWorkspace?: (
    workspace: BrowserCompositionTestWorkspace,
  ) => void;
};

type BrowserCompositionForTest = {
  readonly workflow: (request: EditorWorkflowRequest) => Promise<{
    readonly label: string;
  }>;
  readonly exportApprovedHtml: () => Promise<{
    readonly bytes: Uint8Array;
    readonly manifest: unknown;
  }>;
  readonly reload: () => Promise<BrowserCompositionTestWorkspace | null>;
  readonly dispatch: (
    command: unknown,
  ) => Promise<{ readonly result: unknown }>;
  readonly undo: () => Promise<{ readonly result: unknown }>;
  readonly redo: () => Promise<{ readonly result: unknown }>;
  readonly snapshot: () => Promise<{
    readonly revision: number;
    readonly document: SceneDocumentV1;
  } | null>;
  readonly release: () => Promise<void>;
};

function deferredValue<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  return {
    promise: new Promise<Value>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    }),
    resolve,
    reject,
  };
}

function durableBrowserCompositionFactory() {
  return createDurableBrowserCompositionForTesting as unknown as (
    dependencies: BrowserCompositionTestDependencies,
  ) => BrowserCompositionForTest;
}

function createBrowserCompositionTestDependencies(
  overrides: Partial<BrowserCompositionTestDependencies> = {},
) {
  const workspace: BrowserCompositionTestWorkspace = {
    documentId: "draft-document",
    revisionId: "draft-test",
    plan: { document: structuredClone(FIRST_SLICE_DOCUMENT) },
    release: vi.fn(),
  };
  const service = {
    current: null as BrowserCompositionTestWorkspace | null,
    publish: vi.fn(async () => {
      service.current = workspace;
      return workspace;
    }),
    reload: vi.fn(async () => {
      service.current = workspace;
      return workspace;
    }),
    release: vi.fn(() => {
      (service.current?.release as (() => void) | undefined)?.();
      service.current = null;
    }),
  };
  return {
    workspace,
    dependencies: {
      repository: {
        readApproval: vi.fn(async () => ({
          documentId: workspace.documentId,
          revisionId: workspace.revisionId,
          snapshotHash: "approval-hash",
        })),
        readAsset: vi.fn(),
      },
      cache: {},
      service,
      buildApprovedHtml: vi.fn(async () => ({
        files: {
          paths: ["particle-studio.html"],
          get: (path: string) =>
            path === "particle-studio.html"
              ? new Uint8Array([1, 2, 3])
              : undefined,
        },
        manifest: { moduleEntry: "particle-studio.html" },
      })),
      resolvePointer: vi.fn(async () => ({ pointer: true })),
      readEnvelope: vi.fn(async () => ({ envelope: true })),
      validateContent: vi.fn(() => ({ record: true })),
      activateCommandWorkspace: vi.fn(),
      ...overrides,
    },
  };
}

describe("durable browser composition lifecycle", () => {
  it("runs an invocation-order reload before a later durable publication", async () => {
    const events: string[] = [];
    const reloadGate = deferredValue<{ pointer: true }>();
    const { dependencies } = createBrowserCompositionTestDependencies({
      resolvePointer: vi.fn(async () => {
        events.push("pointer");
        return reloadGate.promise;
      }),
      readEnvelope: vi.fn(async () => {
        events.push("revision");
        return { envelope: true };
      }),
      validateContent: vi.fn(() => {
        events.push("validation");
        return { record: true };
      }),
    });
    const createComposition = durableBrowserCompositionFactory();
    expect(createComposition).toBeTypeOf("function");
    const composition = createComposition!(dependencies);

    const reload = composition.reload();
    const workflow = composition.workflow({
      kind: "editable-json-import",
      editableJson: "{}",
    });
    await Promise.resolve();
    expect(events).toEqual(["pointer"]);
    expect(dependencies.service.publish).not.toHaveBeenCalled();

    reloadGate.resolve({ pointer: true });
    await reload;
    await expect(workflow).resolves.toEqual({ label: "Draft draft-test" });
    expect(events).toEqual(["pointer", "revision", "validation"]);
    expect(dependencies.service.publish).toHaveBeenCalledOnce();
  });

  it("normalizes a rejected reload tail so the next workflow can publish", async () => {
    const { dependencies } = createBrowserCompositionTestDependencies({
      resolvePointer: vi.fn().mockRejectedValueOnce(new Error("missing")),
    });
    const createComposition = durableBrowserCompositionFactory();
    expect(createComposition).toBeTypeOf("function");
    const composition = createComposition!(dependencies);

    await expect(composition.reload()).resolves.toBeNull();
    await expect(
      composition.workflow({
        kind: "editable-json-import",
        editableJson: "{}",
      }),
    ).resolves.toEqual({ label: "Draft draft-test" });
    expect(dependencies.service.publish).toHaveBeenCalledOnce();
  });

  it("rejects in-flight and post-release operations before authority escapes and releases current once", async () => {
    const publishGate = deferredValue<BrowserCompositionTestWorkspace>();
    const { dependencies, workspace } =
      createBrowserCompositionTestDependencies({
        service: {
          current: null,
          publish: vi.fn(() => publishGate.promise),

          reload: vi.fn(),
          release: vi.fn(),
        },
      });
    let current: BrowserCompositionTestWorkspace | null = null;
    dependencies.service.publish.mockImplementation(async () => {
      current = workspace;
      return publishGate.promise;
    });
    dependencies.service.release.mockImplementation(() => {
      (current?.release as (() => void) | undefined)?.();
      current = null;
    });
    const createComposition = durableBrowserCompositionFactory();
    expect(createComposition).toBeTypeOf("function");
    const composition = createComposition!(dependencies);

    const inFlight = composition.workflow({
      kind: "editable-json-import",
      editableJson: "{}",
    });
    await Promise.resolve();
    const release = composition.release();
    await expect(
      composition.workflow({
        kind: "editable-json-import",
        editableJson: "later",
      }),
    ).rejects.toThrow("DURABLE_BROWSER_COMPOSITION_RELEASED");
    await expect(composition.reload()).rejects.toThrow(
      "DURABLE_BROWSER_COMPOSITION_RELEASED",
    );
    expect(dependencies.service.publish).toHaveBeenCalledOnce();
    expect(dependencies.resolvePointer).not.toHaveBeenCalled();
    expect(dependencies.service.release).not.toHaveBeenCalled();

    publishGate.resolve(workspace);
    await expect(inFlight).rejects.toThrow(
      "DURABLE_BROWSER_COMPOSITION_RELEASED",
    );
    await release;
    await composition.release();
    expect(dependencies.service.release).toHaveBeenCalledOnce();
    expect(workspace.release).toHaveBeenCalledOnce();
  });
});

function durableBridgeCommand(value: number, revision = 0) {
  return {
    commandSchemaVersion: 1,
    commandId: `command-${revision}-${value}`,
    documentId: "draft-document",
    expectedRevision: revision,
    actorCapability: "human-ui",
    payload: {
      type: "set-keyframe-value" as const,
      trackId: "shape-1:opacity",
      keyframeId: "shape-1:opacity:0",
      value,
    },
  };
}

function durableBridgeCreateCommand(revision = 0) {
  return {
    commandSchemaVersion: 1,
    commandId: `create-${revision}`,
    documentId: "draft-document",
    expectedRevision: revision,
    actorCapability: "human-ui",
    payload: {
      type: "create-element" as const,
      element: { type: "group", childrenIds: [] },
    },
  };
}

function browserCompositionWorkspace(
  revisionId: string,
  document = structuredClone(FIRST_SLICE_DOCUMENT) as SceneDocumentV1,
): BrowserCompositionTestWorkspace {
  return {
    documentId: "draft-document",
    revisionId,
    plan: { document },
    release: vi.fn(),
  };
}

describe("durable browser composition command bridge", () => {
  it("returns a stable unavailable result without publishing when no workspace is active", async () => {
    const { dependencies } = createBrowserCompositionTestDependencies();
    const composition = durableBrowserCompositionFactory()!(dependencies);

    await expect(
      composition.dispatch(durableBridgeCommand(0.25)),
    ).resolves.toEqual({
      result: { ok: false, error: { code: "DURABLE_COMMAND_UNAVAILABLE" } },
    });
    expect(dependencies.service.publish).not.toHaveBeenCalled();
    await expect(composition.snapshot()).resolves.toBeNull();
  });

  it("creates a fresh bridge from accepted import and reload workspaces", async () => {
    const imported = browserCompositionWorkspace("imported");
    const reloaded = browserCompositionWorkspace("reloaded");
    const { dependencies } = createBrowserCompositionTestDependencies({
      service: {
        current: null,
        publish: vi.fn(async () => {
          dependencies.service.current = imported;
          return imported;
        }),
        reload: vi.fn(async () => {
          dependencies.service.current = reloaded;
          return reloaded;
        }),
        release: vi.fn(),
      },
    });
    const composition = durableBrowserCompositionFactory()!(dependencies);

    await composition.workflow({
      kind: "editable-json-import",
      editableJson: "{}",
    });
    await expect(composition.snapshot()).resolves.toMatchObject({
      revision: 0,
    });
    await composition.dispatch(durableBridgeCommand(0.25));
    await composition.reload();

    await expect(composition.snapshot()).resolves.toMatchObject({
      revision: 0,
    });
    await expect(composition.undo()).resolves.toEqual({
      result: { ok: false, error: { code: "NOTHING_TO_UNDO" } },
    });
  });

  it("fails closed when a same-document out-of-band revision supersedes the bridge", async () => {
    const initial = browserCompositionWorkspace("bridge-revision");
    const { dependencies } = createBrowserCompositionTestDependencies({
      service: {
        current: initial,
        publish: vi.fn(),
        reload: vi.fn(async () => initial),
        release: vi.fn(),
      },
    });
    const composition = durableBrowserCompositionFactory()!(dependencies);
    await composition.reload();
    dependencies.service.current =
      browserCompositionWorkspace("newer-revision");

    await expect(
      composition.dispatch(durableBridgeCommand(0.25)),
    ).resolves.toEqual({
      result: { ok: false, error: { code: "DURABLE_PUBLISH_FAILED" } },
    });
    expect(dependencies.repository.readApproval).not.toHaveBeenCalled();
    expect(dependencies.service.publish).not.toHaveBeenCalled();
    expect(dependencies.activateCommandWorkspace).not.toHaveBeenCalled();
  });

  it("fails closed when the workspace changes during approval reread without advancing bridge history or identity", async () => {
    const initial = browserCompositionWorkspace("approval-reread");
    const published = browserCompositionWorkspace("published-after-retry");
    const approvalEntered = deferredValue<void>();
    const approval = deferredValue<{
      readonly documentId: string;
      readonly revisionId: string;
      readonly snapshotHash: string;
    }>();
    const { dependencies } = createBrowserCompositionTestDependencies({
      service: {
        current: initial,
        publish: vi.fn(async () => {
          dependencies.service.current = published;
          return published;
        }),
        reload: vi.fn(async () => initial),
        release: vi.fn(),
      },
    });
    dependencies.repository.readApproval.mockImplementation(async () => {
      approvalEntered.resolve();
      return approval.promise;
    });
    const composition = durableBrowserCompositionFactory()!(dependencies);
    await composition.reload();

    const pending = composition.dispatch(durableBridgeCommand(0.25));
    await approvalEntered.promise;
    dependencies.service.current =
      browserCompositionWorkspace("newer-revision");
    approval.resolve({
      documentId: initial.documentId,
      revisionId: initial.revisionId,
      snapshotHash: "approval-hash",
    });

    await expect(pending).resolves.toEqual({
      result: { ok: false, error: { code: "DURABLE_PUBLISH_FAILED" } },
    });
    expect(dependencies.service.publish).not.toHaveBeenCalled();
    expect(dependencies.activateCommandWorkspace).not.toHaveBeenCalled();
    await expect(composition.snapshot()).resolves.toMatchObject({
      revision: 0,
    });

    dependencies.service.current = initial;
    await expect(
      composition.dispatch(durableBridgeCommand(0.25)),
    ).resolves.toEqual({
      result: expect.objectContaining({ ok: true, revision: 1 }),
    });
    expect(dependencies.activateCommandWorkspace).toHaveBeenCalledOnce();
  });

  it("publishes accepted commands through the canonical service route, privately activates their workspaces, and retains undo/redo history", async () => {
    const events: string[] = [];
    let publication = 0;
    const { dependencies } = createBrowserCompositionTestDependencies({
      activateCommandWorkspace: vi.fn(() => events.push("activate")),
    });
    dependencies.repository.readApproval.mockImplementation(
      async (documentId: string, revisionId: string) => ({
        documentId,
        revisionId,
        snapshotHash: "approval-hash",
      }),
    );
    dependencies.service.publish.mockImplementation(async () => {
      events.push("publish");
      publication += 1;
      const workspace = browserCompositionWorkspace(`revision-${publication}`);
      dependencies.service.current = workspace;
      return workspace;
    });
    const composition = durableBrowserCompositionFactory()!(dependencies);

    await composition.workflow({
      kind: "editable-json-import",
      editableJson: "{}",
    });
    events.length = 0;
    const dispatched = await composition.dispatch(durableBridgeCommand(0.25));
    const undone = await composition.undo();
    const redone = await composition.redo();

    expect(dispatched).toEqual({
      result: expect.objectContaining({ ok: true, revision: 1 }),
    });
    expect(undone).toEqual({
      result: expect.objectContaining({ ok: true, revision: 2 }),
    });
    expect(redone).toEqual({
      result: expect.objectContaining({ ok: true, revision: 3 }),
    });
    expect(dispatched).not.toHaveProperty("workspace");
    expect(undone).not.toHaveProperty("workspace");
    expect(redone).not.toHaveProperty("workspace");
    expect(dependencies.activateCommandWorkspace).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ revisionId: "revision-2" }),
    );
    expect(dependencies.activateCommandWorkspace).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ revisionId: "revision-3" }),
    );
    expect(dependencies.activateCommandWorkspace).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ revisionId: "revision-4" }),
    );
    expect(dependencies.repository.readApproval).toHaveBeenNthCalledWith(
      1,
      "draft-document",
      "revision-1",
    );
    expect(dependencies.service.publish).toHaveBeenCalledTimes(4);
    expect(dependencies.service.publish.mock.calls[1]?.[1]).toMatchObject({
      revisionId: "revision-1",
      snapshotHash: "approval-hash",
    });
    expect(dependencies.service.publish.mock.calls[1]?.[0]).toBe(
      new TextDecoder().decode(
        canonicalizeSceneDocument.exportEditableJson({
          ...FIRST_SLICE_DOCUMENT,
          tracks: [
            {
              ...FIRST_SLICE_DOCUMENT.tracks[0],
              keyframes: [
                {
                  ...FIRST_SLICE_DOCUMENT.tracks[0]!.keyframes[0],
                  value: 0.25,
                },
                { ...FIRST_SLICE_DOCUMENT.tracks[0]!.keyframes[1] },
              ],
            },
          ],
        }),
      ),
    );
    expect(dependencies.activateCommandWorkspace).toHaveBeenLastCalledWith(
      dependencies.service.current,
    );
    expect(events).toEqual([
      "publish",
      "activate",
      "publish",
      "activate",
      "publish",
      "activate",
    ]);
  });

  it("does not publish rejected commands", async () => {
    const { dependencies } = createBrowserCompositionTestDependencies();
    const composition = durableBrowserCompositionFactory()!(dependencies);
    await composition.workflow({
      kind: "editable-json-import",
      editableJson: "{}",
    });
    const callsBefore = dependencies.service.publish.mock.calls.length;

    await expect(
      composition.dispatch(durableBridgeCommand(0.25, 1)),
    ).resolves.toEqual({
      result: { ok: false, error: { code: "REVISION_CONFLICT" } },
    });
    expect(dependencies.service.publish).toHaveBeenCalledTimes(callsBefore);
  });

  it("uses the service publish route for asset-bearing candidates without direct asset reads", async () => {
    const assetDocument = {
      ...FIRST_SLICE_DOCUMENT,
      rootIds: ["shape-1", "image-1"],
      elements: [
        ...FIRST_SLICE_DOCUMENT.elements,
        {
          id: "image-1",
          type: "image" as const,
          asset: {
            sha256: PNG_SHA256,
            mimeType: "image/png" as const,
            byteLength: PNG_BYTES.byteLength,
            intrinsicWidth: 20,
            intrinsicHeight: 10,
          },
          x: 0,
          y: 0,
          width: 20,
          height: 10,
          opacity: 1,
        },
      ],
    } as SceneDocumentV1;
    const initial = browserCompositionWorkspace("asset-initial", assetDocument);
    const published = browserCompositionWorkspace(
      "asset-published",
      assetDocument,
    );
    const { dependencies } = createBrowserCompositionTestDependencies({
      commandIdSource: () => ({ kind: "id", id: "new-group" }),
      service: {
        current: initial,
        publish: vi.fn(async () => {
          dependencies.service.current = published;
          return published;
        }),
        reload: vi.fn(async () => initial),
        release: vi.fn(),
      },
    });
    const composition = durableBrowserCompositionFactory()!(dependencies);
    await composition.reload();

    await expect(
      composition.dispatch(durableBridgeCreateCommand()),
    ).resolves.toEqual({
      result: expect.objectContaining({ ok: true, revision: 1 }),
    });
    expect(dependencies.activateCommandWorkspace).toHaveBeenCalledWith(
      published,
    );
    expect(dependencies.service.publish).toHaveBeenCalledOnce();
    expect(dependencies.repository.readAsset).not.toHaveBeenCalled();
    expect(dependencies.repository.readApproval).toHaveBeenCalledWith(
      "draft-document",
      "asset-initial",
    );
  });

  it("suppresses pending command authority during release and releases once", async () => {
    const publication = deferredValue<BrowserCompositionTestWorkspace>();
    const initial = browserCompositionWorkspace("pending");
    const { dependencies } = createBrowserCompositionTestDependencies({
      service: {
        current: initial,
        publish: vi.fn(() => publication.promise),
        reload: vi.fn(async () => initial),
        release: vi.fn(),
      },
    });
    const composition = durableBrowserCompositionFactory()!(dependencies);
    await composition.reload();

    const command = composition.dispatch(durableBridgeCommand(0.25));
    await Promise.resolve();
    const release = composition.release();
    publication.resolve(browserCompositionWorkspace("published"));

    await expect(command).rejects.toThrow(
      "DURABLE_BROWSER_COMPOSITION_RELEASED",
    );
    await release;
    await composition.release();
    expect(dependencies.activateCommandWorkspace).not.toHaveBeenCalled();
    expect(dependencies.service.release).toHaveBeenCalledOnce();
  });
});

describe("browser-agent durable composition binding", () => {
  const durableDocumentId = "particle-studio-editor-document";
  const compositionFactory =
    createDurableBrowserCompositionForTesting as unknown as (
      dependencies: unknown,
    ) => {
      workflow(
        request: EditorWorkflowRequest,
      ): Promise<{ readonly label: string }>;
      approve(): Promise<{
        readonly revisionId: string;
        readonly snapshotHash: string;
      }>;
      reload(): Promise<DurableDraftWorkspace | null>;
      dispatch(command: unknown): Promise<{ readonly result: unknown }>;
      undo(): Promise<{ readonly result: unknown }>;
      redo(): Promise<{ readonly result: unknown }>;
      snapshot(): Promise<{
        readonly revision: number;
        readonly document: SceneDocumentV1;
      } | null>;
      release(): Promise<void>;
    };

  function durableCommand(revision = 0) {
    return {
      commandSchemaVersion: 1,
      commandId: `browser-agent-command-${revision}`,
      documentId: durableDocumentId,
      expectedRevision: revision,
      actorCapability: "browser-agent",
      payload: {
        type: "create-element" as const,
        element: { type: "group", childrenIds: [] },
      },
    };
  }

  function adapterRequest(tool: string, input: unknown, requestId: string) {
    return { schemaVersion: 1, requestId, tool, input };
  }

  function createRealDurableComposition(label: string) {
    const databaseName = `browser-agent-${label}-${Date.now()}-${Math.random()}`;
    const persistence = createIndexedDbPersistenceAdapter({ databaseName });
    const events: string[] = [];
    const readAsset = vi.fn(async (sha256: string) => {
      events.push("read");
      return persistence.readAsset(sha256);
    });
    const readApproval = vi.fn(persistence.readApproval.bind(persistence));
    const writeCompleteRevision = vi.fn(
      persistence.writeCompleteRevision.bind(persistence),
    );
    const repository = {
      ...persistence,
      readAsset,
      readApproval,
      writeCompleteRevision,
    };
    const handles: Array<{
      readonly kind: "fixture-decoded-png";
      readonly ordinal: number;
    }> = [];
    const decodePng = vi.fn((bytes: Uint8Array) => {
      events.push("decode");
      const handle = {
        kind: "fixture-decoded-png" as const,
        ordinal: handles.length + 1,
      };
      handles.push(handle);
      return { width: 20, height: 10, handle, bytes: bytes.slice() };
    });
    const cache = pngCacheRuntime.createPngImageCache({
      importVerifiedPng: async () => {
        throw new Error("unexpected image import");
      },
      decodeVerifiedPng: (verified) =>
        decodeVerifiedPngAsset(verified, decodePng),
    });
    let revision = 0;
    let sequence = 0;
    let createdAt = 100;
    const service = durableDraftPublication.createDurableDraftWorkspaceService({
      documentId: durableDocumentId,
      revisionId: () => `fixture-revision-${++revision}`,
      sequence: () => ++sequence,
      createdAt: () => ++createdAt,
      repository,
      prehydration: {
        cache,
        rereadVerifiedPng: readAsset,
        decodeVerifiedPng: (verified: AssetRecord) =>
          decodeVerifiedPngAsset(
            { ...verified, mimeType: "image/png" as const },
            decodePng,
          ),
      },
    });
    const activateCommandWorkspace = vi.fn(
      (workspace: DurableDraftWorkspace) => {
        events.push("activate");
        return workspace;
      },
    );
    const composition = compositionFactory({
      repository,
      cache,
      service,
      resolvePointer: durableDraftPointerResolver.resolveDurableDraftPointer,
      readEnvelope: readRevisionEnvelope,
      validateContent:
        durableDraftContentParity.validateDurableDraftCanonicalContent,
      commandIdSource: () => ({
        kind: "id",
        id: "fixture-created-element",
      }),
      activateCommandWorkspace,
      buildApprovedHtml: async () => {
        throw new Error("unexpected export");
      },
    });
    return {
      databaseName,
      repository,
      writeCompleteRevision,
      readAsset,
      readApproval,
      decodePng,
      handles,
      events,
      service,
      activateCommandWorkspace,
      composition,
    };
  }

  it("keeps direct and adapter-wrapped real durable compositions exactly equivalent across dispatch, undo, redo, and reload", async () => {
    const direct = createRealDurableComposition("direct");
    const wrapped = createRealDurableComposition("wrapped");
    const adapter = createBrowserAgentWorkspaceAdapter({
      documentId: durableDocumentId,
      snapshot: wrapped.composition.snapshot,
      dispatch: wrapped.composition.dispatch,
      undo: wrapped.composition.undo,
      redo: wrapped.composition.redo,
    });
    const workspaceObservable = ({
      release: _release,
      ...workspace
    }: DurableDraftWorkspace) => workspace;
    const expectWorkspaceMatchesPersistedRevision = (
      workspace: DurableDraftWorkspace,
      revision: {
        readonly documentId: string;
        readonly revisionId: string;
        readonly sequence: number;
        readonly document: object;
        readonly canonicalBytes: Uint8Array;
      },
    ) => {
      expect(workspace.documentId).toBe(revision.documentId);
      expect(workspace.revisionId).toBe(revision.revisionId);
      expect(workspace.sequence).toBe(revision.sequence);
      expect(workspace.plan.document).toEqual(revision.document);
      expect(workspace.canonicalBytes).toEqual(revision.canonicalBytes);
      expect(workspace.canonicalEditableJson).toBe(
        new TextDecoder().decode(revision.canonicalBytes),
      );
      expect(JSON.parse(workspace.canonicalEditableJson)).toEqual(
        revision.document,
      );
    };
    try {
      const [directAsset, wrappedAsset] = await Promise.all([
        direct.repository.writeAsset({
          mimeType: "image/png",
          bytes: PNG_BYTES,
        }),
        wrapped.repository.writeAsset({
          mimeType: "image/png",
          bytes: PNG_BYTES,
        }),
      ]);
      expect(wrappedAsset).toEqual(directAsset);
      await expect(
        direct.repository.readAsset(directAsset.sha256),
      ).resolves.toEqual(directAsset);
      await expect(
        wrapped.repository.readAsset(wrappedAsset.sha256),
      ).resolves.toEqual(wrappedAsset);
      const fixtureDocument = {
        ...FIRST_SLICE_DOCUMENT,
        rootIds: [...FIRST_SLICE_DOCUMENT.rootIds, "fixture-image"],
        elements: [
          ...FIRST_SLICE_DOCUMENT.elements,
          {
            id: "fixture-image",
            type: "image" as const,
            asset: {
              sha256: directAsset.sha256,
              mimeType: "image/png" as const,
              byteLength: PNG_BYTES.byteLength,
              intrinsicWidth: 20,
              intrinsicHeight: 10,
            },
            x: 0,
            y: 0,
            width: 20,
            height: 10,
            opacity: 1,
          },
        ],
      } as SceneDocumentV1;
      const workflowRequest = {
        kind: "editable-json-import" as const,
        editableJson: JSON.stringify(fixtureDocument),
      };
      const [directWorkflow, wrappedWorkflow] = await Promise.all([
        direct.composition.workflow(workflowRequest),
        wrapped.composition.workflow(workflowRequest),
      ]);
      expect(wrappedWorkflow).toEqual(directWorkflow);
      const directInitialWorkspace = direct.service.current;
      const wrappedInitialWorkspace = wrapped.service.current;
      expect(directInitialWorkspace).not.toBeNull();
      expect(wrappedInitialWorkspace).not.toBeNull();
      const directInitialRevision =
        direct.writeCompleteRevision.mock.calls[0]?.[0];
      const wrappedInitialRevision =
        wrapped.writeCompleteRevision.mock.calls[0]?.[0];
      expect(directInitialRevision).toBeDefined();
      expect(wrappedInitialRevision).toBeDefined();
      if (
        directInitialWorkspace === null ||
        wrappedInitialWorkspace === null ||
        directInitialRevision === undefined ||
        wrappedInitialRevision === undefined
      ) {
        throw new Error("expected initial durable publication");
      }
      const [directInitialReread, wrappedInitialReread] = await Promise.all([
        direct.repository.readRevision(
          durableDocumentId,
          directInitialWorkspace.revisionId,
        ),
        wrapped.repository.readRevision(
          durableDocumentId,
          wrappedInitialWorkspace.revisionId,
        ),
      ]);
      expect(directInitialReread).toEqual(directInitialRevision);
      expect(wrappedInitialReread).toEqual(wrappedInitialRevision);
      expect(wrappedInitialReread).toEqual(directInitialReread);
      if (directInitialReread === null || wrappedInitialReread === null) {
        throw new Error("expected initial durable rereads");
      }
      expect(directInitialWorkspace.createdAt).toBe(101);
      expect(wrappedInitialWorkspace.createdAt).toBe(101);
      expectWorkspaceMatchesPersistedRevision(
        directInitialWorkspace,
        directInitialReread,
      );
      expectWorkspaceMatchesPersistedRevision(
        wrappedInitialWorkspace,
        wrappedInitialReread,
      );
      expect(workspaceObservable(wrappedInitialWorkspace)).toEqual(
        workspaceObservable(directInitialWorkspace),
      );
      const [directApproval, wrappedApproval] = await Promise.all([
        direct.composition.approve(),
        wrapped.composition.approve(),
      ]);
      expect(wrappedApproval).toEqual(directApproval);
      const [directStoredApproval, wrappedStoredApproval] = await Promise.all([
        direct.repository.readApproval(
          durableDocumentId,
          directApproval.revisionId,
        ),
        wrapped.repository.readApproval(
          durableDocumentId,
          wrappedApproval.revisionId,
        ),
      ]);
      expect(directStoredApproval).not.toBeNull();
      expect(wrappedStoredApproval).toEqual(directStoredApproval);

      const { actorCapability: _actorCapability, ...adapterCommand } =
        durableCommand();
      const operations = [
        {
          requestId: "dispatch",
          tool: "particle_studio.dispatch_draft_command",
          input: { command: adapterCommand },
          direct: () => direct.composition.dispatch(durableCommand()),
        },
        {
          requestId: "undo",
          tool: "particle_studio.undo",
          input: {},
          direct: () => direct.composition.undo(),
        },
        {
          requestId: "redo",
          tool: "particle_studio.redo",
          input: {},
          direct: () => direct.composition.redo(),
        },
      ] as const;

      for (const [index, operation] of operations.entries()) {
        const [directResponse, adapterResponse] = await Promise.all([
          operation.direct(),
          adapter.execute(
            adapterRequest(
              operation.tool,
              operation.input,
              operation.requestId,
            ),
          ),
        ]);
        expect(adapterResponse).toEqual({
          schemaVersion: 1,
          requestId: operation.requestId,
          result: directResponse.result,
        });
        if (!("result" in adapterResponse)) {
          throw new Error("expected adapter result");
        }
        expect(Object.keys(adapterResponse)).toEqual([
          "schemaVersion",
          "requestId",
          "result",
        ]);
        for (const privateKey of [
          "operation",
          "workspace",
          "repository",
          "service",
          "approval",
          "export",
          "assets",
          "workflow",
          "release",
          "revisionId",
          "activation",
        ]) {
          expect(adapterResponse).not.toHaveProperty(privateKey);
          expect(adapterResponse.result).not.toHaveProperty(privateKey);
        }
        const [directSnapshot, wrappedSnapshot] = await Promise.all([
          direct.composition.snapshot(),
          wrapped.composition.snapshot(),
        ]);
        expect(wrappedSnapshot).toEqual(directSnapshot);

        const directRevision =
          direct.writeCompleteRevision.mock.calls[index + 1]?.[0];
        const wrappedRevision =
          wrapped.writeCompleteRevision.mock.calls[index + 1]?.[0];
        const directWorkspace =
          direct.activateCommandWorkspace.mock.calls[index]?.[0];
        const wrappedWorkspace =
          wrapped.activateCommandWorkspace.mock.calls[index]?.[0];
        expect(directRevision).toBeDefined();
        expect(wrappedRevision).toBeDefined();
        expect(directWorkspace).toBeDefined();
        expect(wrappedWorkspace).toBeDefined();
        if (
          directRevision === undefined ||
          wrappedRevision === undefined ||
          directWorkspace === undefined ||
          wrappedWorkspace === undefined
        ) {
          throw new Error("expected durable activation boundaries");
        }
        const [directReread, wrappedReread] = await Promise.all([
          direct.repository.readRevision(
            durableDocumentId,
            directWorkspace.revisionId,
          ),
          wrapped.repository.readRevision(
            durableDocumentId,
            wrappedWorkspace.revisionId,
          ),
        ]);
        expect(directReread).toEqual(directRevision);
        expect(wrappedReread).toEqual(wrappedRevision);
        expect(wrappedReread).toEqual(directReread);
        if (directReread === null || wrappedReread === null) {
          throw new Error("expected durable activation rereads");
        }
        expect(directResponse).toEqual({
          result: {
            ok: true,
            revision: index + 1,
            document: directReread.document,
          },
        });
        expect(directSnapshot).toEqual({
          revision: index + 1,
          document: directReread.document,
        });
        expect(directWorkspace.createdAt).toBe(index + 102);
        expect(wrappedWorkspace.createdAt).toBe(index + 102);
        expectWorkspaceMatchesPersistedRevision(directWorkspace, directReread);
        expectWorkspaceMatchesPersistedRevision(
          wrappedWorkspace,
          wrappedReread,
        );
        expect(workspaceObservable(wrappedWorkspace)).toEqual(
          workspaceObservable(directWorkspace),
        );
      }

      const directRevisions = direct.writeCompleteRevision.mock.calls.map(
        ([revision]) => revision,
      );
      const wrappedRevisions = wrapped.writeCompleteRevision.mock.calls.map(
        ([revision]) => revision,
      );
      expect(directRevisions).toHaveLength(4);
      expect(wrappedRevisions).toEqual(directRevisions);
      expect(direct.activateCommandWorkspace).toHaveBeenCalledTimes(3);
      expect(wrapped.activateCommandWorkspace).toHaveBeenCalledTimes(3);
      expect(
        direct.activateCommandWorkspace.mock.calls.map(
          ([workspace]) => workspace.createdAt,
        ),
      ).toEqual([102, 103, 104]);
      expect(
        wrapped.activateCommandWorkspace.mock.calls.map(
          ([workspace]) => workspace.createdAt,
        ),
      ).toEqual([102, 103, 104]);
      expect(direct.handles).toEqual(wrapped.handles);
      expect(direct.handles).toEqual([
        { kind: "fixture-decoded-png", ordinal: 1 },
        { kind: "fixture-decoded-png", ordinal: 2 },
        { kind: "fixture-decoded-png", ordinal: 3 },
        { kind: "fixture-decoded-png", ordinal: 4 },
      ]);

      const [directBeforeReload, wrappedBeforeReload] = await Promise.all([
        direct.composition.snapshot(),
        wrapped.composition.snapshot(),
      ]);
      expect(wrappedBeforeReload).toEqual(directBeforeReload);
      expect(directBeforeReload).toEqual({
        revision: 3,
        document: directRevisions[3]?.document,
      });
      const [directReloaded, wrappedReloaded] = await Promise.all([
        direct.composition.reload(),
        wrapped.composition.reload(),
      ]);
      expect(directReloaded).not.toBeNull();
      expect(wrappedReloaded).not.toBeNull();
      if (directReloaded === null || wrappedReloaded === null) {
        throw new Error("expected durable reload workspaces");
      }
      expect(workspaceObservable(wrappedReloaded)).toEqual(
        workspaceObservable(directReloaded),
      );
      expect(directReloaded.plan.document).toEqual(
        directBeforeReload?.document,
      );
      expect(wrappedReloaded.plan.document).toEqual(
        wrappedBeforeReload?.document,
      );
      const [directAfterReload, wrappedAfterReload] = await Promise.all([
        direct.composition.snapshot(),
        wrapped.composition.snapshot(),
      ]);
      expect(wrappedAfterReload).toEqual(directAfterReload);
      expect(directAfterReload).toEqual({
        revision: 0,
        document: directBeforeReload?.document,
      });
      await expect(
        adapter.execute(
          adapterRequest(
            "particle_studio.get_draft_summary",
            {},
            "summary-after-reload",
          ),
        ),
      ).resolves.toEqual({
        schemaVersion: 1,
        requestId: "summary-after-reload",
        result: {
          ok: true,
          summary: {
            documentId: durableDocumentId,
            revision: 0,
            schemaVersion: fixtureDocument.schemaVersion,
            durationUs: fixtureDocument.durationUs,
            playbackRange: { ...fixtureDocument.playbackRange },
            loop: fixtureDocument.loop,
            elementCount: fixtureDocument.elements.length + 1,
            trackCount: fixtureDocument.tracks.length,
          },
        },
      });
      const [directUndoAfterReload, adapterUndoAfterReload] = await Promise.all(
        [
          direct.composition.undo(),
          adapter.execute(
            adapterRequest("particle_studio.undo", {}, "undo-after-reload"),
          ),
        ],
      );
      expect(adapterUndoAfterReload).toEqual({
        schemaVersion: 1,
        requestId: "undo-after-reload",
        result: directUndoAfterReload.result,
      });
      expect(directUndoAfterReload).toEqual({
        result: { ok: false, error: { code: "NOTHING_TO_UNDO" } },
      });
    } finally {
      await Promise.all([
        direct.composition.release(),
        wrapped.composition.release(),
      ]);
      await Promise.all([
        deleteIndexedDbPersistenceDatabase(direct.databaseName),
        deleteIndexedDbPersistenceDatabase(wrapped.databaseName),
      ]);
    }
  });

  it("rereads and decodes verified image bytes before activating an adapter mutation while invalidating the prior approval", async () => {
    const real = createRealDurableComposition("assets");
    const adapter = createBrowserAgentWorkspaceAdapter({
      documentId: durableDocumentId,
      snapshot: real.composition.snapshot,
      dispatch: real.composition.dispatch,
      undo: real.composition.undo,
      redo: real.composition.redo,
    });
    try {
      const verified = await real.repository.writeAsset({
        mimeType: "image/png",
        bytes: PNG_BYTES,
      });
      await real.composition.workflow({
        kind: "editable-json-import",
        editableJson: JSON.stringify(FIRST_SLICE_DOCUMENT),
      });
      const approval = await real.composition.approve();
      const approvedRevisionId = approval.revisionId;
      real.events.length = 0;
      real.readAsset.mockClear();
      real.readApproval.mockClear();
      real.decodePng.mockClear();
      real.activateCommandWorkspace.mockClear();

      const response = await adapter.execute(
        adapterRequest(
          "particle_studio.dispatch_draft_command",
          {
            command: {
              commandSchemaVersion: 1,
              commandId: "add-verified-image",
              documentId: durableDocumentId,
              expectedRevision: 0,
              payload: {
                type: "create-element",
                element: {
                  type: "image",
                  asset: {
                    sha256: verified.sha256,
                    mimeType: "image/png",
                    byteLength: PNG_BYTES.byteLength,
                    intrinsicWidth: 20,
                    intrinsicHeight: 10,
                  },
                  x: 0,
                  y: 0,
                  width: 20,
                  height: 10,
                  opacity: 1,
                },
              },
            },
          },
          "add-image",
        ),
      );

      expect(response).toEqual({
        schemaVersion: 1,
        requestId: "add-image",
        result: expect.objectContaining({ ok: true, revision: 1 }),
      });
      expect(Object.keys(response)).toEqual([
        "schemaVersion",
        "requestId",
        "result",
      ]);
      expect(real.events).toEqual(["read", "decode", "activate"]);
      expect(real.readAsset).toHaveBeenCalledOnce();
      expect(real.readAsset).toHaveBeenCalledWith(verified.sha256);
      expect(real.decodePng).toHaveBeenCalledOnce();
      expect(real.decodePng).toHaveBeenCalledWith(PNG_BYTES);
      expect(real.activateCommandWorkspace).toHaveBeenCalledOnce();
      const [activated] = real.activateCommandWorkspace.mock.calls[0]!;
      expect(activated).toMatchObject({
        documentId: real.service.current?.documentId,
        revisionId: real.service.current?.revisionId,
      });
      expect(activated.plan.document).toEqual(
        real.service.current?.plan.document,
      );
      expect(activated.images).toEqual([
        expect.objectContaining({
          sha256: verified.sha256,
          mimeType: "image/png",
          byteLength: PNG_BYTES.byteLength,
          width: 20,
          height: 10,
          handle: real.handles[0],
        }),
      ]);
      expect(activated.images[0]).not.toHaveProperty("bytes");
      expect(real.readApproval).toHaveBeenCalledOnce();
      expect(real.readApproval).toHaveBeenCalledWith(
        durableDocumentId,
        approvedRevisionId,
      );
      expect(real.service.current?.parentApprovalHash).toBe(
        approval.snapshotHash,
      );
      expect(real.service.current?.approvalInvalidationReason).toBe(
        "verified-assets",
      );
      expect(
        await real.repository.readApproval(
          durableDocumentId,
          real.service.current!.revisionId,
        ),
      ).toBeNull();
    } finally {
      await real.composition.release();
      await deleteIndexedDbPersistenceDatabase(real.databaseName);
    }
  });
});

describe("durable browser composition approved export authority", () => {
  it("delivers only a finalized browser blob with exact temporary cleanup", () => {
    const originalUrl = globalThis.URL;
    const createObjectUrl = vi.fn(() => "blob:particle-studio-export");
    const revokeObjectUrl = vi.fn();
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    vi.stubGlobal("URL", {
      createObjectURL: createObjectUrl,
      revokeObjectURL: revokeObjectUrl,
    });
    try {
      expect(deliverFinalizedHtmlForTesting).toBeTypeOf("function");
      deliverFinalizedHtmlForTesting!(new Uint8Array([1, 2, 3]));
      const anchor = anchorClick.mock.instances[0] as HTMLAnchorElement;
      expect(anchor).toMatchObject({
        href: "blob:particle-studio-export",
        download: "particle-studio.html",
        isConnected: false,
      });
      expect(revokeObjectUrl).toHaveBeenCalledWith(
        "blob:particle-studio-export",
      );
    } finally {
      anchorClick.mockRestore();
      vi.stubGlobal("URL", originalUrl);
    }
  });
  it("rereads only the current durable approval, passes the durable asset port, and returns finalized bytes", async () => {
    const { dependencies, workspace } =
      createBrowserCompositionTestDependencies();
    dependencies.service.current = workspace;
    const composition = durableBrowserCompositionFactory()!(dependencies);

    await expect(composition.exportApprovedHtml()).resolves.toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      manifest: { moduleEntry: "particle-studio.html" },
    });
    expect(dependencies.repository.readApproval).toHaveBeenCalledWith(
      workspace.documentId,
      workspace.revisionId,
    );
    expect(dependencies.buildApprovedHtml).toHaveBeenCalledWith({
      approval: expect.objectContaining({ snapshotHash: "approval-hash" }),
      assets: dependencies.repository,
    });
  });

  it("fails closed for no workspace, missing approval, or a revision changed during export", async () => {
    const noWorkspace = createBrowserCompositionTestDependencies();
    const noWorkspaceComposition = durableBrowserCompositionFactory()!(
      noWorkspace.dependencies,
    );
    await expect(noWorkspaceComposition.exportApprovedHtml()).rejects.toThrow(
      "DURABLE_EXPORT_UNAVAILABLE",
    );
    expect(noWorkspace.dependencies.buildApprovedHtml).not.toHaveBeenCalled();

    const missingApproval = createBrowserCompositionTestDependencies();
    missingApproval.dependencies.service.current = missingApproval.workspace;
    missingApproval.dependencies.repository.readApproval.mockResolvedValue(
      null,
    );
    const missingApprovalComposition = durableBrowserCompositionFactory()!(
      missingApproval.dependencies,
    );
    await expect(
      missingApprovalComposition.exportApprovedHtml(),
    ).rejects.toThrow("DURABLE_EXPORT_UNAVAILABLE");
    expect(
      missingApproval.dependencies.buildApprovedHtml,
    ).not.toHaveBeenCalled();

    const changed = createBrowserCompositionTestDependencies();
    changed.dependencies.service.current = changed.workspace;
    changed.dependencies.buildApprovedHtml.mockImplementation(async () => {
      changed.dependencies.service.current = {
        ...changed.workspace,
        revisionId: "draft-newer",
      };
      return {
        files: {
          paths: ["particle-studio.html"],
          get: () => new Uint8Array([9]),
        },
        manifest: { moduleEntry: "particle-studio.html" },
      };
    });
    const changedComposition = durableBrowserCompositionFactory()!(
      changed.dependencies,
    );
    await expect(changedComposition.exportApprovedHtml()).rejects.toThrow(
      "DURABLE_EXPORT_STALE",
    );
  });

  it("rejects a release during approved export before finalized bytes escape", async () => {
    const buildEntered = deferredValue<void>();
    const buildGate = deferredValue<{
      readonly files: {
        readonly paths: readonly string[];
        readonly get: ReturnType<typeof vi.fn>;
      };
      readonly manifest: { readonly moduleEntry: string };
    }>();
    const { dependencies, workspace } =
      createBrowserCompositionTestDependencies();
    const finalizedBytes = new Uint8Array([9, 8, 7]);
    const finalizedFiles = {
      paths: ["particle-studio.html"],
      get: vi.fn(() => finalizedBytes),
    };
    dependencies.service.current = workspace;
    dependencies.buildApprovedHtml.mockImplementation(async () => {
      buildEntered.resolve();
      return buildGate.promise;
    });
    const composition = durableBrowserCompositionFactory()!(dependencies);

    const exporting = composition.exportApprovedHtml();
    await buildEntered.promise;
    const releasing = composition.release();
    expect(dependencies.service.release).not.toHaveBeenCalled();

    buildGate.resolve({
      files: finalizedFiles,
      manifest: { moduleEntry: "particle-studio.html" },
    });
    await expect(exporting).rejects.toThrow("DURABLE_EXPORT_STALE");
    expect(finalizedFiles.get).not.toHaveBeenCalled();

    await releasing;
    await composition.release();
    expect(dependencies.service.release).toHaveBeenCalledOnce();
    expect(workspace.release).toHaveBeenCalledOnce();
  });

  it("keeps injected workflow commands unable to mint final-export authority", async () => {
    const workflow = vi.fn().mockResolvedValue({ label: "Injected draft" });
    render(<App workflow={workflow} />);

    expect(
      (
        screen.getByRole("button", {
          name: "Download approved HTML",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    cleanup();
  });
});

describe("durable browser composition authority", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps an injected workflow result visible without allowing it to activate a durable runtime", async () => {
    const workflow = vi.fn().mockResolvedValue({ label: "Forged draft" });
    render(<App workflow={workflow} />);

    fireEvent.change(screen.getByLabelText("Editable JSON"), {
      target: { value: JSON.stringify(FIRST_SLICE_DOCUMENT) },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Import editable JSON" }),
    );
    await act(async () => undefined);

    expect(workflow).toHaveBeenCalledWith({
      kind: "editable-json-import",
      editableJson: JSON.stringify(FIRST_SLICE_DOCUMENT),
    });
    expect(workflow.mock.calls[0]?.[0]).not.toHaveProperty("dispatch");
    expect(workflow.mock.calls[0]?.[0]).not.toHaveProperty("undo");
    expect(workflow.mock.calls[0]?.[0]).not.toHaveProperty("redo");
    expect(screen.getByTestId("workflow-rendered-view").textContent).toBe(
      "Forged draft",
    );
    await waitFor(() =>
      expect(screen.getByTestId("durable-rehydration-state").textContent).toBe(
        "rehydration idle",
      ),
    );
    expect(screen.getByTestId("durable-draft-state").textContent).toBe(
      "draft idle",
    );
  });

  it("keeps the default durable composition through StrictMode effect replay", async () => {
    await deleteIndexedDbPersistenceDatabase("particle-studio-editor");
    try {
      render(
        <StrictMode>
          <App />
        </StrictMode>,
      );
      fireEvent.change(screen.getByLabelText("Editable JSON"), {
        target: { value: JSON.stringify(FIRST_SLICE_DOCUMENT) },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Import editable JSON" }),
      );

      await waitFor(() => {
        expect(screen.getByRole("status").textContent).toBe(
          "Editable JSON imported.",
        );
        expect(screen.getByTestId("durable-draft-state").textContent).toBe(
          "draft active",
        );
      });
    } finally {
      cleanup();
      await Promise.resolve();
      await deleteIndexedDbPersistenceDatabase("particle-studio-editor");
    }
  });

  it("allows only a direct local click to approve a durable snapshot", async () => {
    await deleteIndexedDbPersistenceDatabase("particle-studio-editor");
    try {
      const workflow = vi.fn().mockResolvedValue({ label: "Injected draft" });
      render(<App workflow={workflow} />);
      const approval = screen.getByRole("button", {
        name: "Approve local snapshot",
      });
      expect((approval as HTMLButtonElement).disabled).toBe(true);

      fireEvent.change(screen.getByLabelText("Editable JSON"), {
        target: { value: JSON.stringify(FIRST_SLICE_DOCUMENT) },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Import editable JSON" }),
      );
      await act(async () => undefined);
      expect((approval as HTMLButtonElement).disabled).toBe(true);

      cleanup();
      render(<App />);
      fireEvent.change(screen.getByLabelText("Editable JSON"), {
        target: { value: JSON.stringify(FIRST_SLICE_DOCUMENT) },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Import editable JSON" }),
      );
      const durableApproval = screen.getByRole("button", {
        name: "Approve local snapshot",
      });
      await waitFor(() =>
        expect((durableApproval as HTMLButtonElement).disabled).toBe(false),
      );
      expect(screen.getByTestId("approval-parent-hash").textContent).toBe("");
    } finally {
      cleanup();
      await Promise.resolve();
      await deleteIndexedDbPersistenceDatabase("particle-studio-editor");
    }
  });
});
