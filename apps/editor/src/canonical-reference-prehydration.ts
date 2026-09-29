import type { CanonicalReferencePlan, PlannedImageReference } from "./canonical-reference-plan.js";
import type { VerifiedDurablePngAsset } from "./durable-png-import.js";
import type { CachedPngImage, PngImageCache, PngImageLease } from "./png-image-cache.js";

export interface CanonicalPrehydrationDependencies {
  /** The result is untrusted until its bytes and metadata have been checked. */
  readonly rereadVerifiedPng: (sha256: string) => Promise<unknown> | unknown;
  readonly decodeVerifiedPng: (verified: VerifiedDurablePngAsset) => Promise<unknown> | unknown;
}

/**
 * Pre-captured cache operations for one hydration invocation, typically bound to
 * the original cache receiver. The third `cache` argument always remains the
 * tail-coordination identity; these captured values are only what the
 * operations invoke. When omitted, operations use the cache's current methods.
 */
export interface CanonicalPrehydrationCachePorts {
  readonly adoptStaged: PngImageCache["adoptStaged"];
  readonly resolveImage: PngImageCache["resolveImage"];
  readonly disposeCandidate: PngImageCache["disposeCandidate"];
}

export interface CanonicalImageWorkspace {
  readonly plan: CanonicalReferencePlan;
  readonly images: readonly CachedPngImage[];
  release(): void;
}

const failure = () => new Error("EDITOR_CANONICAL_PREHYDRATION_FAILED");
const shaPattern = /^sha256:[0-9a-f]{64}$/;

function freezeTree(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
}

function snapshotPlan(plan: CanonicalReferencePlan): {
  plan: CanonicalReferencePlan;
  references: PlannedImageReference[];
} {
  // Do not trust a caller's mutable plan across an asynchronous boundary.
  const copy = structuredClone(plan);
  if (!Array.isArray(copy.references)) throw failure();
  const seen = new Map<string, PlannedImageReference>();
  const references: PlannedImageReference[] = [];
  for (const source of copy.references) {
    if (source === null || typeof source !== "object") throw failure();
    const { elementId, sha256, mimeType, byteLength, intrinsicWidth, intrinsicHeight } = source;
    if (typeof elementId !== "string" || !shaPattern.test(sha256) ||
      mimeType !== "image/png" || !Number.isSafeInteger(byteLength) || byteLength <= 0 ||
      !Number.isFinite(intrinsicWidth) || intrinsicWidth <= 0 ||
      !Number.isFinite(intrinsicHeight) || intrinsicHeight <= 0) throw failure();
    const previous = seen.get(sha256);
    if (previous) {
      if (previous.mimeType !== mimeType || previous.byteLength !== byteLength ||
        previous.intrinsicWidth !== intrinsicWidth || previous.intrinsicHeight !== intrinsicHeight)
        throw failure();
    } else {
      const reference = Object.freeze({ elementId, sha256, mimeType, byteLength,
        intrinsicWidth, intrinsicHeight });
      references.push(reference);
      seen.set(sha256, reference);
    }
  }
  const isolatedPlan = { ...copy, references: Object.freeze(references) };
  freezeTree(isolatedPlan);
  return { plan: isolatedPlan, references };
}

function imageMatches(image: CachedPngImage, reference: PlannedImageReference, handle: unknown): boolean {
  return image.sha256 === reference.sha256 && image.mimeType === reference.mimeType &&
    Object.is(image.byteLength, reference.byteLength) &&
    Object.is(image.width, reference.intrinsicWidth) &&
    Object.is(image.height, reference.intrinsicHeight) && Object.is(image.handle, handle);
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// Each key points to the newest pending invocation; callers retain their own
// predecessors even when a later reservation replaces the registry entry.
const prehydrationTails = new WeakMap<PngImageCache, Map<string, Promise<void>>>();

function reserveTails(cache: PngImageCache, references: readonly PlannedImageReference[]) {
  let tails = prehydrationTails.get(cache);
  if (!tails) {
    tails = new Map();
    prehydrationTails.set(cache, tails);
  }
  const keys = references.map((reference) => reference.sha256);
  const predecessors = keys.flatMap((key) => {
    const previous = tails.get(key);
    return previous ? [previous] : [];
  });
  let finish!: () => void;
  const tail = new Promise<void>((resolve) => { finish = resolve; });
  // Reserve the whole plan synchronously before waiting on any predecessor.
  for (const key of keys) tails.set(key, tail);
  return {
    predecessors,
    release() {
      finish();
      for (const key of keys) {
        if (tails.get(key) === tail) tails.delete(key);
      }
      if (tails.size === 0) prehydrationTails.delete(cache);
    },
  };
}

async function verifiedAsset(value: unknown, reference: PlannedImageReference): Promise<VerifiedDurablePngAsset> {
  if (value === null || typeof value !== "object") throw failure();
  const asset = value as VerifiedDurablePngAsset;
  const { sha256, mimeType, byteLength } = asset;
  const source = asset.bytes;
  if (!(source instanceof Uint8Array)) throw failure();
  const bytes = Uint8Array.prototype.slice.call(source);
  if (sha256 !== reference.sha256 || mimeType !== reference.mimeType ||
    !Object.is(byteLength, reference.byteLength) || bytes.byteLength !== byteLength) throw failure();
  if (await hashBytes(bytes) !== reference.sha256) throw failure();
  // A decoder receives private bytes, never the source object's mutable array.
  return Object.freeze({ sha256, mimeType, byteLength, bytes });
}

/** Stage each invocation independently before exposing any cache-backed workspace. */
export async function prehydrateCanonicalReferences(
  plan: CanonicalReferencePlan,
  dependencies: CanonicalPrehydrationDependencies,
  cache: PngImageCache,
  ports: CanonicalPrehydrationCachePorts = cache,
): Promise<CanonicalImageWorkspace> {
  const staged: CachedPngImage[] = [];
  const leases: PngImageLease[] = [];
  let reservation: ReturnType<typeof reserveTails> | undefined;
  try {
    const snapshot = snapshotPlan(plan);
    if (typeof dependencies.rereadVerifiedPng !== "function" ||
      typeof dependencies.decodeVerifiedPng !== "function") throw failure();
    if (ports === null || typeof ports !== "object" ||
      typeof ports.adoptStaged !== "function" || typeof ports.resolveImage !== "function" ||
      typeof ports.disposeCandidate !== "function") throw failure();
    if (snapshot.references.length > 0) {
      reservation = reserveTails(cache, snapshot.references);
      if (reservation.predecessors.length > 0) await Promise.all(reservation.predecessors);
    }
    for (const reference of snapshot.references) {
      const verified = await verifiedAsset(await dependencies.rereadVerifiedPng(reference.sha256), reference);
      const result: unknown = await dependencies.decodeVerifiedPng(verified);
      if (result === null || typeof result !== "object") throw failure();
      const decoded = result as CachedPngImage;
      // A malformed decoded result can still hold a disposable handle. The cache
      // alone decides whether that handle is unowned; never close it directly.
      const handle = decoded.handle;
      if (handle !== null && handle !== undefined) {
        const candidate: CachedPngImage = Object.freeze({
          sha256: reference.sha256, mimeType: reference.mimeType,
          byteLength: reference.byteLength, width: reference.intrinsicWidth,
          height: reference.intrinsicHeight, handle,
        });
        staged.push(candidate);
        const decodedBytes = (result as { readonly bytes?: unknown }).bytes;
        if (!(decodedBytes instanceof Uint8Array) ||
          decodedBytes.byteLength !== reference.byteLength ||
          await hashBytes(Uint8Array.prototype.slice.call(decodedBytes)) !== reference.sha256 ||
          !imageMatches(decoded, reference, handle)) throw failure();
      } else throw failure();
    }

    const images: CachedPngImage[] = [];
    for (const candidate of staged) {
      const lease = ports.adoptStaged.call(cache, candidate);
      if (lease === null) throw failure();
      leases.push(lease);
      const reference = snapshot.references[images.length]!;
      const leased = lease.image;
      const resolved = ports.resolveImage.call(cache, candidate);
      if (resolved === null || !imageMatches(leased, reference, resolved.handle) ||
        !imageMatches(resolved, reference, leased.handle)) throw failure();
      images.push(Object.freeze({ ...resolved }));
    }
    let released = false;
    return Object.freeze({
      plan: snapshot.plan,
      images: Object.freeze(images),
      release() {
        if (released) return;
        released = true;
        for (const lease of leases) {
          try { lease.release(); } catch { /* Never expose dependency details. */ }
        }
      },
    });
  } catch {
    for (const lease of leases) {
      try { lease.release(); } catch { /* Continue rolling back. */ }
    }
    for (const candidate of staged) {
      try { ports.disposeCandidate.call(cache, candidate); } catch { /* Continue rolling back. */ }
    }
    throw failure();
  } finally {
    reservation?.release();
  }
}
