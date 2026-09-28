import type { CanonicalReferencePlan, PlannedImageReference } from "./canonical-reference-plan.js";
import type { VerifiedDurablePngAsset } from "./durable-png-import.js";
import type { CachedPngImage, PngImageCache, PngImageLease } from "./png-image-cache.js";

export interface CanonicalPrehydrationDependencies {
  /** The result is untrusted until its bytes and metadata have been checked. */
  readonly rereadVerifiedPng: (sha256: string) => Promise<unknown> | unknown;
  readonly decodeVerifiedPng: (verified: VerifiedDurablePngAsset) => Promise<unknown> | unknown;
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

/** Sequential P1: stage every reference before exposing any cache-backed workspace. */
export async function prehydrateCanonicalReferences(
  plan: CanonicalReferencePlan,
  dependencies: CanonicalPrehydrationDependencies,
  cache: PngImageCache,
): Promise<CanonicalImageWorkspace> {
  const staged: CachedPngImage[] = [];
  const leases: PngImageLease[] = [];
  try {
    const snapshot = snapshotPlan(plan);
    if (typeof dependencies.rereadVerifiedPng !== "function" ||
      typeof dependencies.decodeVerifiedPng !== "function") throw failure();
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
      const lease = cache.adoptStaged(candidate);
      if (lease === null) throw failure();
      leases.push(lease);
      const reference = snapshot.references[images.length]!;
      const leased = lease.image;
      const resolved = cache.resolveImage(candidate);
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
      try { cache.disposeCandidate(candidate); } catch { /* Continue rolling back. */ }
    }
    throw failure();
  }
}
