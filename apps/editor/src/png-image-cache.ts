import type { VerifiedDurablePngAsset } from "./durable-png-import.js";
import type { VerifiedDecodedPngAsset } from "./verified-png-decode.js";

export interface CachedPngImage {
  readonly sha256: string;
  readonly mimeType: "image/png";
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly handle: unknown;
}

export interface PngImageCacheDependencies {
  readonly importVerifiedPng: (input: {
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }) => Promise<VerifiedDurablePngAsset>;
  readonly decodeVerifiedPng: (
    asset: VerifiedDurablePngAsset,
  ) => Promise<VerifiedDecodedPngAsset>;
}

export class PngImageCacheError extends Error {
  constructor(
    readonly code:
      | "EDITOR_PNG_CACHE_IMPORT_FAILED"
      | "EDITOR_PNG_CACHE_METADATA_CONFLICT",
  ) {
    super(code);
    this.name = "PngImageCacheError";
  }
}

export interface PngImageLease {
  readonly image: CachedPngImage;
  release(): void;
}

export interface PngImageCache {
  adoptStaged(candidate: unknown): PngImageLease | null;
  disposeCandidate(candidate: unknown): void;
  importPng(input: {
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<CachedPngImage>;
  resolveImage(reference: Omit<CachedPngImage, "handle">): CachedPngImage | null;
  removeImage(reference: Omit<CachedPngImage, "handle">): boolean;
  clear(): void;
}

function observeCandidate(value: unknown): CachedPngImage | null {
  if (value === null || typeof value !== "object") return null;

  try {
    const image = value as CachedPngImage;
    const sha256 = image.sha256;
    const mimeType = image.mimeType;
    const byteLength = image.byteLength;
    const width = image.width;
    const height = image.height;
    const handle = image.handle;
    if (
      typeof sha256 !== "string" ||
      mimeType !== "image/png" ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      typeof width !== "number" ||
      !Number.isFinite(width) ||
      width <= 0 ||
      typeof height !== "number" ||
      !Number.isFinite(height) ||
      height <= 0 ||
      handle === null ||
      handle === undefined
    ) {
      return null;
    }
    return Object.freeze({ sha256, mimeType, byteLength, width, height, handle });
  } catch {
    return null;
  }
}

function hasExactMetadata(
  left: CachedPngImage,
  right: Omit<CachedPngImage, "handle">,
): boolean {
  return (
    Object.is(left.sha256, right.sha256) &&
    Object.is(left.mimeType, right.mimeType) &&
    Object.is(left.byteLength, right.byteLength) &&
    Object.is(left.width, right.width) &&
    Object.is(left.height, right.height)
  );
}

function isCloseableHandle(handle: unknown): handle is object {
  return (
    (typeof handle === "object" && handle !== null) ||
    typeof handle === "function"
  );
}

const safeApply: typeof Reflect.apply = Reflect.apply;
// A closeable identity belongs to one cache until its last alias is released.
const activeHandles = new WeakMap<object, object>();
const retiredHandles = new WeakSet<object>();

export function createPngImageCache(
  dependencies: PngImageCacheDependencies,
): PngImageCache {
  const entries = new Map<string, CachedPngImage>();
  const persistent = new Set<string>();
  const leases = new Map<string, number>();
  const generations = new Map<string, object>();
  const owners = new Map<unknown, number>();
  const identity = {};
  let disposing = false;

  function canClaim(handle: unknown): boolean {
    return !isCloseableHandle(handle) ||
      (!retiredHandles.has(handle) &&
        (activeHandles.get(handle) === undefined || activeHandles.get(handle) === identity));
  }

  function claim(handle: unknown): void {
    if (isCloseableHandle(handle)) activeHandles.set(handle, identity);
    owners.set(handle, (owners.get(handle) ?? 0) + 1);
  }

  function disposeOnce(handle: unknown): void {
    if (!isCloseableHandle(handle) || retiredHandles.has(handle)) return;
    // Retire before invoking untrusted close code so reentrant imports cannot reclaim it.
    retiredHandles.add(handle);
    activeHandles.delete(handle);
    disposing = true;
    try {
      const close = (handle as { readonly close?: unknown }).close;
      // Use the captured intrinsic, not a possibly overridden method on the handle.
      if (typeof close === "function") safeApply(close, handle, []);
    } catch {
      // Never leak decoder-owned handle internals.
    } finally {
      disposing = false;
    }
  }

  function release(handle: unknown): void {
    const count = owners.get(handle);
    if (count === undefined) return;
    if (count > 1) {
      owners.set(handle, count - 1);
    } else {
      owners.delete(handle);
      disposeOnce(handle);
    }
  }

  function discardUnowned(handle: unknown): void {
    if (!owners.has(handle) && canClaim(handle)) disposeOnce(handle);
  }

  return {
    adoptStaged(candidate) {
      if (disposing) return null;
      const image = observeCandidate(candidate);
      if (image === null) return null;
      const established = entries.get(image.sha256);
      if (established !== undefined && !hasExactMetadata(established, image)) return null;
      if (established === undefined) {
        if (!canClaim(image.handle)) return null;
        claim(image.handle);
        entries.set(image.sha256, image);
        generations.set(image.sha256, {});
      } else if (!Object.is(image.handle, established.handle)) {
        discardUnowned(image.handle);
      }
      leases.set(image.sha256, (leases.get(image.sha256) ?? 0) + 1);
      const generation = generations.get(image.sha256) ?? {};
      generations.set(image.sha256, generation);
      let released = false;
      return Object.freeze({
        image: Object.freeze({ ...(established ?? image) }),
        release() {
          if (released) return;
          released = true;
          if (generations.get(image.sha256) !== generation) return;
          const count = leases.get(image.sha256);
          if (count === undefined) return;
          if (count > 1) leases.set(image.sha256, count - 1);
          else {
            leases.delete(image.sha256);
            if (!persistent.has(image.sha256)) {
              const entry = entries.get(image.sha256);
              entries.delete(image.sha256);
              generations.delete(image.sha256);
              if (entry !== undefined) release(entry.handle);
            }
          }
        },
      });
    },
    disposeCandidate(candidate) {
      if (disposing) return;
      const image = observeCandidate(candidate);
      if (image !== null) discardUnowned(image.handle);
    },
    async importPng(input) {
      if (disposing) {
        throw new PngImageCacheError("EDITOR_PNG_CACHE_IMPORT_FAILED");
      }

      let decoded: unknown;
      try {
        const mimeType = input.mimeType;
        const bytes = Uint8Array.prototype.slice.call(input.bytes);
        const verified = await dependencies.importVerifiedPng({
          mimeType,
          bytes: bytes.slice(),
        });
        decoded = await dependencies.decodeVerifiedPng(verified);
      } catch {
        throw new PngImageCacheError("EDITOR_PNG_CACHE_IMPORT_FAILED");
      }

      const image = observeCandidate(decoded);
      if (image === null) {
        throw new PngImageCacheError("EDITOR_PNG_CACHE_IMPORT_FAILED");
      }

      const established = entries.get(image.sha256);
      if (established === undefined) {
        if (!canClaim(image.handle)) {
          throw new PngImageCacheError("EDITOR_PNG_CACHE_IMPORT_FAILED");
        }
        claim(image.handle);
        entries.set(image.sha256, image);
        generations.set(image.sha256, {});
        persistent.add(image.sha256);
        return Object.freeze({ ...image });
      }

      if (!Object.is(image.handle, established.handle)) {
        discardUnowned(image.handle);
      }
      if (!hasExactMetadata(established, image)) {
        throw new PngImageCacheError("EDITOR_PNG_CACHE_METADATA_CONFLICT");
      }
      persistent.add(image.sha256);
      return Object.freeze({ ...established });
    },

    resolveImage(reference) {
      try {
        const entry = entries.get(reference.sha256);
        return entry !== undefined && hasExactMetadata(entry, reference)
          ? Object.freeze({ ...entry })
          : null;
      } catch {
        return null;
      }
    },

    removeImage(reference) {
      if (disposing) return false;
      try {
        const entry = entries.get(reference.sha256);
        if (entry === undefined || !hasExactMetadata(entry, reference)) {
          return false;
        }
        if (!persistent.delete(entry.sha256)) return false;
        if (!leases.has(entry.sha256)) {
          entries.delete(entry.sha256);
          generations.delete(entry.sha256);
          release(entry.handle);
        }
        return true;
      } catch {
        return false;
      }
    },

    clear() {
      if (disposing) return;
      const handles = [...owners.keys()];
      entries.clear();
      persistent.clear();
      leases.clear();
      generations.clear();
      owners.clear();
      for (const handle of handles) disposeOnce(handle);
    },
  };
}
