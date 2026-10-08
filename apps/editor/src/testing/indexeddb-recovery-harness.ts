import {
  CANONICALIZATION_IDENTIFIER,
  canonicalizeSceneDocument,
  FIRST_SLICE_DOCUMENT,
  type SceneDocumentV1,
  validateSceneDocument,
} from "@particle-studio/scene-document";
import {
  createCompleteRevision,
  createDraftRevisionPointer,
  createRevisionPointersSnapshot,
  createSavedRevisionPointer,
  forkApprovedDraft,
  readApprovalRecordRuntimeVersion,
  type ApprovalInvalidationReason,
  type ApprovalRecord,
  type CompleteSceneRevision,
  type PersistenceAdapterPort,
} from "@particle-studio/persistence";
import { createIndexedDbPersistenceAdapter } from "@particle-studio/persistence-indexeddb";
import { RUNTIME_VERSION } from "@particle-studio/runtime";

const DOCUMENT_ID = "chromium-document";

function revision(revisionId: string, sequence: number) {
  return createCompleteRevision({
    documentId: DOCUMENT_ID,
    revisionId,
    sequence,
    document: FIRST_SLICE_DOCUMENT,
  });
}

export async function seedIndexedDbRecoveryOffer(
  databaseName: string,
): Promise<void> {
  const repository = createIndexedDbPersistenceAdapter({ databaseName });
  const saved = revision("saved-1", 1);
  await repository.writeCompleteRevision(
    saved,
    createRevisionPointersSnapshot({
      saved: createSavedRevisionPointer(saved),
      draft: null,
    }),
  );
  await repository.writeAutosaveRevision(revision("autosave-2", 2));
}

export async function readIndexedDbRecoveryOffer(databaseName: string) {
  const repository = createIndexedDbPersistenceAdapter({ databaseName });
  const result = await repository.readRecoveryOffer(DOCUMENT_ID);
  return {
    offer:
      result.offer === null
        ? null
        : {
            kind: result.offer.kind,
            revision: {
              revisionId: result.offer.revision.revisionId,
              sequence: result.offer.revision.sequence,
            },
          },
    diagnostics: result.diagnostics,
  };
}

export interface DurablePngAssetPort {
  writeAsset(input: {
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<unknown>;
  readAsset(sha256: string): Promise<unknown>;
}

export type Sha256 = (bytes: Uint8Array) => Promise<string>;

export type DurablePngIntegrityErrorCode =
  | "EDITOR_PNG_MIME_TYPE_INVALID"
  | "EDITOR_PNG_ASSET_UNAVAILABLE"
  | "EDITOR_PNG_PERSISTENCE_WRITE_FAILED"
  | "EDITOR_PNG_PERSISTENCE_READ_FAILED"
  | "EDITOR_PNG_ASSET_VERIFICATION_FAILED"
  | "EDITOR_PNG_DECODE_FAILED";

export class DurablePngIntegrityError extends Error {
  constructor(readonly code: DurablePngIntegrityErrorCode) {
    super(code);
    this.name = "DurablePngIntegrityError";
  }
}

export interface VerifiedDurablePngAsset {
  readonly sha256: string;
  readonly mimeType: "image/png";
  readonly byteLength: number;
  readonly bytes: Uint8Array;
}

export interface VerifiedDecodedPngAsset extends VerifiedDurablePngAsset {
  readonly width: number;
  readonly height: number;
  readonly handle: unknown;
}

export interface PngDecodePrimitive {
  decodePng(bytes: Uint8Array): Promise<unknown> | unknown;
}

const PNG_MIME_TYPE = "image/png";

export interface PlannedImageReference {
  readonly elementId: string;
  readonly sha256: string;
  readonly mimeType: "image/png";
  readonly byteLength: number;
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
}

export interface CanonicalReferencePlan {
  readonly document: SceneDocumentV1;
  readonly canonicalEditableJson: string;
  readonly references: readonly PlannedImageReference[];
}

export type CanonicalReferencePlanResult =
  | { readonly ok: true; readonly value: CanonicalReferencePlan }
  | { readonly ok: false; readonly error: { readonly code: string } };

export interface CanonicalReferencePlanDependencies {
  readonly importEditableJson: typeof validateSceneDocument.importEditableJson;
  readonly exportEditableJson: typeof canonicalizeSceneDocument.exportEditableJson;
}

const canonicalReferencePlanDependencies: CanonicalReferencePlanDependencies = {
  importEditableJson: validateSceneDocument.importEditableJson,
  exportEditableJson: canonicalizeSceneDocument.exportEditableJson,
};

function freezeRecursively<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) freezeRecursively(child);
  return Object.freeze(value);
}

function copySceneDocumentForPlan(document: SceneDocumentV1): SceneDocumentV1 {
  return structuredClone(document);
}

function plannerDependencyFailure(): CanonicalReferencePlanResult {
  return freezeRecursively({
    ok: false as const,
    error: { code: "SCENE_DOCUMENT_REFERENCE_PLAN_DEPENDENCY_FAILED" },
  });
}

function matchesPlannedImageMetadata(
  left: PlannedImageReference,
  right: PlannedImageReference,
): boolean {
  return (
    Object.is(left.sha256, right.sha256) &&
    Object.is(left.mimeType, right.mimeType) &&
    Object.is(left.byteLength, right.byteLength) &&
    Object.is(left.intrinsicWidth, right.intrinsicWidth) &&
    Object.is(left.intrinsicHeight, right.intrinsicHeight)
  );
}

/**
 * Validates editable JSON before deriving the finite, schema-defined image plan.
 * It deliberately examines only `image.asset`, the sole asset reference declared by
 * SceneDocument v1, and performs no asset, cache, or decode work.
 */
export function createCanonicalReferencePlan(
  editableJson: string,
  dependencies: CanonicalReferencePlanDependencies = canonicalReferencePlanDependencies,
): CanonicalReferencePlanResult {
  let imported: unknown;
  try {
    const importEditableJson = dependencies.importEditableJson;
    if (typeof importEditableJson !== "function")
      return plannerDependencyFailure();
    imported = importEditableJson(editableJson);
  } catch {
    return plannerDependencyFailure();
  }

  try {
    if (imported === null || typeof imported !== "object") {
      return plannerDependencyFailure();
    }
    const result = imported as {
      readonly ok?: unknown;
      readonly value?: unknown;
      readonly error?: { readonly code?: unknown };
    };
    if (result.ok === false) {
      if (typeof result.error?.code === "string") {
        return result as CanonicalReferencePlanResult;
      }
      return plannerDependencyFailure();
    }
    if (
      result.ok !== true ||
      result.value === null ||
      typeof result.value !== "object"
    ) {
      return plannerDependencyFailure();
    }

    const sourceDocument = result.value as SceneDocumentV1;
    const elements = sourceDocument.elements;
    if (!Array.isArray(elements)) return plannerDependencyFailure();

    const referencesBySha256 = new Map<string, PlannedImageReference>();
    for (const element of elements) {
      if (
        element === null ||
        typeof element !== "object" ||
        typeof element.type !== "string"
      ) {
        return plannerDependencyFailure();
      }
      if (element.type !== "image") continue;
      if (
        typeof element.id !== "string" ||
        element.asset === null ||
        typeof element.asset !== "object" ||
        typeof element.asset.sha256 !== "string" ||
        element.asset.mimeType !== "image/png" ||
        !Number.isSafeInteger(element.asset.byteLength) ||
        !Number.isFinite(element.asset.intrinsicWidth) ||
        !Number.isFinite(element.asset.intrinsicHeight)
      ) {
        return plannerDependencyFailure();
      }

      const candidate: PlannedImageReference = {
        elementId: element.id,
        sha256: element.asset.sha256,
        mimeType: element.asset.mimeType,
        byteLength: element.asset.byteLength,
        intrinsicWidth: element.asset.intrinsicWidth,
        intrinsicHeight: element.asset.intrinsicHeight,
      };
      const established = referencesBySha256.get(candidate.sha256);
      if (established === undefined) {
        referencesBySha256.set(candidate.sha256, freezeRecursively(candidate));
      } else if (!matchesPlannedImageMetadata(established, candidate)) {
        return {
          ok: false,
          error: { code: "SCENE_DOCUMENT_REFERENCE_METADATA_CONFLICT" },
        };
      }
    }

    const document = freezeRecursively(
      copySceneDocumentForPlan(sourceDocument),
    );
    const exportEditableJson = dependencies.exportEditableJson;
    if (typeof exportEditableJson !== "function")
      return plannerDependencyFailure();
    const canonicalBytes = exportEditableJson(document);
    if (
      Object.prototype.toString.call(canonicalBytes) !==
        "[object Uint8Array]" ||
      Object.getPrototypeOf(canonicalBytes)?.constructor?.name !== "Uint8Array"
    ) {
      return plannerDependencyFailure();
    }
    Uint8Array.prototype.slice.call(canonicalBytes, 0, 0);
    const canonicalEditableJson = safeReflectApply(
      safeTextDecoderDecode,
      safeUtf8Decoder,
      [canonicalBytes],
    ) as string;
    const references = freezeRecursively([...referencesBySha256.values()]);

    return {
      ok: true,
      value: freezeRecursively({ document, canonicalEditableJson, references }),
    };
  } catch {
    return plannerDependencyFailure();
  }
}

type AssetRecord = {
  readonly sha256: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly bytes: Uint8Array;
};

type AssetRecordObservation =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "record"; readonly record: AssetRecord };

class VerifiedPngAsset implements VerifiedDurablePngAsset {
  readonly #bytes: Uint8Array;

  constructor(
    readonly sha256: string,
    readonly mimeType: "image/png",
    readonly byteLength: number,
    bytes: Uint8Array,
  ) {
    this.#bytes = bytes.slice();
    Object.freeze(this);
  }

  get bytes(): Uint8Array {
    return this.#bytes.slice();
  }
}

class VerifiedDecodedPng implements VerifiedDecodedPngAsset {
  readonly #bytes: Uint8Array;

  constructor(
    readonly sha256: string,
    readonly mimeType: "image/png",
    readonly byteLength: number,
    bytes: Uint8Array,
    readonly width: number,
    readonly height: number,
    readonly handle: unknown,
  ) {
    this.#bytes = bytes.slice();
    Object.freeze(this);
  }

  get bytes(): Uint8Array {
    return this.#bytes.slice();
  }
}

function observeAssetRecord(value: unknown): AssetRecordObservation {
  if (value === null || value === undefined) return { kind: "missing" };
  if (typeof value !== "object") return { kind: "invalid" };

  try {
    const record = value as AssetRecord;
    const sha256 = record.sha256;
    const mimeType = record.mimeType;
    const byteLength = record.byteLength;
    const bytes = record.bytes;
    if (
      typeof sha256 !== "string" ||
      typeof mimeType !== "string" ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      !(bytes instanceof Uint8Array)
    ) {
      return { kind: "invalid" };
    }

    return {
      kind: "record",
      record: {
        sha256,
        mimeType,
        byteLength,
        bytes: Uint8Array.prototype.slice.call(bytes),
      },
    };
  } catch {
    return { kind: "invalid" };
  }
}

function observedPersistenceCode(cause: unknown): string | undefined {
  if (
    cause === null ||
    (typeof cause !== "object" && typeof cause !== "function")
  ) {
    return undefined;
  }

  try {
    const code = (cause as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

function persistenceFailure(
  code:
    | "EDITOR_PNG_PERSISTENCE_WRITE_FAILED"
    | "EDITOR_PNG_PERSISTENCE_READ_FAILED",
  cause: unknown,
): DurablePngIntegrityError {
  const observedCode = observedPersistenceCode(cause);
  return new DurablePngIntegrityError(
    observedCode === code ? observedCode : code,
  );
}

function verificationFailure(): never {
  throw new DurablePngIntegrityError("EDITOR_PNG_ASSET_VERIFICATION_FAILED");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function unavailableAsset(): never {
  throw new DurablePngIntegrityError("EDITOR_PNG_ASSET_UNAVAILABLE");
}

/**
 * Writes a caller-supplied PNG through the content-addressed asset port, then
 * verifies the durable record against isolated input bytes before returning it.
 */
type DecodedPngObservation =
  | { readonly kind: "invalid" }
  | {
      readonly kind: "decoded";
      readonly width: number;
      readonly height: number;
      readonly handle: unknown;
    };

function isPositiveFiniteDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function observeDecodedPng(value: unknown): DecodedPngObservation {
  if (value === null || typeof value !== "object") {
    return { kind: "invalid" };
  }

  try {
    const decoded = value as {
      readonly width: unknown;
      readonly height: unknown;
      readonly handle: unknown;
    };
    const width = decoded.width;
    const height = decoded.height;
    const handle = decoded.handle;
    if (
      !isPositiveFiniteDimension(width) ||
      !isPositiveFiniteDimension(height) ||
      handle === null ||
      handle === undefined
    ) {
      return { kind: "invalid" };
    }

    return { kind: "decoded", width, height, handle };
  } catch {
    return { kind: "invalid" };
  }
}

function decodeFailure(): never {
  throw new DurablePngIntegrityError("EDITOR_PNG_DECODE_FAILED");
}

/**
 * Decodes verified PNG bytes through an injected primitive without exposing the
 * immutable asset's bytes to decoder mutation.
 */
export async function decodeVerifiedPngAsset(
  asset: VerifiedDurablePngAsset,
  dependencies: PngDecodePrimitive,
): Promise<VerifiedDecodedPngAsset> {
  const sha256 = asset.sha256;
  const mimeType = asset.mimeType;
  const byteLength = asset.byteLength;
  const verifiedBytes = asset.bytes.slice();
  let decoded: unknown;
  try {
    decoded = await dependencies.decodePng(verifiedBytes.slice());
  } catch {
    decodeFailure();
  }

  const observation = observeDecodedPng(decoded);
  if (observation.kind === "invalid") decodeFailure();

  return new VerifiedDecodedPng(
    sha256,
    mimeType,
    byteLength,
    verifiedBytes,
    observation.width,
    observation.height,
    observation.handle,
  );
}

export async function importDurablePngAsset(
  input: { readonly mimeType: string; readonly bytes: Uint8Array },
  dependencies: {
    readonly assets: DurablePngAssetPort;
    readonly sha256: Sha256;
  },
): Promise<VerifiedDurablePngAsset> {
  if (input.mimeType !== PNG_MIME_TYPE) {
    throw new DurablePngIntegrityError("EDITOR_PNG_MIME_TYPE_INVALID");
  }

  const acceptedBytes = input.bytes.slice();
  let written: unknown;
  try {
    written = await dependencies.assets.writeAsset({
      mimeType: PNG_MIME_TYPE,
      bytes: acceptedBytes.slice(),
    });
  } catch (cause) {
    throw persistenceFailure("EDITOR_PNG_PERSISTENCE_WRITE_FAILED", cause);
  }
  const writtenObservation = observeAssetRecord(written);
  if (writtenObservation.kind === "missing") unavailableAsset();
  if (writtenObservation.kind === "invalid") verificationFailure();
  const writtenRecord = writtenObservation.record;

  let reread: unknown;
  try {
    reread = await dependencies.assets.readAsset(writtenRecord.sha256);
  } catch (cause) {
    throw persistenceFailure("EDITOR_PNG_PERSISTENCE_READ_FAILED", cause);
  }
  const rereadObservation = observeAssetRecord(reread);
  if (rereadObservation.kind === "missing") unavailableAsset();
  if (rereadObservation.kind === "invalid") verificationFailure();
  const rereadRecord = rereadObservation.record;

  const writtenBytes = writtenRecord.bytes;
  const rereadBytes = rereadRecord.bytes;
  let acceptedSha256: string;
  let rereadSha256: string;
  try {
    acceptedSha256 = await dependencies.sha256(acceptedBytes.slice());
    rereadSha256 = await dependencies.sha256(rereadBytes.slice());
  } catch {
    throw new DurablePngIntegrityError("EDITOR_PNG_ASSET_VERIFICATION_FAILED");
  }

  if (
    writtenRecord.sha256 !== acceptedSha256 ||
    rereadRecord.sha256 !== acceptedSha256 ||
    rereadSha256 !== acceptedSha256 ||
    writtenRecord.mimeType !== PNG_MIME_TYPE ||
    rereadRecord.mimeType !== PNG_MIME_TYPE ||
    writtenRecord.byteLength !== acceptedBytes.byteLength ||
    rereadRecord.byteLength !== acceptedBytes.byteLength ||
    !sameBytes(writtenBytes, acceptedBytes) ||
    !sameBytes(rereadBytes, acceptedBytes)
  ) {
    throw new DurablePngIntegrityError("EDITOR_PNG_ASSET_VERIFICATION_FAILED");
  }

  return new VerifiedPngAsset(
    acceptedSha256,
    PNG_MIME_TYPE,
    acceptedBytes.byteLength,
    rereadBytes,
  );
}

export type PngImageCacheErrorCode =
  | "EDITOR_PNG_CACHE_IMPORT_FAILED"
  | "EDITOR_PNG_CACHE_METADATA_CONFLICT";

export class PngImageCacheError extends Error {
  constructor(readonly code: PngImageCacheErrorCode) {
    super(code);
    this.name = "PngImageCacheError";
  }
}

export interface CachedPngImage {
  readonly sha256: string;
  readonly mimeType: "image/png";
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly handle: unknown;
}

export interface PngImageCacheStagedEntry {
  readonly sha256: string;
  readonly mimeType: "image/png";
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly handle: unknown;
}

export interface PngImageCacheLease {
  readonly image: CachedPngImage;
  readonly candidateAccepted: boolean;
  release(): void;
}

export interface PngImageCacheCandidateDisposition {
  dispose(): void;
}

export type PngImageCacheStagedAdoption = Readonly<{
  status: "inserted" | "reused" | "conflict" | "invalid";
  candidateAccepted: boolean;
  candidateDisposition: PngImageCacheCandidateDisposition | null;
  lease: PngImageCacheLease | null;
}>;

export interface PngImageCache {
  importPng(input: {
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<CachedPngImage>;
  acquireStagedPng(
    input: PngImageCacheStagedEntry,
  ): PngImageCacheStagedAdoption;
  resolveImage(
    reference: Omit<CachedPngImage, "handle">,
  ): CachedPngImage | null;
  removeImage(reference: Omit<CachedPngImage, "handle">): boolean;
  clear(): void;
  isDisposing(): boolean;
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

type CachedPngImageEntry = {
  readonly image: CachedPngImage;
  persistent: boolean;
  leaseCount: number;
};

function isExactPngMetadata(
  left: Omit<CachedPngImage, "handle">,
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

function observeCachedPngImage(value: unknown): CachedPngImage | null {
  if (value === null || typeof value !== "object") return null;

  try {
    const image = value as CachedPngImage;
    const snapshot = {
      sha256: image.sha256,
      mimeType: image.mimeType,
      byteLength: image.byteLength,
      width: image.width,
      height: image.height,
      handle: image.handle,
    };
    if (
      typeof snapshot.sha256 !== "string" ||
      snapshot.mimeType !== PNG_MIME_TYPE ||
      !Number.isSafeInteger(snapshot.byteLength) ||
      snapshot.byteLength < 0 ||
      !isPositiveFiniteDimension(snapshot.width) ||
      !isPositiveFiniteDimension(snapshot.height) ||
      snapshot.handle === null ||
      snapshot.handle === undefined
    ) {
      return null;
    }

    return Object.freeze({
      ...snapshot,
      mimeType: PNG_MIME_TYPE,
    });
  } catch {
    return null;
  }
}

function copyCachedPngImage(image: CachedPngImage): CachedPngImage {
  return Object.freeze({ ...image });
}

function isCloseableHandle(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

class InMemoryPngImageCache implements PngImageCache {
  readonly #entries = new Map<string, CachedPngImageEntry>();
  readonly #ownershipCounts = new Map<unknown, number>();
  readonly #disposedHandles = new WeakSet<object>();
  #activeDisposals = 0;
  readonly #dependencies: PngImageCacheDependencies;

  constructor(dependencies: PngImageCacheDependencies) {
    this.#dependencies = dependencies;
  }

  #claim(handle: unknown): void {
    this.#ownershipCounts.set(
      handle,
      (this.#ownershipCounts.get(handle) ?? 0) + 1,
    );
  }

  #disposeOnce(handle: unknown): void {
    if (!isCloseableHandle(handle)) return;
    try {
      if (this.#disposedHandles.has(handle)) return;
      this.#disposedHandles.add(handle);
    } catch {
      return;
    }

    this.#activeDisposals += 1;
    try {
      const close = (handle as { readonly close?: unknown }).close;
      if (typeof close === "function") safeReflectApply(close, handle, []);
    } catch {
      // Decoder-owned handles cannot expose private disposal failures to callers.
    } finally {
      this.#activeDisposals -= 1;
    }
  }

  #release(handle: unknown): void {
    const ownerCount = this.#ownershipCounts.get(handle);
    if (ownerCount === undefined) return;
    if (ownerCount > 1) {
      this.#ownershipCounts.set(handle, ownerCount - 1);
      return;
    }
    this.#ownershipCounts.delete(handle);
    this.#disposeOnce(handle);
  }

  #discardCandidate(handle: unknown): void {
    if (!this.#ownershipCounts.has(handle)) this.#disposeOnce(handle);
  }

  #releaseLease(entry: CachedPngImageEntry): void {
    if (entry.leaseCount === 0) return;
    entry.leaseCount -= 1;
    if (entry.leaseCount === 0 && !entry.persistent) {
      this.#entries.delete(entry.image.sha256);
      this.#release(entry.image.handle);
    }
  }

  #lease(
    entry: CachedPngImageEntry,
    candidateAccepted: boolean,
  ): PngImageCacheLease {
    let released = false;
    const image = copyCachedPngImage(entry.image);
    return Object.freeze({
      image,
      candidateAccepted,
      release: () => {
        if (released) return;
        released = true;
        if (this.#entries.get(entry.image.sha256) !== entry) return;
        this.#releaseLease(entry);
      },
    });
  }

  #candidateDisposition(handle: unknown): PngImageCacheCandidateDisposition {
    let disposed = false;
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const cacheOwnsHandle = this.#ownershipCounts.has(handle);
        retireStagedHandleIdentity(handle);
        if (!cacheOwnsHandle) this.#disposeOnce(handle);
      },
    });
  }

  #adoption(
    status: PngImageCacheStagedAdoption["status"],
    candidateAccepted: boolean,
    candidateDisposition: PngImageCacheCandidateDisposition | null,
    lease: PngImageCacheLease | null,
  ): PngImageCacheStagedAdoption {
    return Object.freeze({
      status,
      candidateAccepted,
      candidateDisposition,
      lease,
    });
  }

  acquireStagedPng(
    input: PngImageCacheStagedEntry,
  ): PngImageCacheStagedAdoption {
    if (this.#activeDisposals > 0)
      return this.#adoption("invalid", false, null, null);

    const candidate = observeCachedPngImage(input);
    if (candidate === null) return this.#adoption("invalid", false, null, null);
    const candidateDisposition = this.#candidateDisposition(candidate.handle);

    const established = this.#entries.get(candidate.sha256);
    if (established === undefined) {
      const entry: CachedPngImageEntry = {
        image: candidate,
        persistent: false,
        leaseCount: 1,
      };
      this.#entries.set(candidate.sha256, entry);
      this.#claim(candidate.handle);
      return this.#adoption(
        "inserted",
        true,
        candidateDisposition,
        this.#lease(entry, true),
      );
    }
    if (!isExactPngMetadata(established.image, candidate)) {
      return this.#adoption("conflict", false, candidateDisposition, null);
    }

    established.leaseCount += 1;
    const candidateAccepted = Object.is(
      established.image.handle,
      candidate.handle,
    );
    return this.#adoption(
      "reused",
      candidateAccepted,
      candidateDisposition,
      this.#lease(established, candidateAccepted),
    );
  }

  async importPng(input: {
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<CachedPngImage> {
    if (this.#activeDisposals > 0) {
      throw new PngImageCacheError("EDITOR_PNG_CACHE_IMPORT_FAILED");
    }

    let decoded: unknown;
    try {
      const isolatedInput = {
        mimeType: input.mimeType,
        bytes: Uint8Array.prototype.slice.call(input.bytes),
      };
      const verified = await this.#dependencies.importVerifiedPng({
        mimeType: isolatedInput.mimeType,
        bytes: Uint8Array.prototype.slice.call(isolatedInput.bytes),
      });
      decoded = await this.#dependencies.decodeVerifiedPng(verified);
    } catch {
      throw new PngImageCacheError("EDITOR_PNG_CACHE_IMPORT_FAILED");
    }

    const candidate = observeCachedPngImage(decoded);
    if (candidate === null) {
      throw new PngImageCacheError("EDITOR_PNG_CACHE_IMPORT_FAILED");
    }

    const established = this.#entries.get(candidate.sha256);
    if (established === undefined) {
      this.#entries.set(candidate.sha256, {
        image: candidate,
        persistent: true,
        leaseCount: 0,
      });
      this.#claim(candidate.handle);
      return copyCachedPngImage(candidate);
    }
    if (isExactPngMetadata(established.image, candidate)) {
      established.persistent = true;
      if (!Object.is(established.image.handle, candidate.handle)) {
        this.#discardCandidate(candidate.handle);
      }
      return copyCachedPngImage(established.image);
    }
    if (!Object.is(established.image.handle, candidate.handle)) {
      this.#discardCandidate(candidate.handle);
    }
    throw new PngImageCacheError("EDITOR_PNG_CACHE_METADATA_CONFLICT");
  }

  resolveImage(
    reference: Omit<CachedPngImage, "handle">,
  ): CachedPngImage | null {
    try {
      const entry = this.#entries.get(reference.sha256);
      return entry !== undefined && isExactPngMetadata(entry.image, reference)
        ? copyCachedPngImage(entry.image)
        : null;
    } catch {
      return null;
    }
  }

  removeImage(reference: Omit<CachedPngImage, "handle">): boolean {
    if (this.#activeDisposals > 0) return false;
    try {
      const entry = this.#entries.get(reference.sha256);
      if (
        entry === undefined ||
        !entry.persistent ||
        !isExactPngMetadata(entry.image, reference)
      ) {
        return false;
      }
      entry.persistent = false;
      if (entry.leaseCount === 0) {
        this.#entries.delete(entry.image.sha256);
        this.#release(entry.image.handle);
      }
      return true;
    } catch {
      return false;
    }
  }

  clear(): void {
    if (this.#activeDisposals > 0) return;
    const handles = new Set<unknown>();
    for (const entry of this.#entries.values()) handles.add(entry.image.handle);
    this.#entries.clear();
    this.#ownershipCounts.clear();
    for (const handle of handles) this.#disposeOnce(handle);
  }

  isDisposing(): boolean {
    return this.#activeDisposals > 0;
  }
}

export function createPngImageCache(
  dependencies: PngImageCacheDependencies,
): PngImageCache {
  return new InMemoryPngImageCache(dependencies);
}

export class VerifiedAssetStagingError extends Error {
  readonly code!: "EDITOR_VERIFIED_ASSET_STAGING_FAILED";

  constructor() {
    super("EDITOR_VERIFIED_ASSET_STAGING_FAILED");
    Object.defineProperties(this, {
      name: { value: "VerifiedAssetStagingError" },
      code: { value: "EDITOR_VERIFIED_ASSET_STAGING_FAILED" },
      message: { value: "EDITOR_VERIFIED_ASSET_STAGING_FAILED" },
      stack: { value: undefined },
      cause: { value: undefined },
    });
    Object.freeze(this);
  }
}

export interface StagedVerifiedAsset {
  readonly reference: PlannedImageReference;
  readonly sha256: string;
  readonly mimeType: "image/png";
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
  readonly handle: unknown;
}

export interface StagedCanonicalReferenceBatch {
  readonly plan: CanonicalReferencePlan;
  readonly entries: readonly StagedVerifiedAsset[];
  release(): void;
  claim(): readonly StagedVerifiedAsset[];
}

export interface VerifiedAssetStagingDependencies {
  readonly rereadVerifiedPng: (
    sha256: string,
  ) => Promise<VerifiedDurablePngAsset>;
  readonly decodeVerifiedPng: (
    asset: VerifiedDurablePngAsset,
  ) => Promise<VerifiedDecodedPngAsset>;
}

function stagingFailure(): VerifiedAssetStagingError {
  return new VerifiedAssetStagingError();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidStagingReference(
  value: unknown,
): value is PlannedImageReference {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (
    keys.join(",") !==
    "byteLength,elementId,intrinsicHeight,intrinsicWidth,mimeType,sha256"
  ) {
    return false;
  }
  return (
    typeof value.elementId === "string" &&
    /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value.elementId) &&
    typeof value.sha256 === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(value.sha256) &&
    value.mimeType === PNG_MIME_TYPE &&
    isPositiveSafeInteger(value.byteLength) &&
    isPositiveSafeInteger(value.intrinsicWidth) &&
    isPositiveSafeInteger(value.intrinsicHeight)
  );
}

function snapshotStagingPlan(
  plan: CanonicalReferencePlan,
): CanonicalReferencePlan {
  const snapshot = structuredClone(plan) as unknown;
  if (!isPlainRecord(snapshot)) throw stagingFailure();
  const { document, canonicalEditableJson, references } = snapshot;
  if (!isPlainRecord(document) || typeof canonicalEditableJson !== "string") {
    throw stagingFailure();
  }
  if (
    !Array.isArray(references) ||
    !references.every(isValidStagingReference)
  ) {
    throw stagingFailure();
  }
  const verifiedReferences = safeReflectApply(safeArrayMap, references, [
    (reference: PlannedImageReference) => Object.freeze({ ...reference }),
  ]) as PlannedImageReference[];
  return freezeRecursively({
    document: document as SceneDocumentV1,
    canonicalEditableJson,
    references: verifiedReferences,
  });
}

function copyGenuineUint8Array(value: unknown): Uint8Array | null {
  try {
    if (
      !ArrayBuffer.isView(value) ||
      Object.prototype.toString.call(value) !== "[object Uint8Array]"
    ) {
      return null;
    }
    const copied = Uint8Array.prototype.slice.call(value);
    return Object.prototype.toString.call(copied) === "[object Uint8Array]"
      ? new Uint8Array(copied)
      : null;
  } catch {
    return null;
  }
}

function isolatedRereadAsset(
  sha256: string,
  byteLength: number,
  bytes: Uint8Array,
): VerifiedDurablePngAsset {
  const isolatedBytes = bytes.slice();
  return Object.freeze({
    sha256,
    mimeType: PNG_MIME_TYPE,
    byteLength,
    get bytes() {
      return isolatedBytes.slice();
    },
  });
}

function observeRereadAsset(
  reference: PlannedImageReference,
  value: unknown,
): VerifiedDurablePngAsset | null {
  if (value === null || typeof value !== "object") return null;
  try {
    const asset = value as VerifiedDurablePngAsset;
    const sha256 = asset.sha256;
    const mimeType = asset.mimeType;
    const byteLength = asset.byteLength;
    const bytes = copyGenuineUint8Array(asset.bytes);
    if (
      !Object.is(reference.sha256, sha256) ||
      !Object.is(reference.mimeType, mimeType) ||
      !Object.is(reference.byteLength, byteLength) ||
      bytes === null ||
      bytes.byteLength !== reference.byteLength
    ) {
      return null;
    }
    return isolatedRereadAsset(sha256, byteLength, bytes);
  } catch {
    return null;
  }
}

const safeArrayPush = Array.prototype.push;
const safeArrayMap = Array.prototype.map;
const safeReflectApply = Reflect.apply;
const activeStagedHandleIdentities = new WeakSet<object>();
const retiredStagedHandleIdentities = new WeakSet<object>();

function reserveStagedHandleIdentity(handle: unknown): boolean {
  if (!isCloseableHandle(handle)) return true;
  try {
    if (
      activeStagedHandleIdentities.has(handle) ||
      retiredStagedHandleIdentities.has(handle)
    ) {
      return false;
    }
    activeStagedHandleIdentities.add(handle);
    return true;
  } catch {
    return false;
  }
}

function retireStagedHandleIdentity(handle: unknown): boolean {
  if (!isCloseableHandle(handle)) return true;
  try {
    activeStagedHandleIdentities.delete(handle);
    retiredStagedHandleIdentities.add(handle);
    return true;
  } catch {
    return false;
  }
}

function releaseStagedHandles(
  handles: readonly unknown[],
  closed: WeakSet<object>,
): void {
  for (let index = handles.length - 1; index >= 0; index -= 1) {
    const handle = handles[index];
    if (!isCloseableHandle(handle)) continue;
    try {
      if (closed.has(handle)) continue;
      closed.add(handle);
      if (!retireStagedHandleIdentity(handle)) continue;
      const close = (handle as { readonly close?: unknown }).close;
      if (typeof close === "function") safeReflectApply(close, handle, []);
    } catch {
      // Decoder-owned handles cannot expose private disposal failures to callers.
    }
  }
}

function stageEntry(
  reference: PlannedImageReference,
  decoded: unknown,
  sourceBytes: Uint8Array,
  handles: unknown[],
): StagedVerifiedAsset {
  if (decoded === null || typeof decoded !== "object") throw stagingFailure();
  try {
    const value = decoded as VerifiedDecodedPngAsset;
    const handle = value.handle;
    if (
      handle === null ||
      handle === undefined ||
      !reserveStagedHandleIdentity(handle)
    ) {
      throw stagingFailure();
    }
    try {
      safeReflectApply(safeArrayPush, handles, [handle]);
    } catch {
      releaseStagedHandles([handle], new WeakSet<object>());
      throw stagingFailure();
    }
    const sha256 = value.sha256;

    const mimeType = value.mimeType;
    const byteLength = value.byteLength;
    const width = value.width;
    const height = value.height;
    const bytes = copyGenuineUint8Array(value.bytes);
    if (
      !Object.is(reference.sha256, sha256) ||
      !Object.is(reference.mimeType, mimeType) ||
      !Object.is(reference.byteLength, byteLength) ||
      !Object.is(reference.intrinsicWidth, width) ||
      !Object.is(reference.intrinsicHeight, height) ||
      bytes === null ||
      !sameBytes(bytes, sourceBytes) ||
      handle === null ||
      handle === undefined
    ) {
      throw stagingFailure();
    }
    const isolatedBytes = sourceBytes.slice();
    return Object.freeze({
      reference,
      sha256,
      mimeType,
      byteLength,
      width,
      height,
      get bytes() {
        return isolatedBytes.slice();
      },
      handle,
    });
  } catch {
    throw stagingFailure();
  }
}

function stagedBatch(
  plan: CanonicalReferencePlan,
  entries: readonly StagedVerifiedAsset[],
  handles: readonly unknown[],
  closed: WeakSet<object>,
): StagedCanonicalReferenceBatch {
  let ownsHandles = true;
  let claimed = false;
  const frozenEntries = Object.freeze([...entries]);
  return Object.freeze({
    plan,
    entries: frozenEntries,
    release() {
      if (!ownsHandles) return;
      ownsHandles = false;
      releaseStagedHandles(handles, closed);
    },
    claim() {
      if (!ownsHandles || claimed) throw stagingFailure();
      claimed = true;
      ownsHandles = false;
      return frozenEntries;
    },
  });
}

/** Stages an accepted plan without publishing cache or workspace state. */
export async function stageCanonicalReferencePlan(
  plan: CanonicalReferencePlan,
  dependencies: VerifiedAssetStagingDependencies,
): Promise<StagedCanonicalReferenceBatch> {
  let snapshot: CanonicalReferencePlan;
  try {
    snapshot = snapshotStagingPlan(plan);
  } catch {
    throw stagingFailure();
  }
  if (snapshot.references.length === 0) {
    return stagedBatch(snapshot, [], [], new WeakSet<object>());
  }

  const handles: unknown[] = [];
  const closed = new WeakSet<object>();
  try {
    const { rereadVerifiedPng, decodeVerifiedPng } = dependencies;
    if (
      typeof rereadVerifiedPng !== "function" ||
      typeof decodeVerifiedPng !== "function"
    ) {
      throw stagingFailure();
    }
    const entries: StagedVerifiedAsset[] = [];
    for (const reference of snapshot.references) {
      const verified = observeRereadAsset(
        reference,
        await rereadVerifiedPng(reference.sha256),
      );
      if (verified === null) throw stagingFailure();
      entries.push(
        stageEntry(
          reference,
          await decodeVerifiedPng(verified),
          verified.bytes,
          handles,
        ),
      );
    }
    return stagedBatch(snapshot, entries, handles, closed);
  } catch {
    releaseStagedHandles(handles, closed);
    throw stagingFailure();
  }
}

export class WorkspacePublicationError extends Error {
  readonly code!: "EDITOR_WORKSPACE_PUBLICATION_FAILED";

  constructor() {
    super("EDITOR_WORKSPACE_PUBLICATION_FAILED");
    Object.defineProperties(this, {
      name: { value: "WorkspacePublicationError" },
      code: { value: "EDITOR_WORKSPACE_PUBLICATION_FAILED" },
      message: { value: "EDITOR_WORKSPACE_PUBLICATION_FAILED" },
      stack: { value: undefined },
      cause: { value: undefined },
    });
    Object.freeze(this);
  }
}

export interface PublishedCanonicalImageWorkspace {
  readonly plan: CanonicalReferencePlan;
  readonly images: readonly CachedPngImage[];
  release(): void;
}

function workspacePublicationFailure(): WorkspacePublicationError {
  return new WorkspacePublicationError();
}

function acquireWorkspaceLease(
  cache: PngImageCache,
  entry: StagedVerifiedAsset,
): PngImageCacheLease {
  const adoption = cache.acquireStagedPng(entry);
  try {
    if (
      (adoption.status !== "inserted" && adoption.status !== "reused") ||
      adoption.lease === null
    ) {
      throw workspacePublicationFailure();
    }
    return adoption.lease;
  } finally {
    const disposition = adoption.candidateDisposition;
    if (disposition === null || typeof disposition.dispose !== "function") {
      throw workspacePublicationFailure();
    }
    disposition.dispose();
  }
}

function releaseWorkspaceLeases(leases: readonly PngImageCacheLease[]): void {
  for (let index = leases.length - 1; index >= 0; index -= 1) {
    try {
      leases[index]!.release();
    } catch {
      // Cache-owned release failures cannot expose private dependency details.
    }
  }
}

function isExactWorkspaceImage(
  entry: StagedVerifiedAsset,
  leaseImage: CachedPngImage,
  resolvedImage: CachedPngImage | null,
): resolvedImage is CachedPngImage {
  return (
    resolvedImage !== null &&
    isExactPngMetadata(entry, leaseImage) &&
    isExactPngMetadata(leaseImage, resolvedImage) &&
    Object.is(leaseImage.handle, resolvedImage.handle)
  );
}

/**
 * Claims one staged batch and exposes its image workspace only after every cache
 * lease resolves to the exact metadata selected by the staged canonical plan.
 */
export function publishStagedCanonicalReferenceBatch(
  batch: StagedCanonicalReferenceBatch,
  cache: PngImageCache,
): PublishedCanonicalImageWorkspace {
  try {
    if (safeReflectApply(cache.isDisposing, cache, [])) {
      throw workspacePublicationFailure();
    }
  } catch {
    throw workspacePublicationFailure();
  }

  let entries: readonly StagedVerifiedAsset[];
  try {
    entries = batch.claim();
  } catch {
    throw workspacePublicationFailure();
  }

  const leases: PngImageCacheLease[] = [];
  const images: CachedPngImage[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    try {
      const lease = acquireWorkspaceLease(cache, entries[index]!);
      safeReflectApply(safeArrayPush, leases, [lease]);
      const resolved = cache.resolveImage(lease.image);
      if (!isExactWorkspaceImage(entries[index]!, lease.image, resolved)) {
        throw workspacePublicationFailure();
      }
      safeReflectApply(safeArrayPush, images, [copyCachedPngImage(resolved)]);
    } catch {
      for (let pending = index + 1; pending < entries.length; pending += 1) {
        try {
          safeReflectApply(safeArrayPush, leases, [
            acquireWorkspaceLease(cache, entries[pending]!),
          ]);
        } catch {
          // Cache authority disposes any candidate it can observe.
        }
      }
      releaseWorkspaceLeases(leases);
      throw workspacePublicationFailure();
    }
  }

  try {
    const plan = freezeRecursively(structuredClone(batch.plan));
    const orderedImages = Object.freeze(
      safeReflectApply(safeArrayMap, images, [copyCachedPngImage]),
    );
    let released = false;
    return Object.freeze({
      plan,
      images: orderedImages,
      release() {
        if (released) return;
        released = true;
        releaseWorkspaceLeases(leases);
      },
    });
  } catch {
    releaseWorkspaceLeases(leases);
    throw workspacePublicationFailure();
  }
}

export interface CoordinatedCanonicalReferencePrehydrationDependencies
  extends VerifiedAssetStagingDependencies {
  readonly cache: PngImageCache;
}

const safeMapGet = Map.prototype.get;
const safeMapSet = Map.prototype.set;
const safeMapDelete = Map.prototype.delete;
const mapSizeDescriptor = Object.getOwnPropertyDescriptor(
  Map.prototype,
  "size",
);
if (mapSizeDescriptor?.get === undefined) {
  throw new Error("Map size intrinsic unavailable");
}
const safeMapSize = mapSizeDescriptor.get;
const safeSetAdd = Set.prototype.add;
const safeSetHas = Set.prototype.has;
const safeWeakMapGet = WeakMap.prototype.get;
const safeWeakMapSet = WeakMap.prototype.set;
const safeWeakMapDelete = WeakMap.prototype.delete;
const activePrehydrationTails = new WeakMap<
  PngImageCache,
  Map<string, Promise<void>>
>();

function reservePrehydrationTails(
  plan: CanonicalReferencePlan,
  cache: PngImageCache,
): {
  readonly tails: Map<string, Promise<void>>;
  readonly keys: readonly string[];
  readonly waitFor: readonly Promise<void>[];
  readonly tail: Promise<void>;
  release(): void;
} {
  let tails = safeReflectApply(safeWeakMapGet, activePrehydrationTails, [
    cache,
  ]);
  if (tails === undefined) {
    tails = new Map<string, Promise<void>>();
    safeReflectApply(safeWeakMapSet, activePrehydrationTails, [cache, tails]);
  }

  const keys: string[] = [];
  const waitFor: Promise<void>[] = [];
  const seen = new Set<string>();
  for (const reference of plan.references) {
    const sha256 = reference.sha256;
    if (safeReflectApply(safeSetHas, seen, [sha256])) continue;
    safeReflectApply(safeSetAdd, seen, [sha256]);
    safeReflectApply(safeArrayPush, keys, [sha256]);
    const prior = safeReflectApply(safeMapGet, tails, [sha256]);
    if (prior !== undefined) safeReflectApply(safeArrayPush, waitFor, [prior]);
  }

  let finish: (() => void) | undefined;
  const tail = new Promise<void>((resolve) => {
    finish = resolve;
  });
  for (const key of keys) safeReflectApply(safeMapSet, tails, [key, tail]);

  let released = false;
  return {
    tails,
    keys,
    waitFor,
    tail,
    release() {
      if (released) return;
      released = true;
      finish?.();
      for (const key of keys) {
        if (safeReflectApply(safeMapGet, tails, [key]) === tail) {
          safeReflectApply(safeMapDelete, tails, [key]);
        }
      }
      if (safeReflectApply(safeMapSize, tails, []) === 0) {
        safeReflectApply(safeWeakMapDelete, activePrehydrationTails, [cache]);
      }
    },
  };
}

/**
 * Coordinates accepted plan hydration per cache and content address without sharing
 * a staged batch or published workspace between invocations.
 */
export async function prehydrateCanonicalReferencePlan(
  plan: CanonicalReferencePlan,
  dependencies: CoordinatedCanonicalReferencePrehydrationDependencies,
): Promise<PublishedCanonicalImageWorkspace> {
  const reservation = reservePrehydrationTails(plan, dependencies.cache);
  let batch: StagedCanonicalReferenceBatch | undefined;
  try {
    await Promise.all(reservation.waitFor);
    batch = await stageCanonicalReferencePlan(plan, dependencies);
    return publishStagedCanonicalReferenceBatch(batch, dependencies.cache);
  } catch (error) {
    batch?.release();
    throw error;
  } finally {
    reservation.release();
  }
}

export interface DurableDraftWorkspace {
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
  readonly createdAt: number;
  readonly canonicalEditableJson: string;
  readonly canonicalBytes: Uint8Array;
  readonly plan: CanonicalReferencePlan;
  readonly images: readonly CachedPngImage[];
  readonly parentApprovalHash: string | null;
  readonly approvalInvalidationReason: ApprovalInvalidationReason | null;
  release(): void;
}

export interface DurableDraftWorkspaceService {
  readonly current: DurableDraftWorkspace | null;
  publish(
    editableJson: string,
    approval?: ApprovalRecord | null,
  ): Promise<DurableDraftWorkspace>;
  reload(
    record: ValidatedDurableDraftRecord,
    lineage?: { readonly parentApprovalHash?: string },
  ): Promise<DurableDraftWorkspace>;
  release(): void;
}

export interface DurableDraftWorkspaceDependencies {
  readonly documentId: string;
  readonly revisionId: () => string;
  readonly sequence: () => number;
  readonly createdAt: () => number;
  readonly repository: PersistenceAdapterPort;
  readonly prehydration: CoordinatedCanonicalReferencePrehydrationDependencies;
}

export type DurableDraftWorkspaceErrorCode =
  "EDITOR_DURABLE_DRAFT_PUBLICATION_FAILED";

export class DurableDraftWorkspaceError extends Error {
  readonly code!: DurableDraftWorkspaceErrorCode;

  constructor() {
    super("EDITOR_DURABLE_DRAFT_PUBLICATION_FAILED");
    Object.defineProperties(this, {
      name: { value: "DurableDraftWorkspaceError" },
      code: { value: "EDITOR_DURABLE_DRAFT_PUBLICATION_FAILED" },
      message: { value: "EDITOR_DURABLE_DRAFT_PUBLICATION_FAILED" },
      stack: { value: undefined },
      cause: { value: undefined },
    });
    Object.freeze(this);
  }
}

type DurableDraftWorkspaceState = {
  readonly workspace: PublishedCanonicalImageWorkspace;
  readonly revision: CompleteSceneRevision;
  readonly createdAt: number;
  readonly parentApprovalHash: string | null;
  readonly approvalInvalidationReason: ApprovalInvalidationReason | null;
  released: boolean;
};

function durableDraftPublicationFailure(): DurableDraftWorkspaceError {
  return new DurableDraftWorkspaceError();
}

function durableDraftSnapshot(
  state: DurableDraftWorkspaceState,
  release: () => void,
): DurableDraftWorkspace {
  const plan = freezeRecursively(structuredClone(state.workspace.plan));
  const images = Object.freeze(
    safeReflectApply(safeArrayMap, state.workspace.images, [
      copyCachedPngImage,
    ]),
  );
  const canonicalBytes = state.revision.canonicalBytes;
  return Object.freeze({
    documentId: state.revision.documentId,
    revisionId: state.revision.revisionId,
    sequence: state.revision.sequence,
    createdAt: state.createdAt,
    canonicalEditableJson: plan.canonicalEditableJson,
    get canonicalBytes() {
      return canonicalBytes.slice();
    },
    plan,
    images,
    parentApprovalHash: state.parentApprovalHash,
    approvalInvalidationReason: state.approvalInvalidationReason,
    release,
  });
}

function sameApprovalAssets(
  approval: ApprovalRecord,
  plan: CanonicalReferencePlan,
): boolean {
  const expected = plan.references;
  const actual = approval.verifiedAssetManifest;
  return (
    actual.length === expected.length &&
    actual.every(
      (asset, index) =>
        asset.sha256 === expected[index]?.sha256 &&
        asset.mimeType === expected[index]?.mimeType &&
        asset.byteLength === expected[index]?.byteLength,
    )
  );
}

function approvalInvalidationReason(
  approval: ApprovalRecord,
  approvedRevision: CompleteSceneRevision,
  draftRevision: CompleteSceneRevision,
  plan: CanonicalReferencePlan,
): ApprovalInvalidationReason {
  if (readApprovalRecordRuntimeVersion(approval) !== RUNTIME_VERSION) {
    return "runtime-version";
  }
  if (
    approvedRevision.document.schemaVersion !==
    draftRevision.document.schemaVersion
  ) {
    return "schema-version";
  }
  if (!sameApprovalAssets(approval, plan)) return "verified-assets";
  return "content";
}

function requireSafeDurableDraftIdentity(
  revisionId: unknown,
  sequence: unknown,
  createdAt: unknown,
): {
  readonly revisionId: string;
  readonly sequence: number;
  readonly createdAt: number;
} {
  if (
    typeof revisionId !== "string" ||
    revisionId.trim().length === 0 ||
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0
  ) {
    throw durableDraftPublicationFailure();
  }
  return { revisionId, sequence, createdAt };
}

/**
 * Publishes a hydrated draft workspace only after its immutable revision and draft
 * pointer commit together, then retires the preceding workspace without exposing
 * dependency failures or stale-snapshot ownership across replacements.
 */
export function createDurableDraftWorkspaceService(
  dependencies: DurableDraftWorkspaceDependencies,
): DurableDraftWorkspaceService {
  let current: DurableDraftWorkspaceState | null = null;
  let isReleasing = false;

  const releaseState = (state: DurableDraftWorkspaceState): void => {
    if (state.released || isReleasing) return;
    state.released = true;
    isReleasing = true;
    try {
      state.workspace.release();
    } catch {
      // Cleanup is best-effort and cannot invalidate an already committed successor.
    } finally {
      isReleasing = false;
      if (current === state) current = null;
    }
  };

  const snapshot = (state: DurableDraftWorkspaceState): DurableDraftWorkspace =>
    durableDraftSnapshot(state, () => releaseState(state));

  return Object.freeze({
    get current() {
      const state = current;
      return state === null ? null : snapshot(state);
    },
    async publish(editableJson: string, approval?: ApprovalRecord | null) {
      const planned = createCanonicalReferencePlan(editableJson);
      if (!planned.ok) throw new Error(planned.error.code);

      const prior = current;
      let workspace: PublishedCanonicalImageWorkspace | undefined;
      try {
        const {
          documentId,
          revisionId: nextRevisionId,
          sequence: nextSequence,
          createdAt: nextCreatedAt,
          repository,
          prehydration,
        } = dependencies;
        const readPointers = repository.readPointers;
        const writeCompleteRevision = repository.writeCompleteRevision;
        if (
          typeof documentId !== "string" ||
          typeof nextRevisionId !== "function" ||
          typeof nextSequence !== "function" ||
          typeof nextCreatedAt !== "function" ||
          typeof readPointers !== "function" ||
          typeof writeCompleteRevision !== "function"
        ) {
          throw durableDraftPublicationFailure();
        }

        workspace = await prehydrateCanonicalReferencePlan(
          planned.value,
          prehydration,
        );
        const identity = requireSafeDurableDraftIdentity(
          nextRevisionId(),
          nextSequence(),
          nextCreatedAt(),
        );
        const revision = createCompleteRevision({
          documentId,
          revisionId: identity.revisionId,
          sequence: identity.sequence,
          document: planned.value.document,
        });
        const pointers = await readPointers.call(repository, documentId);
        const invalidation =
          approval === undefined || approval === null || prior === null
            ? null
            : approvalInvalidationReason(
                approval,
                prior.revision,
                revision,
                planned.value,
              );
        const nextPointers =
          invalidation === null
            ? createRevisionPointersSnapshot({
                saved: pointers.saved,
                draft: createDraftRevisionPointer(revision),
              })
            : forkApprovedDraft({
                approval: approval!,
                approvedRevision: prior!.revision,
                draftRevision: revision,
                pointers,
                reason: invalidation,
              }).pointers;
        await writeCompleteRevision.call(repository, revision, nextPointers);

        const next: DurableDraftWorkspaceState = {
          workspace,
          revision,
          createdAt: identity.createdAt,
          parentApprovalHash:
            invalidation === null ? null : approval!.snapshotHash,
          approvalInvalidationReason: invalidation,
          released: false,
        };
        current = next;
        workspace = undefined;
        if (prior !== null) releaseState(prior);
        return snapshot(next);
      } catch {
        if (workspace !== undefined) {
          try {
            workspace.release();
          } catch {
            // Failed candidates own no current state and cannot leak cleanup details.
          }
        }
        throw durableDraftPublicationFailure();
      }
    },
    async reload(
      record: ValidatedDurableDraftRecord,
      lineage?: { readonly parentApprovalHash?: string },
    ) {
      let workspace: PublishedCanonicalImageWorkspace | undefined;
      try {
        if (
          record === null ||
          (typeof record !== "object" && typeof record !== "function")
        ) {
          throw durableDraftReloadFailure();
        }
        const validated = safeReflectApply(
          safeWeakMapGet,
          validatedDurableDraftRecordAuthorities,
          [record],
        );
        if (validated === undefined) throw durableDraftReloadFailure();
        safeReflectApply(
          safeWeakMapDelete,
          validatedDurableDraftRecordAuthorities,
          [record],
        );

        workspace = await prehydrateCanonicalReferencePlan(
          validated.plan,
          dependencies.prehydration,
        );
        const hydrationTime = dependencies.createdAt;
        if (typeof hydrationTime !== "function")
          throw durableDraftReloadFailure();
        const createdAt = hydrationTime();
        if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
          throw durableDraftReloadFailure();
        }
        const next: DurableDraftWorkspaceState = {
          workspace,
          revision: validated.revision,
          createdAt,
          parentApprovalHash: lineage?.parentApprovalHash ?? null,
          approvalInvalidationReason: null,
          released: false,
        };
        const hydrated = snapshot(next);
        const prior = current;
        current = next;
        workspace = undefined;
        if (prior !== null) releaseState(prior);
        return hydrated;
      } catch {
        try {
          workspace?.release();
        } catch {
          // Hydration candidates own no current state and expose no cleanup detail.
        }
        throw durableDraftReloadFailure();
      }
    },
    release() {
      const state = current;
      if (state !== null) releaseState(state);
    },
  });
}

export type DurableDraftReloadErrorCode = "EDITOR_DURABLE_DRAFT_RELOAD_FAILED";

/** A fail-closed identity snapshot used by the later revision-envelope boundary. */
export class DurableDraftReloadError extends Error {
  readonly code!: DurableDraftReloadErrorCode;

  constructor() {
    super("EDITOR_DURABLE_DRAFT_RELOAD_FAILED");
    Object.defineProperties(this, {
      name: { value: "DurableDraftReloadError" },
      code: { value: "EDITOR_DURABLE_DRAFT_RELOAD_FAILED" },
      message: { value: "EDITOR_DURABLE_DRAFT_RELOAD_FAILED" },
      stack: { value: undefined },
      cause: { value: undefined },
    });
    Object.freeze(this);
  }
}

export interface ResolvedDurableDraftPointer {
  readonly kind: "draft";
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
  readonly parentApprovalHash?: string;
}

export interface DurableDraftPointerResolverDependencies {
  readonly documentId: string;
  readonly repository: PersistenceAdapterPort;
}

type DurableDraftPointerAuthority = {
  readonly repository: PersistenceAdapterPort;
  readonly readRevision: PersistenceAdapterPort["readRevision"];
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
};

const durableDraftPointerAuthorities = new WeakMap<
  object,
  DurableDraftPointerAuthority
>();

function durableDraftReloadFailure(): DurableDraftReloadError {
  return new DurableDraftReloadError();
}

/**
 * Resolves only the immutable draft-pointer identity. Revision content, workspace
 * state, cache hydration, and durable writes deliberately remain later boundaries.
 */
export async function resolveDurableDraftPointer(
  dependencies: DurableDraftPointerResolverDependencies,
): Promise<ResolvedDurableDraftPointer> {
  try {
    const documentId = dependencies.documentId;
    const repository = dependencies.repository;
    const readPointers = repository.readPointers;
    const readRevision = repository.readRevision;
    if (
      typeof documentId !== "string" ||
      documentId.trim().length === 0 ||
      typeof readPointers !== "function" ||
      typeof readRevision !== "function"
    ) {
      throw durableDraftReloadFailure();
    }

    const pointers = await safeReflectApply(readPointers, repository, [
      documentId,
    ]);
    if (pointers === null || typeof pointers !== "object") {
      throw durableDraftReloadFailure();
    }
    const draft = (pointers as { readonly draft?: unknown }).draft;
    if (draft === null || typeof draft !== "object") {
      throw durableDraftReloadFailure();
    }

    const pointer = draft as {
      readonly kind?: unknown;
      readonly documentId?: unknown;
      readonly revisionId?: unknown;
      readonly sequence?: unknown;
      readonly parentApprovalHash?: unknown;
    };
    const kind = pointer.kind;
    const pointerDocumentId = pointer.documentId;
    const revisionId = pointer.revisionId;
    const sequence = pointer.sequence;
    const parentApprovalHash = pointer.parentApprovalHash;
    if (
      kind !== "draft" ||
      !Object.is(pointerDocumentId, documentId) ||
      typeof revisionId !== "string" ||
      revisionId.trim().length === 0 ||
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      (parentApprovalHash !== undefined &&
        (typeof parentApprovalHash !== "string" ||
          !/^sha256:[a-f0-9]{64}$/.test(parentApprovalHash)))
    ) {
      throw durableDraftReloadFailure();
    }

    const resolved = Object.freeze({
      kind: "draft" as const,
      documentId,
      revisionId,
      sequence,
      ...(parentApprovalHash === undefined ? {} : { parentApprovalHash }),
    });
    safeReflectApply(safeWeakMapSet, durableDraftPointerAuthorities, [
      resolved,
      { repository, readRevision, documentId, revisionId, sequence },
    ]);
    return resolved;
  } catch {
    throw durableDraftReloadFailure();
  }
}

export interface DurableDraftRevisionEnvelope {
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
  readonly canonicalization: Readonly<{
    identifier: typeof CANONICALIZATION_IDENTIFIER;
    byteLength: number;
  }>;
  readonly document: object;
  readonly canonicalBytes: Uint8Array;
}

type DurableDraftRevisionEnvelopeAuthority = {
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
  readonly document: object;
  readonly canonicalBytes: Uint8Array;
};

const durableDraftRevisionEnvelopeAuthorities = new WeakMap<
  object,
  DurableDraftRevisionEnvelopeAuthority
>();
const safeUint8ArraySlice = Uint8Array.prototype.slice as (
  this: Uint8Array,
) => Uint8Array;
const safeTextDecoderDecode = TextDecoder.prototype.decode;
const safeTextEncoderEncode = TextEncoder.prototype.encode;
const safeUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const safeUtf8Encoder = new TextEncoder();

function cloneFrozenDurableDraftDocument(value: unknown): object {
  if (value === null || typeof value !== "object")
    throw durableDraftReloadFailure();
  const cloned = structuredClone(value);
  const visited = new WeakSet<object>();
  const freeze = (
    candidate: Record<PropertyKey, unknown> | unknown[],
  ): void => {
    if (visited.has(candidate)) throw durableDraftReloadFailure();
    visited.add(candidate);
    const prototype = Object.getPrototypeOf(candidate);
    if (
      prototype !== Object.prototype &&
      prototype !== Array.prototype &&
      prototype !== null
    ) {
      throw durableDraftReloadFailure();
    }
    for (const key of Reflect.ownKeys(candidate)) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw durableDraftReloadFailure();
      }
      const child = descriptor.value;
      if (child !== null && typeof child === "object") {
        freeze(child as Record<PropertyKey, unknown> | unknown[]);
      }
    }
    Object.freeze(candidate);
  };
  if (cloned === null || typeof cloned !== "object")
    throw durableDraftReloadFailure();
  freeze(cloned as Record<PropertyKey, unknown> | unknown[]);
  return cloned;
}

function durableDraftRevisionEnvelope(
  authority: DurableDraftPointerAuthority,
  revision: unknown,
): DurableDraftRevisionEnvelope {
  if (revision === null || typeof revision !== "object") {
    throw durableDraftReloadFailure();
  }
  const candidate = revision as {
    readonly documentId?: unknown;
    readonly revisionId?: unknown;
    readonly sequence?: unknown;
    readonly document?: unknown;
    readonly canonicalization?: unknown;
    readonly canonicalBytes?: unknown;
  };
  const documentId = candidate.documentId;
  const revisionId = candidate.revisionId;
  const sequence = candidate.sequence;
  const document = candidate.document;
  const canonicalization = candidate.canonicalization;
  const canonicalBytes = candidate.canonicalBytes;
  if (canonicalization === null || typeof canonicalization !== "object") {
    throw durableDraftReloadFailure();
  }
  const metadata = canonicalization as {
    readonly identifier?: unknown;
    readonly byteLength?: unknown;
  };
  const identifier = metadata.identifier;
  const byteLength = metadata.byteLength;
  const copiedBytes = copyGenuineUint8Array(canonicalBytes);
  if (
    !Object.is(documentId, authority.documentId) ||
    !Object.is(revisionId, authority.revisionId) ||
    !Object.is(sequence, authority.sequence) ||
    identifier !== CANONICALIZATION_IDENTIFIER ||
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    copiedBytes === null ||
    byteLength !== copiedBytes.byteLength
  ) {
    throw durableDraftReloadFailure();
  }
  const isolatedDocument = cloneFrozenDurableDraftDocument(document);
  const isolatedBytes = safeReflectApply(
    safeUint8ArraySlice,
    copiedBytes,
    [],
  ) as Uint8Array;
  const envelope = Object.freeze({
    documentId: authority.documentId,
    revisionId: authority.revisionId,
    sequence: authority.sequence,
    canonicalization: Object.freeze({ identifier, byteLength }),
    document: isolatedDocument,
    get canonicalBytes() {
      return safeReflectApply(
        safeUint8ArraySlice,
        isolatedBytes,
        [],
      ) as Uint8Array;
    },
  });
  safeReflectApply(safeWeakMapSet, durableDraftRevisionEnvelopeAuthorities, [
    envelope,
    {
      documentId: authority.documentId,
      revisionId: authority.revisionId,
      sequence: authority.sequence,
      document: isolatedDocument,
      canonicalBytes: isolatedBytes,
    },
  ]);
  return envelope;
}

/** Reads exactly one revision through authority captured by pointer resolution. */
export async function readDurableDraftRevisionEnvelope(
  resolvedPointer: ResolvedDurableDraftPointer,
): Promise<DurableDraftRevisionEnvelope> {
  try {
    if (
      resolvedPointer === null ||
      (typeof resolvedPointer !== "object" &&
        typeof resolvedPointer !== "function")
    ) {
      throw durableDraftReloadFailure();
    }
    const authority = safeReflectApply(
      safeWeakMapGet,
      durableDraftPointerAuthorities,
      [resolvedPointer],
    );
    if (authority === undefined) throw durableDraftReloadFailure();
    const revision = await safeReflectApply(
      authority.readRevision,
      authority.repository,
      [authority.documentId, authority.revisionId],
    );
    return durableDraftRevisionEnvelope(authority, revision);
  } catch {
    throw durableDraftReloadFailure();
  }
}

export interface ValidatedDurableDraftRecord {
  readonly revision: CompleteSceneRevision;
  readonly plan: CanonicalReferencePlan;
}

const validatedDurableDraftRecordAuthorities = new WeakMap<
  object,
  ValidatedDurableDraftRecord
>();

function copiedDurableDraftBytes(bytes: Uint8Array): Uint8Array {
  return safeReflectApply(safeUint8ArraySlice, bytes, []) as Uint8Array;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, candidate) => {
    if (!isPlainRecord(candidate) || Array.isArray(candidate)) return candidate;
    return Object.fromEntries(
      Object.keys(candidate)
        .sort()
        .map((key) => [key, candidate[key]]),
    );
  });
}

function exactDurableDraftBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Consumes one bound revision envelope and proves that its UTF-8 bytes, canonical
 * plan, and independently rebuilt complete revision are exactly the same content.
 * It deliberately has no repository, hydration, cache, or workspace dependency.
 */
export function validateDurableDraftCanonicalContent(
  envelope: DurableDraftRevisionEnvelope,
): ValidatedDurableDraftRecord {
  try {
    if (
      envelope === null ||
      (typeof envelope !== "object" && typeof envelope !== "function")
    ) {
      throw durableDraftReloadFailure();
    }
    const authority = safeReflectApply(
      safeWeakMapGet,
      durableDraftRevisionEnvelopeAuthorities,
      [envelope],
    );
    if (authority === undefined) throw durableDraftReloadFailure();
    safeReflectApply(
      safeWeakMapDelete,
      durableDraftRevisionEnvelopeAuthorities,
      [envelope],
    );

    const canonicalBytes = copiedDurableDraftBytes(authority.canonicalBytes);
    const editableJson = safeReflectApply(
      safeTextDecoderDecode,
      safeUtf8Decoder,
      [canonicalBytes],
    ) as string;
    const planned = createCanonicalReferencePlan(editableJson, {
      importEditableJson: validateSceneDocument.importEditableJson,
      exportEditableJson: (document) =>
        safeReflectApply(safeTextEncoderEncode, safeUtf8Encoder, [
          canonicalJson(document),
        ]) as Uint8Array,
    });
    if (!planned.ok) throw durableDraftReloadFailure();
    const plannedBytes = safeReflectApply(
      safeTextEncoderEncode,
      safeUtf8Encoder,
      [planned.value.canonicalEditableJson],
    ) as Uint8Array;
    if (!exactDurableDraftBytes(canonicalBytes, plannedBytes)) {
      throw durableDraftReloadFailure();
    }

    const revision = envelope as CompleteSceneRevision;
    const rebuiltBytes = safeReflectApply(
      safeTextEncoderEncode,
      safeUtf8Encoder,
      [canonicalJson(authority.document)],
    ) as Uint8Array;
    if (!exactDurableDraftBytes(canonicalBytes, rebuiltBytes)) {
      throw durableDraftReloadFailure();
    }

    const record = Object.freeze({ revision, plan: planned.value });
    safeReflectApply(safeWeakMapSet, validatedDurableDraftRecordAuthorities, [
      record,
      record,
    ]);
    return record;
  } catch {
    throw durableDraftReloadFailure();
  }
}
