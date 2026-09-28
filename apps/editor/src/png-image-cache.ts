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

export interface PngImageCache {
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

export function createPngImageCache(
  dependencies: PngImageCacheDependencies,
): PngImageCache {
  const entries = new Map<string, CachedPngImage>();
  const owners = new Map<unknown, number>();
  const disposed = new WeakSet<object>();
  let disposing = false;

  function disposeOnce(handle: unknown): void {
    if (!isCloseableHandle(handle) || disposed.has(handle)) return;
    disposed.add(handle);
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
    if (!owners.has(handle)) disposeOnce(handle);
  }

  return {
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
        entries.set(image.sha256, image);
        owners.set(image.handle, (owners.get(image.handle) ?? 0) + 1);
        return Object.freeze({ ...image });
      }

      if (!Object.is(image.handle, established.handle)) {
        discardUnowned(image.handle);
      }
      if (!hasExactMetadata(established, image)) {
        throw new PngImageCacheError("EDITOR_PNG_CACHE_METADATA_CONFLICT");
      }
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
        entries.delete(entry.sha256);
        release(entry.handle);
        return true;
      } catch {
        return false;
      }
    },

    clear() {
      if (disposing) return;
      const handles = [...owners.keys()];
      entries.clear();
      owners.clear();
      for (const handle of handles) disposeOnce(handle);
    },
  };
}
