import { describe, expect, it, vi } from "vitest";
import {
  createPngImageCache,
  type CachedPngImage,
} from "../src/png-image-cache.js";

const bytes = new Uint8Array([1, 2, 3]);
const input = () => ({ mimeType: "image/png", bytes: bytes.slice() });

function reference(sha256 = "sha-a", width = 20) {
  return {
    sha256,
    mimeType: "image/png" as const,
    byteLength: bytes.byteLength,
    width,
    height: 10,
  };
}

function candidate(handle: unknown, sha256 = "sha-a", width = 20) {
  return { ...reference(sha256, width), bytes: bytes.slice(), handle };
}

function cacheFor(candidates: Array<ReturnType<typeof candidate>>) {
  let index = 0;
  return createPngImageCache({
    importVerifiedPng: async (value) => ({
      ...reference(),
      bytes: value.bytes.slice(),
    }),
    decodeVerifiedPng: async () => candidates[index++]!,
  });
}

async function expectCacheError(pending: Promise<unknown>, code: string) {
  await expect(pending).rejects.toMatchObject({
    name: "PngImageCacheError",
    code,
    message: code,
  });
}

describe("persistent PNG image cache", () => {
  it("publishes only after decode and returns frozen defensive exact metadata", async () => {
    let release!: (image: ReturnType<typeof candidate>) => void;
    const handle = { close: vi.fn() };
    const cache = createPngImageCache({
      importVerifiedPng: async (value) => ({
        ...reference(),
        bytes: value.bytes.slice(),
      }),
      decodeVerifiedPng: async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const pending = cache.importPng(input());
    await Promise.resolve();
    expect(cache.resolveImage(reference())).toBeNull();
    release(candidate(handle));
    const imported = await pending;
    expect(Object.isFrozen(imported)).toBe(true);
    expect(cache.resolveImage(reference())).toEqual(imported);
    expect(cache.resolveImage({ ...reference(), width: 21 })).toBeNull();
    expect(cache.resolveImage({ ...reference(), byteLength: -0 })).toBeNull();
    expect(
      cache.resolveImage({
        ...reference(),
        mimeType: "image/jpeg" as "image/png",
      }),
    ).toBeNull();
  });

  it("snapshots source bytes and isolates dependencies across an await", async () => {
    const source = input();
    let release!: () => void;
    let decodedBytes: Uint8Array | undefined;
    const cache = createPngImageCache({
      importVerifiedPng: async (value) => {
        await new Promise<void>((resolve) => { release = resolve; });
        const verifiedBytes = value.bytes.slice();
        value.bytes[1] = 77;
        return { ...reference(), bytes: verifiedBytes };
      },
      decodeVerifiedPng: async (verified) => {
        decodedBytes = verified.bytes.slice();
        return candidate({});
      },
    });
    const pending = cache.importPng(source);
    source.bytes[0] = 99;
    await Promise.resolve();
    release();
    await pending;
    expect(decodedBytes).toEqual(bytes);
    expect(source.bytes[0]).toBe(99);
  });

  it("reuses duplicates, rejects conflicts and disposes only unowned identities", async () => {
    const first = { close: vi.fn() };
    const duplicate = { close: vi.fn() };
    const conflict = { close: vi.fn() };
    const cache = cacheFor([
      candidate(first),
      candidate(duplicate),
      candidate(conflict, "sha-a", 21),
    ]);
    await cache.importPng(input());
    expect((await cache.importPng(input())).handle).toBe(first);
    expect(duplicate.close).toHaveBeenCalledTimes(1);
    await expectCacheError(
      cache.importPng(input()),
      "EDITOR_PNG_CACHE_METADATA_CONFLICT",
    );
    expect(conflict.close).toHaveBeenCalledTimes(1);
    expect(cache.resolveImage(reference())?.handle).toBe(first);
    expect(cache.removeImage(reference())).toBe(true);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(cache.removeImage(reference())).toBe(false);
  });

  it("does not dispose an established handle on same-handle duplicate or conflict", async () => {
    const owned = { close: vi.fn() };
    const cache = cacheFor([
      candidate(owned),
      candidate(owned),
      candidate(owned, "sha-a", 21),
    ]);
    await cache.importPng(input());
    expect((await cache.importPng(input())).handle).toBe(owned);
    await expectCacheError(
      cache.importPng(input()),
      "EDITOR_PNG_CACHE_METADATA_CONFLICT",
    );
    expect(owned.close).not.toHaveBeenCalled();
    expect(cache.resolveImage(reference())?.handle).toBe(owned);
    cache.clear();
    expect(owned.close).toHaveBeenCalledTimes(1);
  });

  it("retains shared handles until the last owner and clears aliases once", async () => {
    const shared = { close: vi.fn() };
    const cache = cacheFor([
      candidate(shared),
      candidate(shared, "sha-b"),
    ]);
    await cache.importPng(input());
    await cache.importPng(input());
    expect(cache.removeImage(reference())).toBe(true);
    expect(shared.close).not.toHaveBeenCalled();
    cache.clear();
    cache.clear();
    expect(shared.close).toHaveBeenCalledTimes(1);
  });

  it("reserves active handles across caches without closing foreign candidates", async () => {
    const shared = { close: vi.fn() };
    const first = cacheFor([candidate(shared), candidate(shared, "sha-b")]);
    const second = cacheFor([candidate(shared), candidate(shared, "sha-c")]);
    await first.importPng(input());
    await first.importPng(input());
    await expectCacheError(second.importPng(input()), "EDITOR_PNG_CACHE_IMPORT_FAILED");
    expect(second.resolveImage(reference())).toBeNull();
    expect(shared.close).not.toHaveBeenCalled();
    expect(first.removeImage(reference())).toBe(true);
    await expectCacheError(second.importPng(input()), "EDITOR_PNG_CACHE_IMPORT_FAILED");
    expect(shared.close).not.toHaveBeenCalled();
    first.clear();
    expect(shared.close).toHaveBeenCalledTimes(1);
    await expectCacheError(second.importPng(input()), "EDITOR_PNG_CACHE_IMPORT_FAILED");
    expect(shared.close).toHaveBeenCalledTimes(1);
  });

  it("never reclaims retired identities or closes retired duplicate candidates twice", async () => {
    const retired = { close: vi.fn() };
    const first = cacheFor([candidate(retired), candidate(retired, "sha-b")]);
    await first.importPng(input());
    first.clear();
    await expectCacheError(first.importPng(input()), "EDITOR_PNG_CACHE_IMPORT_FAILED");
    const second = cacheFor([candidate(retired)]);
    await expectCacheError(second.importPng(input()), "EDITOR_PNG_CACHE_IMPORT_FAILED");
    expect(retired.close).toHaveBeenCalledTimes(1);
    const live = { close: vi.fn() };
    const duplicate = cacheFor([candidate(live), candidate(retired)]);
    await duplicate.importPng(input());
    expect((await duplicate.importPng(input())).handle).toBe(live);
    expect(retired.close).toHaveBeenCalledTimes(1);
    duplicate.clear();
  });

  it("does not close foreign duplicate or conflicting candidates", async () => {
    const foreign = { close: vi.fn() };
    const owner = cacheFor([candidate(foreign)]);
    const local = { close: vi.fn() };
    const other = cacheFor([
      candidate(local),
      candidate(foreign),
      candidate(foreign, "sha-a", 21),
    ]);
    await owner.importPng(input());
    await other.importPng(input());
    expect((await other.importPng(input())).handle).toBe(local);
    await expectCacheError(other.importPng(input()), "EDITOR_PNG_CACHE_METADATA_CONFLICT");
    expect(foreign.close).not.toHaveBeenCalled();
    other.clear();
    expect(local.close).toHaveBeenCalledTimes(1);
    owner.clear();
    expect(foreign.close).toHaveBeenCalledTimes(1);
  });

  it("keeps primitive handles usable across cache instances", async () => {
    const first = cacheFor([candidate("shared")]);
    const second = cacheFor([candidate("shared")]);
    await first.importPng(input());
    expect((await second.importPng(input())).handle).toBe("shared");
    first.clear();
    second.clear();
  });

  it("contains cross-cache reentrant claims during disposal", async () => {
    let foreign: ReturnType<typeof cacheFor>;
    let pending: Promise<unknown> | undefined;
    const shared = { close: vi.fn(() => { pending = foreign.importPng(input()); }) };
    const owner = cacheFor([candidate(shared)]);
    foreign = cacheFor([candidate(shared)]);
    await owner.importPng(input());
    owner.clear();
    await expectCacheError(pending!, "EDITOR_PNG_CACHE_IMPORT_FAILED");
    expect(shared.close).toHaveBeenCalledTimes(1);
  });

  it("contains hostile close and blocks mutation during reentrant disposal", async () => {
    let cache: ReturnType<typeof cacheFor>;
    const other = { close: vi.fn() };
    const first = {
      close: vi.fn(() => {
        expect(cache.resolveImage(reference())).toBeNull();
        expect(cache.resolveImage(reference("sha-b"))?.handle).toBe(other);
        expect(cache.removeImage(reference("sha-b"))).toBe(false);
        cache.clear();
      }),
    };
    cache = cacheFor([candidate(first), candidate(other, "sha-b")]);
    await cache.importPng(input());
    await cache.importPng(input());
    expect(cache.removeImage(reference())).toBe(true);
    expect(other.close).not.toHaveBeenCalled();

    const hostile = Object.defineProperty({}, "close", {
      get() { throw Error("private close"); },
    });
    const separate = cacheFor([candidate(hostile)]);
    await separate.importPng(input());
    expect(() => separate.clear()).not.toThrow();
  });

  it("maps hostile candidates and dependency rejection to stable errors", async () => {
    const hostile = Object.defineProperty({}, "sha256", {
      get() { throw Error("private getter"); },
    });
    const hostileCache = createPngImageCache({
      importVerifiedPng: async () => ({ ...reference(), bytes }),
      decodeVerifiedPng: async () =>
        hostile as CachedPngImage & { bytes: Uint8Array },
    });
    await expectCacheError(hostileCache.importPng(input()), "EDITOR_PNG_CACHE_IMPORT_FAILED");
    expect(hostileCache.resolveImage(reference())).toBeNull();

    for (const failing of ["import", "decode"] as const) {
      const cache = createPngImageCache({
        importVerifiedPng: async () => {
          if (failing === "import") throw Error("private importer");
          return { ...reference(), bytes };
        },
        decodeVerifiedPng: async () => { throw Error("private decoder"); },
      });
      await expectCacheError(cache.importPng(input()), "EDITOR_PNG_CACHE_IMPORT_FAILED");
    }
  });

  it.each([
    { width: 0 },
    { height: Number.NaN },
    { handle: null },
    { handle: undefined },
  ])("rejects invalid decoded candidate %j", async (invalid) => {
    const cache = createPngImageCache({
      importVerifiedPng: async () => ({ ...reference(), bytes }),
      decodeVerifiedPng: async () => ({
        ...candidate({}),
        ...invalid,
      }) as CachedPngImage & { bytes: Uint8Array },
    });
    await expectCacheError(cache.importPng(input()), "EDITOR_PNG_CACHE_IMPORT_FAILED");
    expect(cache.resolveImage(reference())).toBeNull();
  });
});
