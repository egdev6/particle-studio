import { describe, expect, it, vi } from "vitest";
import { createCanonicalReferencePlan, type CanonicalReferencePlan } from "../src/canonical-reference-plan.js";
import { prehydrateCanonicalReferences } from "../src/canonical-reference-prehydration.js";
import { createPngImageCache, type PngImageCache } from "../src/png-image-cache.js";
import { FIRST_SLICE_DOCUMENT } from "@particle-studio/scene-document";

const bytesA = new Uint8Array([1, 2, 3]);
const bytesB = new Uint8Array([97, 98, 99]);
const hashA = "sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
const hashB = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function plan(hashes: string[]): CanonicalReferencePlan {
  if (hashes.length === 0) {
    const empty = createCanonicalReferencePlan(JSON.stringify(FIRST_SLICE_DOCUMENT));
    if (!empty.ok) throw new Error(empty.error.code);
    return empty.value;
  }
  const document = {
    ...FIRST_SLICE_DOCUMENT,
    rootIds: hashes.map((_, index) => `image-${index}`),
    elements: hashes.map((sha256, index) => ({
      id: `image-${index}`, type: "image" as const,
      asset: { sha256, mimeType: "image/png" as const, byteLength: 3,
        intrinsicWidth: 20, intrinsicHeight: 10 },
      x: 0, y: 0, width: 20, height: 10, opacity: 1,
    })),
    tracks: [],
  };
  const result = createCanonicalReferencePlan(JSON.stringify(document));
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function setup(overrides: {
  rereadVerifiedPng?: (sha256: string) => unknown;
  decodeVerifiedPng?: (verified: { sha256: string; bytes: Uint8Array }) => unknown;
  cache?: PngImageCache;
} = {}) {
  const handles = new Map([[hashA, { close: vi.fn() }], [hashB, { close: vi.fn() }]]);
  const rereadVerifiedPng = vi.fn(overrides.rereadVerifiedPng ?? ((sha256: string) => ({
    sha256, mimeType: "image/png", byteLength: 3,
    bytes: (sha256 === hashA ? bytesA : bytesB).slice(),
  })));
  const decodeVerifiedPng = vi.fn(overrides.decodeVerifiedPng ?? ((verified) => ({
    ...verified, width: 20, height: 10, handle: handles.get(verified.sha256),
  })));
  const cache = overrides.cache ?? createPngImageCache({
    importVerifiedPng: async () => { throw new Error("must not write"); },
    decodeVerifiedPng: async () => { throw new Error("must not import"); },
  });
  return { handles, rereadVerifiedPng, decodeVerifiedPng, cache,
    run: (input: CanonicalReferencePlan) => prehydrateCanonicalReferences(input, { rereadVerifiedPng, decodeVerifiedPng }, cache) };
}

const failure = { message: "EDITOR_CANONICAL_PREHYDRATION_FAILED" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resume) => { resolve = resume; });
  return { promise, resolve };
}

const asset = (sha256: string) => ({
  sha256, mimeType: "image/png", byteLength: 3,
  bytes: (sha256 === hashA ? bytesA : bytesB).slice(),
});

describe("canonical reference prehydration", () => {
  it("publishes an empty immutable workspace without dependencies", async () => {
    const fixture = setup();
    const workspace = await fixture.run(plan([]));
    expect(workspace.images).toEqual([]);
    expect(Object.isFrozen(workspace)).toBe(true);
    expect(Object.isFrozen(workspace.images)).toBe(true);
    expect(fixture.rereadVerifiedPng).not.toHaveBeenCalled();
    workspace.release();
    workspace.release();
  });

  it("deduplicates in plan order, resolves exact handles, and releases idempotently", async () => {
    const fixture = setup();
    const workspace = await fixture.run(plan([hashA, hashA, hashB]));
    expect(workspace.images.map((image) => image.sha256)).toEqual([hashA, hashB]);
    expect(workspace.images.map((image) => image.handle)).toEqual([
      fixture.handles.get(hashA), fixture.handles.get(hashB),
    ]);
    expect(fixture.rereadVerifiedPng).toHaveBeenCalledTimes(2);
    expect(workspace.images.every(Object.isFrozen)).toBe(true);
    workspace.release();
    workspace.release();
    expect(fixture.handles.get(hashA)?.close).toHaveBeenCalledTimes(1);
    expect(fixture.handles.get(hashB)?.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", () => null],
    ["wrong hash", () => ({ sha256: hashB, mimeType: "image/png", byteLength: 3, bytes: bytesA })],
    ["wrong MIME", () => ({ sha256: hashA, mimeType: "image/jpeg", byteLength: 3, bytes: bytesA })],
    ["wrong length", () => ({ sha256: hashA, mimeType: "image/png", byteLength: 4, bytes: bytesA })],
    ["corrupt bytes", () => ({ sha256: hashA, mimeType: "image/png", byteLength: 3, bytes: bytesB })],
    ["throwing read", () => { throw new Error("private read detail"); }],
  ])("rejects %s before decode", async (_name, rereadVerifiedPng) => {
    const fixture = setup({ rereadVerifiedPng });
    await expect(fixture.run(plan([hashA]))).rejects.toMatchObject(failure);
    expect(fixture.decodeVerifiedPng).not.toHaveBeenCalled();
  });

  it("rejects dimension mismatch and disposes decoded unowned handle", async () => {
    const handle = { close: vi.fn() };
    const fixture = setup({ decodeVerifiedPng: (verified) => ({
      ...verified, width: 21, height: 10, handle,
    }) });
    await expect(fixture.run(plan([hashA]))).rejects.toMatchObject(failure);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a throwing decoder without leaking its private error", async () => {
    const fixture = setup({ decodeVerifiedPng: () => { throw new Error("private decoder detail"); } });
    await expect(fixture.run(plan([hashA]))).rejects.toMatchObject(failure);
  });

  it("rejects corrupted decoded bytes and disposes the unowned handle", async () => {
    const handle = { close: vi.fn() };
    const fixture = setup({ decodeVerifiedPng: (verified) => ({
      ...verified, bytes: bytesB, width: 20, height: 10, handle,
    }) });
    await expect(fixture.run(plan([hashA]))).rejects.toMatchObject(failure);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("keeps foreign-owned handles open when adoption is rejected", async () => {
    const owner = setup();
    const workspace = await owner.run(plan([hashA]));
    const other = setup({ decodeVerifiedPng: (asset) => ({
      ...asset, width: 20, height: 10, handle: owner.handles.get(hashA),
    }) });
    await expect(other.run(plan([hashA]))).rejects.toMatchObject(failure);
    expect(owner.handles.get(hashA)?.close).not.toHaveBeenCalled();
    expect(owner.cache.resolveImage(workspace.images[0]!)).not.toBeNull();
    workspace.release();
    expect(owner.handles.get(hashA)?.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a cache that lies about the resolved handle and rolls back", async () => {
    const underlying = setup();
    const cache: PngImageCache = {
      ...underlying.cache,
      resolveImage: (reference) => {
        const found = underlying.cache.resolveImage(reference);
        return found && { ...found, handle: {} };
      },
    };
    const fixture = setup({ cache });
    await expect(fixture.run(plan([hashA]))).rejects.toMatchObject(failure);
    expect(fixture.handles.get(hashA)?.close).toHaveBeenCalledTimes(1);
  });

  it("releases earlier leases and disposes a rejected later candidate", async () => {
    const underlying = setup();
    let adoptions = 0;
    const cache: PngImageCache = {
      ...underlying.cache,
      adoptStaged: (candidate) => ++adoptions === 2 ? null : underlying.cache.adoptStaged(candidate),
    };
    const fixture = setup({ cache });
    await expect(fixture.run(plan([hashA, hashB]))).rejects.toMatchObject(failure);
    expect(fixture.handles.get(hashA)?.close).toHaveBeenCalledTimes(1);
    expect(fixture.handles.get(hashB)?.close).toHaveBeenCalledTimes(1);
  });

  it("snapshots plan metadata before an asynchronous reread", async () => {
    let resume!: (value: unknown) => void;
    const fixture = setup({ rereadVerifiedPng: () => new Promise((resolve) => { resume = resolve; }) });
    const input = structuredClone(plan([hashA]));
    const pending = fixture.run(input);
    (input.references[0] as { sha256: string }).sha256 = hashB;
    resume({ sha256: hashA, mimeType: "image/png", byteLength: 3, bytes: bytesA });
    const workspace = await pending;
    expect(workspace.images[0]?.sha256).toBe(hashA);
    workspace.release();
  });

  it("rolls back earlier adopted leases when a later reread fails", async () => {
    const fixture = setup({ rereadVerifiedPng: (sha256) => {
      if (sha256 === hashB) throw new Error("private");
      return { sha256, mimeType: "image/png", byteLength: 3, bytes: bytesA };
    } });
    await expect(fixture.run(plan([hashA, hashB]))).rejects.toMatchObject(failure);
    expect(fixture.cache.resolveImage({ sha256: hashA, mimeType: "image/png", byteLength: 3, width: 20, height: 10 })).toBeNull();
    expect(fixture.handles.get(hashA)?.close).toHaveBeenCalledTimes(1);
  });

  it("serializes the same cache/hash through publication without sharing a workspace", async () => {
    const firstRead = deferred<ReturnType<typeof asset>>();
    const fixture = setup({ rereadVerifiedPng: vi.fn()
      .mockImplementationOnce(() => firstRead.promise)
      .mockImplementation((sha256: string) => asset(sha256)) });
    const first = fixture.run(plan([hashA]));
    const second = fixture.run(plan([hashA]));
    try {
      expect(fixture.rereadVerifiedPng).toHaveBeenCalledTimes(1);
    } finally {
      firstRead.resolve(asset(hashA));
    }
    const one = await first;
    const two = await second;
    expect(fixture.rereadVerifiedPng).toHaveBeenCalledTimes(2);
    expect(fixture.decodeVerifiedPng).toHaveBeenCalledTimes(2);
    expect(two).not.toBe(one);
    expect(two.images).not.toBe(one.images);
    one.release();
    expect(fixture.handles.get(hashA)?.close).not.toHaveBeenCalled();
    two.release();
    expect(fixture.handles.get(hashA)?.close).toHaveBeenCalledTimes(1);
  });

  it("disposes each duplicate decoded candidate while preserving separate leases", async () => {
    const handles = [{ close: vi.fn() }, { close: vi.fn() }];
    let decoded = 0;
    const blocked = deferred<ReturnType<typeof asset>>();
    const fixture = setup({
      rereadVerifiedPng: vi.fn().mockImplementationOnce(() => blocked.promise)
        .mockImplementation((sha256: string) => asset(sha256)),
      decodeVerifiedPng: vi.fn().mockImplementation((verified) => ({
        ...verified, width: 20, height: 10, handle: handles[decoded++],
      })),
    });
    const first = fixture.run(plan([hashA]));
    const second = fixture.run(plan([hashA]));
    blocked.resolve(asset(hashA));
    const one = await first;
    const two = await second;
    expect(one.images[0]?.handle).toBe(two.images[0]?.handle);
    expect(fixture.decodeVerifiedPng).toHaveBeenCalledTimes(2);
    // The second decoded handle is not the cache's established handle.
    expect(handles[1]?.close).toHaveBeenCalledTimes(1);
    one.release();
    expect(handles[0]?.close).not.toHaveBeenCalled();
    two.release();
    expect(handles[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("lets unrelated hashes in one cache and matching hashes in another cache progress", async () => {
    const blocked = deferred<ReturnType<typeof asset>>();
    const fixture = setup({ rereadVerifiedPng: (sha256) => sha256 === hashA ? blocked.promise : asset(sha256) });
    const other = setup();
    const first = fixture.run(plan([hashA]));
    try {
      const independent = await fixture.run(plan([hashB]));
      const separateCache = await other.run(plan([hashA]));
      expect(fixture.rereadVerifiedPng).toHaveBeenCalledTimes(2);
      independent.release();
      separateCache.release();
    } finally {
      blocked.resolve(asset(hashA));
    }
    (await first).release();
  });

  it("queues multi-hash requests without a lock-order deadlock", async () => {
    const blocked = deferred<ReturnType<typeof asset>>();
    const fixture = setup({ rereadVerifiedPng: vi.fn()
      .mockImplementationOnce(() => blocked.promise)
      .mockImplementation((sha256: string) => asset(sha256)) });
    const first = fixture.run(plan([hashA, hashB]));
    const second = fixture.run(plan([hashB, hashA]));
    try {
      expect(fixture.rereadVerifiedPng).toHaveBeenCalledTimes(1);
    } finally {
      blocked.resolve(asset(hashA));
    }
    const one = await first;
    const two = await second;
    expect(fixture.rereadVerifiedPng).toHaveBeenCalledTimes(4);
    one.release();
    two.release();
  });

  it("unblocks later reservations after failure without erasing a newer tail", async () => {
    const firstRead = deferred<unknown>();
    const secondRead = deferred<ReturnType<typeof asset>>();
    const fixture = setup({ rereadVerifiedPng: vi.fn()
      .mockImplementationOnce(() => firstRead.promise)
      .mockImplementationOnce(() => secondRead.promise)
      .mockImplementation((sha256: string) => asset(sha256)) });
    const first = fixture.run(plan([hashA]));
    const second = fixture.run(plan([hashA]));
    const third = fixture.run(plan([hashA]));
    firstRead.resolve(null);
    await expect(first).rejects.toMatchObject(failure);
    // The failed first caller must not remove the second caller's reservation.
    await vi.waitFor(() => expect(fixture.rereadVerifiedPng).toHaveBeenCalledTimes(2));
    try {
      expect(fixture.rereadVerifiedPng).toHaveBeenCalledTimes(2);
    } finally {
      secondRead.resolve(asset(hashA));
    }
    const two = await second;
    const three = await third;
    expect(fixture.rereadVerifiedPng).toHaveBeenCalledTimes(3);
    two.release();
    three.release();
  });
});
