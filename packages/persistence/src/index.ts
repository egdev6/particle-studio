import {
  canonicalizeSceneDocument,
  readCanonicalApprovalEvidence,
  validateSceneDocument,
  type CanonicalSceneDocument,
  type VerifiedAssetManifestEntry,
  type SceneDocumentV1,
} from "@particle-studio/scene-document";

export type PersistenceValidationErrorCode =
  | "PERSISTENCE_DOCUMENT_ID_INVALID"
  | "PERSISTENCE_REVISION_ID_INVALID"
  | "PERSISTENCE_SEQUENCE_INVALID"
  | "PERSISTENCE_SCENE_DOCUMENT_INVALID"
  | "PERSISTENCE_POINTER_INVALID"
  | "PERSISTENCE_RECOVERY_INPUT_INVALID"
  | "PERSISTENCE_RECOVERY_SAVED_DOCUMENT_MISMATCH"
  | "PERSISTENCE_RECOVERY_OFFER_STALE"
  | "PERSISTENCE_RECOVERY_DECISION_DOCUMENT_MISMATCH"
  | "PERSISTENCE_ASSET_SHA256_INVALID"
  | "PERSISTENCE_ASSET_MIME_TYPE_INVALID"
  | "PERSISTENCE_ASSET_BYTE_LENGTH_INVALID"
  | "PERSISTENCE_ASSET_BYTES_INVALID"
  | "PERSISTENCE_APPROVAL_RECORD_INVALID"
  | "PERSISTENCE_APPROVAL_RECORD_CONFLICT"
  | "PERSISTENCE_APPROVAL_INVALIDATION_INVALID";

export class PersistenceValidationError extends Error {
  readonly name = "PersistenceValidationError";

  constructor(readonly code: PersistenceValidationErrorCode) {
    super(code);
  }
}

export interface CompleteSceneRevision {
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
  readonly document: SceneDocumentV1;
  readonly canonicalization: Readonly<{
    identifier: CanonicalSceneDocument["identifier"];
    byteLength: number;
  }>;
  readonly canonicalBytes: Uint8Array;
}

export interface SavedRevisionPointer {
  readonly kind: "saved";
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
}

export interface DraftRevisionPointer {
  readonly kind: "draft";
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
  readonly parentApprovalHash?: string;
}

export interface RevisionPointersSnapshot {
  readonly saved: SavedRevisionPointer | null;
  readonly draft: DraftRevisionPointer | null;
}

export interface ValidAutosaveCandidate {
  readonly kind: "valid-autosave";
  readonly revision: CompleteSceneRevision;
}

export type InvalidAutosaveCandidateReason =
  | "incomplete"
  | "corrupt"
  | "invalid-document";

export interface InvalidAutosaveCandidate {
  readonly kind: "invalid-autosave";
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
  readonly reason: InvalidAutosaveCandidateReason;
}

export type AutosaveCandidate =
  | ValidAutosaveCandidate
  | InvalidAutosaveCandidate;

export interface RecoveryDiagnostic {
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
  readonly reason: InvalidAutosaveCandidateReason;
}

export interface RecoveryOffer {
  readonly kind: "recovery-offer";
  readonly revision: CompleteSceneRevision;
}

export interface RecoveryOfferResult {
  readonly offer: RecoveryOffer | null;
  readonly diagnostics: readonly RecoveryDiagnostic[];
}

export interface AcceptedRecoveryResult {
  readonly revision: CompleteSceneRevision;
  readonly pointers: RevisionPointersSnapshot;
}

export interface DeclinedRecoveryResult {
  readonly pointers: RevisionPointersSnapshot;
}

export interface RecoverySuppressionIdentity {
  readonly documentId: string;
  readonly revisionId: string;
}

export interface DiscardedRecoveryResult {
  readonly pointers: RevisionPointersSnapshot;
  readonly suppression: RecoverySuppressionIdentity;
}

export interface ContentAddressedAsset {
  readonly sha256: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly bytes: Uint8Array;
}

export interface AssetPersistencePort {
  readAsset(sha256: string): Promise<ContentAddressedAsset>;
  writeAsset(input: {
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<ContentAddressedAsset>;
}

export interface PersistenceAdapterPort {
  readRevision(
    documentId: string,
    revisionId: string,
  ): Promise<CompleteSceneRevision | null>;
  readPointers(documentId: string): Promise<RevisionPointersSnapshot>;
  writeCompleteRevision(
    revision: CompleteSceneRevision,
    pointers: RevisionPointersSnapshot,
  ): Promise<void>;
}

// SAFETY: Node 24 and supported browsers provide structuredClone.
const clone = <T>(value: T): T =>
  (globalThis as unknown as { structuredClone(value: T): T }).structuredClone(
    value,
  );
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as object)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validAssetHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

class StoredContentAddressedAsset implements ContentAddressedAsset {
  readonly #bytes: Uint8Array;

  constructor(
    readonly sha256: string,
    readonly mimeType: string,
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

export function createContentAddressedAsset(input: {
  readonly sha256: unknown;
  readonly mimeType: unknown;
  readonly byteLength: unknown;
  readonly bytes: unknown;
}): ContentAddressedAsset {
  if (!validAssetHash(input.sha256)) {
    throw new PersistenceValidationError("PERSISTENCE_ASSET_SHA256_INVALID");
  }
  if (!validIdentifier(input.mimeType)) {
    throw new PersistenceValidationError("PERSISTENCE_ASSET_MIME_TYPE_INVALID");
  }
  if (
    typeof input.byteLength !== "number" ||
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength < 0
  ) {
    throw new PersistenceValidationError(
      "PERSISTENCE_ASSET_BYTE_LENGTH_INVALID",
    );
  }
  if (!(input.bytes instanceof Uint8Array)) {
    throw new PersistenceValidationError("PERSISTENCE_ASSET_BYTES_INVALID");
  }
  if (input.byteLength !== input.bytes.byteLength) {
    throw new PersistenceValidationError(
      "PERSISTENCE_ASSET_BYTE_LENGTH_INVALID",
    );
  }
  return new StoredContentAddressedAsset(
    input.sha256,
    input.mimeType,
    input.byteLength,
    input.bytes,
  );
}

function validSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requireIdentifier(
  value: unknown,
  code: "PERSISTENCE_DOCUMENT_ID_INVALID" | "PERSISTENCE_REVISION_ID_INVALID",
): string {
  if (!validIdentifier(value)) throw new PersistenceValidationError(code);
  return value;
}

function requireSequence(value: unknown): number {
  if (!validSequence(value)) {
    throw new PersistenceValidationError("PERSISTENCE_SEQUENCE_INVALID");
  }
  return value;
}

class StoredCompleteSceneRevision implements CompleteSceneRevision {
  readonly canonicalization: CompleteSceneRevision["canonicalization"];
  readonly #document: SceneDocumentV1;
  readonly #canonicalBytes: Uint8Array;

  constructor(
    readonly documentId: string,
    readonly revisionId: string,
    readonly sequence: number,
    document: SceneDocumentV1,
    canonical: CanonicalSceneDocument,
  ) {
    this.#document = freezeDeep(clone(document));
    this.#canonicalBytes = canonical.bytes.slice();
    this.canonicalization = Object.freeze({
      identifier: canonical.identifier,
      byteLength: this.#canonicalBytes.byteLength,
    });
    Object.freeze(this);
  }

  get document(): SceneDocumentV1 {
    return freezeDeep(clone(this.#document));
  }

  get canonicalBytes(): Uint8Array {
    return this.#canonicalBytes.slice();
  }
}

export function createCompleteRevision(input: {
  readonly documentId: unknown;
  readonly revisionId: unknown;
  readonly sequence: unknown;
  readonly document: unknown;
}): CompleteSceneRevision {
  const documentId = requireIdentifier(
    input.documentId,
    "PERSISTENCE_DOCUMENT_ID_INVALID",
  );
  const revisionId = requireIdentifier(
    input.revisionId,
    "PERSISTENCE_REVISION_ID_INVALID",
  );
  const sequence = requireSequence(input.sequence);
  const validation = validateSceneDocument(input.document);
  if (!validation.ok) {
    throw new PersistenceValidationError("PERSISTENCE_SCENE_DOCUMENT_INVALID");
  }
  const canonical = canonicalizeSceneDocument(validation.value);

  return new StoredCompleteSceneRevision(
    documentId,
    revisionId,
    sequence,
    validation.value,
    canonical,
  );
}

type RevisionIdentity = Pick<
  CompleteSceneRevision,
  "documentId" | "revisionId" | "sequence"
>;

function createPointer(
  kind: "saved" | "draft",
  revision: RevisionIdentity,
  parentApprovalHash?: unknown,
): SavedRevisionPointer | DraftRevisionPointer {
  const pointer = {
    kind,
    documentId: requireIdentifier(
      revision.documentId,
      "PERSISTENCE_DOCUMENT_ID_INVALID",
    ),
    revisionId: requireIdentifier(
      revision.revisionId,
      "PERSISTENCE_REVISION_ID_INVALID",
    ),
    sequence: requireSequence(revision.sequence),
  };
  if (kind === "draft" && parentApprovalHash !== undefined) {
    if (!validAssetHash(parentApprovalHash)) {
      throw new PersistenceValidationError("PERSISTENCE_POINTER_INVALID");
    }
    return approvalObjectFreeze({ ...pointer, parentApprovalHash });
  }
  return approvalObjectFreeze(pointer) as
    | SavedRevisionPointer
    | DraftRevisionPointer;
}

export function createSavedRevisionPointer(
  revision: CompleteSceneRevision,
): SavedRevisionPointer {
  return createPointer("saved", revision) as SavedRevisionPointer;
}

export function createDraftRevisionPointer(
  revision: CompleteSceneRevision,
  parentApprovalHash?: string,
): DraftRevisionPointer {
  return createPointer(
    "draft",
    revision,
    parentApprovalHash,
  ) as DraftRevisionPointer;
}

function copyPointer(
  pointer: SavedRevisionPointer | DraftRevisionPointer | null,
  kind: "saved" | "draft",
): SavedRevisionPointer | DraftRevisionPointer | null {
  if (pointer === null) return null;
  if (pointer.kind !== kind) {
    throw new PersistenceValidationError("PERSISTENCE_POINTER_INVALID");
  }
  return createPointer(
    kind,
    pointer,
    kind === "draft"
      ? (pointer as DraftRevisionPointer).parentApprovalHash
      : undefined,
  );
}

function copySavedRevisionPointer(
  pointer: SavedRevisionPointer | null,
): SavedRevisionPointer | null {
  return copyPointer(pointer, "saved") as SavedRevisionPointer | null;
}

export function createRevisionPointersSnapshot(input: {
  readonly saved: SavedRevisionPointer | null;
  readonly draft: DraftRevisionPointer | null;
}): RevisionPointersSnapshot {
  const snapshot = approvalObjectFreeze({
    saved: copyPointer(input.saved, "saved") as SavedRevisionPointer | null,
    draft: copyPointer(input.draft, "draft") as DraftRevisionPointer | null,
  });
  approvalApply<void>(approvalWeakSetAdd, pointerSnapshotBrand, [snapshot]);
  return snapshot;
}

function copyCompleteRevision(
  revision: CompleteSceneRevision,
): CompleteSceneRevision {
  return createCompleteRevision({
    documentId: revision.documentId,
    revisionId: revision.revisionId,
    sequence: revision.sequence,
    document: revision.document,
  });
}

class StoredValidAutosaveCandidate implements ValidAutosaveCandidate {
  readonly kind = "valid-autosave" as const;
  readonly #revision: CompleteSceneRevision;

  constructor(revision: CompleteSceneRevision) {
    this.#revision = copyCompleteRevision(revision);
    Object.freeze(this);
  }

  get revision(): CompleteSceneRevision {
    return copyCompleteRevision(this.#revision);
  }
}

export function createValidAutosaveCandidate(
  revision: CompleteSceneRevision,
): ValidAutosaveCandidate {
  return new StoredValidAutosaveCandidate(revision);
}

function validInvalidAutosaveCandidateReason(
  value: unknown,
): value is InvalidAutosaveCandidateReason {
  return (
    value === "incomplete" ||
    value === "corrupt" ||
    value === "invalid-document"
  );
}

class StoredInvalidAutosaveCandidate implements InvalidAutosaveCandidate {
  readonly kind = "invalid-autosave" as const;
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
  readonly reason: InvalidAutosaveCandidateReason;

  constructor(input: {
    readonly documentId: unknown;
    readonly revisionId: unknown;
    readonly sequence: unknown;
    readonly reason: unknown;
  }) {
    this.documentId = requireIdentifier(
      input.documentId,
      "PERSISTENCE_DOCUMENT_ID_INVALID",
    );
    this.revisionId = requireIdentifier(
      input.revisionId,
      "PERSISTENCE_REVISION_ID_INVALID",
    );
    this.sequence = requireSequence(input.sequence);
    if (!validInvalidAutosaveCandidateReason(input.reason)) {
      throw new PersistenceValidationError(
        "PERSISTENCE_RECOVERY_INPUT_INVALID",
      );
    }
    this.reason = input.reason;
    Object.freeze(this);
  }
}

export function createInvalidAutosaveCandidate(input: {
  readonly documentId: unknown;
  readonly revisionId: unknown;
  readonly sequence: unknown;
  readonly reason: unknown;
}): InvalidAutosaveCandidate {
  return new StoredInvalidAutosaveCandidate(input);
}

class StoredRecoveryOffer implements RecoveryOffer {
  readonly kind = "recovery-offer" as const;
  readonly #revision: CompleteSceneRevision;

  constructor(revision: CompleteSceneRevision) {
    this.#revision = copyCompleteRevision(revision);
    Object.freeze(this);
  }

  get revision(): CompleteSceneRevision {
    return copyCompleteRevision(this.#revision);
  }
}

function requireRecoveryInput(value: unknown): asserts value is object {
  if (value === null || typeof value !== "object") {
    throw new PersistenceValidationError("PERSISTENCE_RECOVERY_INPUT_INVALID");
  }
}

function copyAutosaveCandidate(value: unknown): AutosaveCandidate {
  requireRecoveryInput(value);
  const candidate = value as Partial<AutosaveCandidate>;
  if (candidate.kind === "valid-autosave" && candidate.revision !== undefined) {
    return createValidAutosaveCandidate(candidate.revision);
  }
  if (candidate.kind === "invalid-autosave") {
    return createInvalidAutosaveCandidate({
      documentId: candidate.documentId,
      revisionId: candidate.revisionId,
      sequence: candidate.sequence,
      reason: candidate.reason,
    });
  }
  throw new PersistenceValidationError("PERSISTENCE_RECOVERY_INPUT_INVALID");
}

function copyRecoveryDiagnostic(
  candidate: RecoveryDiagnostic,
): RecoveryDiagnostic {
  return Object.freeze({
    documentId: candidate.documentId,
    revisionId: candidate.revisionId,
    sequence: candidate.sequence,
    reason: candidate.reason,
  });
}

function compareUtf16CodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

class StoredRecoveryOfferResult implements RecoveryOfferResult {
  readonly #diagnostics: readonly RecoveryDiagnostic[];

  constructor(
    readonly offer: RecoveryOffer | null,
    diagnostics: readonly RecoveryDiagnostic[],
  ) {
    this.#diagnostics = Object.freeze(diagnostics.map(copyRecoveryDiagnostic));
    Object.freeze(this);
  }

  get diagnostics(): readonly RecoveryDiagnostic[] {
    return Object.freeze(this.#diagnostics.map(copyRecoveryDiagnostic));
  }
}

function copyDiscardedRevisionIds(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) {
    throw new PersistenceValidationError("PERSISTENCE_RECOVERY_INPUT_INVALID");
  }
  return new Set(
    value.map((revisionId) =>
      requireIdentifier(revisionId, "PERSISTENCE_REVISION_ID_INVALID"),
    ),
  );
}

export function selectRecoveryOffer(input: {
  readonly documentId: unknown;
  readonly autosaveCandidates: readonly AutosaveCandidate[];
  readonly savedRevision: SavedRevisionPointer | null;
  readonly discardedRevisionIds: readonly string[];
}): RecoveryOfferResult {
  requireRecoveryInput(input);
  const documentId = requireIdentifier(
    input.documentId,
    "PERSISTENCE_DOCUMENT_ID_INVALID",
  );
  if (!Array.isArray(input.autosaveCandidates)) {
    throw new PersistenceValidationError("PERSISTENCE_RECOVERY_INPUT_INVALID");
  }
  const saved = copySavedRevisionPointer(input.savedRevision);
  if (saved !== null && saved.documentId !== documentId) {
    throw new PersistenceValidationError(
      "PERSISTENCE_RECOVERY_SAVED_DOCUMENT_MISMATCH",
    );
  }
  const discardedRevisionIds = copyDiscardedRevisionIds(
    input.discardedRevisionIds,
  );
  const candidates = input.autosaveCandidates.map(copyAutosaveCandidate);
  const diagnostics = candidates
    .filter(
      (candidate): candidate is InvalidAutosaveCandidate =>
        candidate.kind === "invalid-autosave" &&
        candidate.documentId === documentId &&
        !discardedRevisionIds.has(candidate.revisionId),
    )
    .map(copyRecoveryDiagnostic)
    .sort((left, right) => {
      const sequenceDifference = right.sequence - left.sequence;
      return sequenceDifference === 0
        ? compareUtf16CodeUnits(left.revisionId, right.revisionId)
        : sequenceDifference;
    });
  const revisions = candidates
    .filter(
      (candidate): candidate is ValidAutosaveCandidate =>
        candidate.kind === "valid-autosave",
    )
    .map((candidate) => candidate.revision)
    .filter(
      (revision) =>
        revision.documentId === documentId &&
        !discardedRevisionIds.has(revision.revisionId) &&
        (saved === null || revision.sequence > saved.sequence),
    )
    .sort((left, right) => {
      const sequenceDifference = right.sequence - left.sequence;
      return sequenceDifference === 0
        ? compareUtf16CodeUnits(left.revisionId, right.revisionId)
        : sequenceDifference;
    });
  const revision = revisions[0] ?? null;

  return new StoredRecoveryOfferResult(
    revision === null ? null : new StoredRecoveryOffer(revision),
    diagnostics,
  );
}

function copyRecoveryOffer(value: unknown): RecoveryOffer {
  requireRecoveryInput(value);
  const offer = value as Partial<RecoveryOffer>;
  if (offer.kind !== "recovery-offer" || offer.revision === undefined) {
    throw new PersistenceValidationError("PERSISTENCE_RECOVERY_INPUT_INVALID");
  }
  return new StoredRecoveryOffer(offer.revision);
}

class StoredAcceptedRecoveryResult implements AcceptedRecoveryResult {
  readonly #revision: CompleteSceneRevision;
  readonly #pointers: RevisionPointersSnapshot;

  constructor(offer: RecoveryOffer, saved: SavedRevisionPointer | null) {
    this.#revision = copyCompleteRevision(offer.revision);
    if (saved !== null && saved.documentId !== this.#revision.documentId) {
      throw new PersistenceValidationError(
        "PERSISTENCE_RECOVERY_SAVED_DOCUMENT_MISMATCH",
      );
    }
    if (saved !== null && this.#revision.sequence <= saved.sequence) {
      throw new PersistenceValidationError("PERSISTENCE_RECOVERY_OFFER_STALE");
    }
    this.#pointers = createRevisionPointersSnapshot({
      saved,
      draft: createDraftRevisionPointer(this.#revision),
    });
    Object.freeze(this);
  }

  get revision(): CompleteSceneRevision {
    return copyCompleteRevision(this.#revision);
  }

  get pointers(): RevisionPointersSnapshot {
    return createRevisionPointersSnapshot(this.#pointers);
  }
}

export function acceptRecoveryOffer(input: {
  readonly offer: RecoveryOffer;
  readonly savedRevision: SavedRevisionPointer | null;
}): AcceptedRecoveryResult {
  requireRecoveryInput(input);
  const offer = copyRecoveryOffer(input.offer);
  const saved = copySavedRevisionPointer(input.savedRevision);

  return new StoredAcceptedRecoveryResult(offer, saved);
}

function copyDecisionPointers(value: unknown): RevisionPointersSnapshot {
  requireRecoveryInput(value);
  const pointers = value as Partial<RevisionPointersSnapshot>;
  if (pointers.saved === undefined || pointers.draft === undefined) {
    throw new PersistenceValidationError("PERSISTENCE_RECOVERY_INPUT_INVALID");
  }
  return createRevisionPointersSnapshot({
    saved: pointers.saved,
    draft: pointers.draft,
  });
}

function validateRecoveryDecision(
  offer: RecoveryOffer,
  pointers: RevisionPointersSnapshot,
): void {
  const revision = offer.revision;
  for (const pointer of [pointers.saved, pointers.draft]) {
    if (pointer !== null && pointer.documentId !== revision.documentId) {
      throw new PersistenceValidationError(
        "PERSISTENCE_RECOVERY_DECISION_DOCUMENT_MISMATCH",
      );
    }
  }
  if (pointers.saved !== null && revision.sequence <= pointers.saved.sequence) {
    throw new PersistenceValidationError("PERSISTENCE_RECOVERY_OFFER_STALE");
  }
}

function copyRecoveryDecision(input: unknown): {
  offer: RecoveryOffer;
  pointers: RevisionPointersSnapshot;
} {
  requireRecoveryInput(input);
  const decision = input as Partial<{
    offer: RecoveryOffer;
    pointers: RevisionPointersSnapshot;
  }>;
  return {
    offer: copyRecoveryOffer(decision.offer),
    pointers: copyDecisionPointers(decision.pointers),
  };
}

class StoredDeclinedRecoveryResult implements DeclinedRecoveryResult {
  readonly #pointers: RevisionPointersSnapshot;

  constructor(offer: RecoveryOffer, pointers: RevisionPointersSnapshot) {
    validateRecoveryDecision(offer, pointers);
    this.#pointers = createRevisionPointersSnapshot(pointers);
    Object.freeze(this);
  }

  get pointers(): RevisionPointersSnapshot {
    return createRevisionPointersSnapshot(this.#pointers);
  }
}

export function declineRecoveryOffer(input: {
  readonly offer: RecoveryOffer;
  readonly pointers: RevisionPointersSnapshot;
}): DeclinedRecoveryResult {
  const decision = copyRecoveryDecision(input);
  return new StoredDeclinedRecoveryResult(decision.offer, decision.pointers);
}

class StoredDiscardedRecoveryResult implements DiscardedRecoveryResult {
  readonly #pointers: RevisionPointersSnapshot;
  readonly #suppression: RecoverySuppressionIdentity;

  constructor(offer: RecoveryOffer, pointers: RevisionPointersSnapshot) {
    validateRecoveryDecision(offer, pointers);
    const revision = offer.revision;
    this.#pointers = createRevisionPointersSnapshot(pointers);
    this.#suppression = Object.freeze({
      documentId: revision.documentId,
      revisionId: revision.revisionId,
    });
    Object.freeze(this);
  }

  get pointers(): RevisionPointersSnapshot {
    return createRevisionPointersSnapshot(this.#pointers);
  }

  get suppression(): RecoverySuppressionIdentity {
    return Object.freeze({ ...this.#suppression });
  }
}

export function discardRecoveryOffer(input: {
  readonly offer: RecoveryOffer;
  readonly pointers: RevisionPointersSnapshot;
}): DiscardedRecoveryResult {
  const decision = copyRecoveryDecision(input);
  return new StoredDiscardedRecoveryResult(decision.offer, decision.pointers);
}

export interface ApprovalAudit {
  readonly approvedAt: number;
  readonly actorLabel: "local-human";
}

export interface ApprovalRecord {
  readonly documentId: string;
  readonly revisionId: string;
  readonly snapshotHash: string;
  readonly approvalEnvelopeBytes: Uint8Array;
  readonly canonicalDocumentBytes: Uint8Array;
  readonly verifiedAssetManifest: readonly VerifiedAssetManifestEntry[];
  readonly audit: ApprovalAudit;
}

const approvalRecordBrand = new WeakSet<object>();
const pointerSnapshotBrand = new WeakSet<object>();
interface ApprovalRecordEvidence {
  readonly runtimeVersion: string;
}

const approvalRecordEvidence = new WeakMap<object, ApprovalRecordEvidence>();

interface ApprovalRecordIdentity {
  readonly documentId: string;
  readonly revisionId: string;
  readonly snapshotHash: string;
  readonly runtimeVersion: string;
  readonly approvalEnvelopeBytes: Uint8Array;
  readonly canonicalDocumentBytes: Uint8Array;
  readonly verifiedAssetManifest: readonly VerifiedAssetManifestEntry[];
}

const approvalRecordIdentity = new WeakMap<object, ApprovalRecordIdentity>();
const approvalReflectApply = Reflect.apply;
const approvalArray = Array;
const approvalArrayIsArray = Array.isArray;
const approvalNumberIsSafeInteger = Number.isSafeInteger;
const approvalObjectFreeze = Object.freeze;
const approvalObjectGetPrototypeOf = Object.getPrototypeOf;
const getOwnApprovalPropertyDescriptor = Object.getOwnPropertyDescriptor;
const approvalUint8Array = Uint8Array;
const approvalUint8ArrayPrototype = approvalUint8Array.prototype;
const approvalTypedArrayPrototype = approvalObjectGetPrototypeOf(
  approvalUint8ArrayPrototype,
);
const approvalByteLengthGetter = getOwnApprovalPropertyDescriptor(
  approvalTypedArrayPrototype,
  "byteLength",
)?.get;
const approvalTypedArrayNameGetter = getOwnApprovalPropertyDescriptor(
  approvalTypedArrayPrototype,
  Symbol.toStringTag,
)?.get;
const approvalTypedArrayBufferGetter = getOwnApprovalPropertyDescriptor(
  approvalTypedArrayPrototype,
  "buffer",
)?.get;
const approvalArrayBufferByteLengthGetter = getOwnApprovalPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;
const approvalUint8ArraySet = approvalUint8ArrayPrototype.set;
const approvalWeakSetAdd = WeakSet.prototype.add;
const approvalWeakSetHas = WeakSet.prototype.has;
const hasBrand = (brand: WeakSet<object>, value: unknown) =>
  approvalApply(approvalWeakSetHas, brand, [value]);
const approvalWeakMapGet = WeakMap.prototype.get;
const approvalWeakMapSet = WeakMap.prototype.set;

if (
  approvalByteLengthGetter === undefined ||
  approvalTypedArrayNameGetter === undefined ||
  approvalTypedArrayBufferGetter === undefined ||
  approvalArrayBufferByteLengthGetter === undefined
) {
  throw new Error("Uint8Array intrinsic getters unavailable");
}

function approvalApply<Result>(
  target: (...args: never[]) => Result,
  thisArgument: unknown,
  argumentsList: readonly unknown[],
): Result {
  return approvalReflectApply(target, thisArgument, argumentsList);
}

function approvalRecordInvalid(): never {
  throw new PersistenceValidationError("PERSISTENCE_APPROVAL_RECORD_INVALID");
}

type ApprovalRecordFieldValue =
  | string
  | number
  | Uint8Array
  | object
  | undefined;

function readOwnApprovalProperty(
  value: unknown,
  property: string,
  errorCode: PersistenceValidationErrorCode = "PERSISTENCE_APPROVAL_RECORD_INVALID",
): ApprovalRecordFieldValue {
  if (value === null || typeof value !== "object") {
    throw new PersistenceValidationError(errorCode);
  }
  try {
    const descriptor = getOwnApprovalPropertyDescriptor(value, property);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new PersistenceValidationError(errorCode);
    }
    return descriptor.value as ApprovalRecordFieldValue;
  } catch (error) {
    if (error instanceof PersistenceValidationError) throw error;
    throw new PersistenceValidationError(errorCode);
  }
}

function approvalValidSequence(value: unknown): value is number {
  return (
    typeof value === "number" &&
    approvalNumberIsSafeInteger(value) &&
    value >= 0
  );
}

function approvalBytesLength(value: unknown): number {
  if (value === null || typeof value !== "object") approvalRecordInvalid();
  try {
    const name = approvalApply<string>(
      approvalTypedArrayNameGetter!,
      value,
      [],
    );
    const length = approvalApply<number>(approvalByteLengthGetter!, value, []);
    const backing = approvalApply<ArrayBuffer>(
      approvalTypedArrayBufferGetter!,
      value,
      [],
    );
    const backingLength = approvalApply<number>(
      approvalArrayBufferByteLengthGetter!,
      backing,
      [],
    );
    new approvalUint8Array(backing);
    if (
      name !== "Uint8Array" ||
      !approvalValidSequence(length) ||
      !approvalValidSequence(backingLength)
    ) {
      approvalRecordInvalid();
    }
    return length;
  } catch (error) {
    if (error instanceof PersistenceValidationError) throw error;
    approvalRecordInvalid();
  }
}

function copyApprovalBytes(value: unknown): Uint8Array {
  const length = approvalBytesLength(value);
  try {
    const copy = new approvalUint8Array(length);
    approvalApply<void>(approvalUint8ArraySet, copy, [value]);
    return copy;
  } catch {
    approvalRecordInvalid();
  }
}

function approvalManifestLength(value: unknown): number {
  if (!approvalArrayIsArray(value)) approvalRecordInvalid();
  const length = readOwnApprovalProperty(value, "length");
  if (!approvalValidSequence(length)) approvalRecordInvalid();
  return length;
}

function copyApprovalManifest(
  value: unknown,
): readonly VerifiedAssetManifestEntry[] {
  const length = approvalManifestLength(value);
  const copy = new approvalArray<VerifiedAssetManifestEntry>();
  let index = 0;
  while (index < length) {
    const entry = readOwnApprovalProperty(value, String(index));
    if (
      entry === null ||
      typeof entry !== "object" ||
      approvalArrayIsArray(entry)
    ) {
      approvalRecordInvalid();
    }
    const sha256 = readOwnApprovalProperty(entry, "sha256");
    const mimeType = readOwnApprovalProperty(entry, "mimeType");
    const byteLength = readOwnApprovalProperty(entry, "byteLength");
    if (
      !validAssetHash(sha256) ||
      !validIdentifier(mimeType) ||
      !approvalValidSequence(byteLength)
    ) {
      approvalRecordInvalid();
    }
    copy[index] = approvalObjectFreeze({ sha256, mimeType, byteLength });
    index += 1;
  }
  return approvalObjectFreeze(copy);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  const leftLength = approvalBytesLength(left);
  const rightLength = approvalBytesLength(right);
  if (leftLength !== rightLength) return false;
  let index = 0;
  while (index < leftLength) {
    if (left[index] !== right[index]) return false;
    index += 1;
  }
  return true;
}

function equalApprovalManifest(
  left: readonly VerifiedAssetManifestEntry[],
  right: readonly VerifiedAssetManifestEntry[],
): boolean {
  if (left.length !== right.length) return false;
  let index = 0;
  while (index < left.length) {
    const leftEntry = left[index];
    const rightEntry = right[index];
    if (
      leftEntry === undefined ||
      rightEntry === undefined ||
      leftEntry.sha256 !== rightEntry.sha256 ||
      leftEntry.mimeType !== rightEntry.mimeType ||
      leftEntry.byteLength !== rightEntry.byteLength
    ) {
      return false;
    }
    index += 1;
  }
  return true;
}

function copyApprovalAudit(value: unknown): ApprovalAudit {
  if (
    value === null ||
    typeof value !== "object" ||
    approvalArrayIsArray(value)
  ) {
    approvalRecordInvalid();
  }
  const approvedAt = readOwnApprovalProperty(value, "approvedAt");
  const actorLabel = readOwnApprovalProperty(value, "actorLabel");
  if (!approvalValidSequence(approvedAt) || actorLabel !== "local-human") {
    approvalRecordInvalid();
  }
  return approvalObjectFreeze({ approvedAt, actorLabel });
}

class StoredApprovalRecord implements ApprovalRecord {
  readonly #approvalEnvelopeBytes: Uint8Array;
  readonly #canonicalDocumentBytes: Uint8Array;
  readonly #verifiedAssetManifest: readonly VerifiedAssetManifestEntry[];
  readonly #audit: ApprovalAudit;

  constructor(
    readonly documentId: string,
    readonly revisionId: string,
    readonly snapshotHash: string,
    runtimeVersion: string,
    approvalEnvelopeBytes: Uint8Array,
    canonicalDocumentBytes: Uint8Array,
    verifiedAssetManifest: readonly VerifiedAssetManifestEntry[],
    audit: ApprovalAudit,
  ) {
    this.#approvalEnvelopeBytes = copyApprovalBytes(approvalEnvelopeBytes);
    this.#canonicalDocumentBytes = copyApprovalBytes(canonicalDocumentBytes);
    this.#verifiedAssetManifest = copyApprovalManifest(verifiedAssetManifest);
    this.#audit = copyApprovalAudit(audit);
    const identity = approvalObjectFreeze({
      documentId,
      revisionId,
      snapshotHash,
      runtimeVersion,
      approvalEnvelopeBytes: copyApprovalBytes(this.#approvalEnvelopeBytes),
      canonicalDocumentBytes: copyApprovalBytes(this.#canonicalDocumentBytes),
      verifiedAssetManifest: copyApprovalManifest(this.#verifiedAssetManifest),
    });
    approvalApply<void>(approvalWeakMapSet, approvalRecordIdentity, [
      this,
      identity,
    ]);
    approvalApply<void>(approvalWeakMapSet, approvalRecordEvidence, [
      this,
      approvalObjectFreeze({ runtimeVersion }),
    ]);
    approvalApply<void>(approvalWeakSetAdd, approvalRecordBrand, [this]);
    approvalObjectFreeze(this);
  }

  get approvalEnvelopeBytes(): Uint8Array {
    return copyApprovalBytes(this.#approvalEnvelopeBytes);
  }

  get canonicalDocumentBytes(): Uint8Array {
    return copyApprovalBytes(this.#canonicalDocumentBytes);
  }

  get verifiedAssetManifest(): readonly VerifiedAssetManifestEntry[] {
    return copyApprovalManifest(this.#verifiedAssetManifest);
  }

  get audit(): ApprovalAudit {
    return approvalObjectFreeze({ ...this.#audit });
  }
}

export function validateApprovalRecord(value: unknown): ApprovalRecord {
  if (value === null || typeof value !== "object") approvalRecordInvalid();
  try {
    if (
      approvalApply<boolean>(approvalWeakSetHas, approvalRecordBrand, [
        value,
      ]) !== true ||
      approvalApply<ApprovalRecordEvidence | undefined>(
        approvalWeakMapGet,
        approvalRecordEvidence,
        [value],
      ) === undefined
    ) {
      approvalRecordInvalid();
    }
  } catch (error) {
    if (error instanceof PersistenceValidationError) throw error;
    approvalRecordInvalid();
  }
  return value as ApprovalRecord;
}

export function readApprovalRecordRuntimeVersion(value: unknown): string {
  const approval = validateApprovalRecord(value);
  const evidence = approvalApply<ApprovalRecordEvidence | undefined>(
    approvalWeakMapGet,
    approvalRecordEvidence,
    [approval],
  );
  if (evidence === undefined) approvalRecordInvalid();
  return evidence.runtimeVersion;
}

function equalApprovalRecordIdentity(
  left: ApprovalRecordIdentity,
  right: ApprovalRecordIdentity,
): boolean {
  return (
    left.documentId === right.documentId &&
    left.revisionId === right.revisionId &&
    left.snapshotHash === right.snapshotHash &&
    left.runtimeVersion === right.runtimeVersion &&
    equalBytes(left.approvalEnvelopeBytes, right.approvalEnvelopeBytes) &&
    equalBytes(left.canonicalDocumentBytes, right.canonicalDocumentBytes) &&
    equalApprovalManifest(
      left.verifiedAssetManifest,
      right.verifiedAssetManifest,
    )
  );
}

export function reuseIdenticalApprovalRecord(
  existing: unknown,
  candidate: unknown,
): ApprovalRecord {
  const validatedExisting = validateApprovalRecord(existing);
  const validatedCandidate = validateApprovalRecord(candidate);
  const existingIdentity = approvalApply<ApprovalRecordIdentity | undefined>(
    approvalWeakMapGet,
    approvalRecordIdentity,
    [validatedExisting],
  );
  const candidateIdentity = approvalApply<ApprovalRecordIdentity | undefined>(
    approvalWeakMapGet,
    approvalRecordIdentity,
    [validatedCandidate],
  );
  if (existingIdentity === undefined || candidateIdentity === undefined) {
    approvalRecordInvalid();
  }
  if (!equalApprovalRecordIdentity(existingIdentity, candidateIdentity)) {
    throw new PersistenceValidationError(
      "PERSISTENCE_APPROVAL_RECORD_CONFLICT",
    );
  }
  return validatedExisting;
}

export interface ApprovedDraftFork {
  readonly approval: ApprovalRecord;
  readonly pointers: RevisionPointersSnapshot;
}

export type ApprovalInvalidationReason =
  | "content"
  | "runtime-version"
  | "schema-version"
  | "verified-assets";

function approvalInvalidationInvalid(): never {
  throw new PersistenceValidationError(
    "PERSISTENCE_APPROVAL_INVALIDATION_INVALID",
  );
}

function readOwnApprovalInvalidationProperty(
  value: unknown,
  property: string,
): ApprovalRecordFieldValue {
  if (value === null || typeof value !== "object")
    approvalInvalidationInvalid();
  try {
    const descriptor = getOwnApprovalPropertyDescriptor(value, property);
    if (descriptor === undefined || !("value" in descriptor)) {
      approvalInvalidationInvalid();
    }
    return descriptor.value as ApprovalRecordFieldValue;
  } catch (error) {
    if (error instanceof PersistenceValidationError) throw error;
    approvalInvalidationInvalid();
  }
}

function copyApprovalInvalidationRevision(
  value: unknown,
): CompleteSceneRevision {
  try {
    return copyCompleteRevision(value as CompleteSceneRevision);
  } catch {
    approvalInvalidationInvalid();
  }
}

function validApprovalInvalidationReason(
  value: unknown,
): value is ApprovalInvalidationReason {
  return (
    value === "content" ||
    value === "runtime-version" ||
    value === "schema-version" ||
    value === "verified-assets"
  );
}

export function forkApprovedDraft(input: unknown): ApprovedDraftFork {
  const approval = validateApprovalRecord(
    readOwnApprovalInvalidationProperty(input, "approval"),
  );
  const approvedRevision = copyApprovalInvalidationRevision(
    readOwnApprovalInvalidationProperty(input, "approvedRevision"),
  );
  const draftRevision = copyApprovalInvalidationRevision(
    readOwnApprovalInvalidationProperty(input, "draftRevision"),
  );
  const pointers = readOwnApprovalInvalidationProperty(input, "pointers");
  if (!hasBrand(pointerSnapshotBrand, pointers)) approvalInvalidationInvalid();
  const currentDraft = (pointers as RevisionPointersSnapshot).draft;
  const reason = readOwnApprovalInvalidationProperty(input, "reason");
  if (
    !validApprovalInvalidationReason(reason) ||
    !approvalNumberIsSafeInteger(draftRevision.sequence) ||
    currentDraft === null ||
    currentDraft.documentId !== approvedRevision.documentId ||
    currentDraft.revisionId !== approvedRevision.revisionId ||
    currentDraft.sequence !== approvedRevision.sequence ||
    currentDraft.parentApprovalHash !== undefined ||
    approval.documentId !== approvedRevision.documentId ||
    approval.revisionId !== approvedRevision.revisionId ||
    !equalBytes(
      approval.canonicalDocumentBytes,
      approvedRevision.canonicalBytes,
    ) ||
    draftRevision.documentId !== approvedRevision.documentId ||
    draftRevision.revisionId === approvedRevision.revisionId
  ) {
    approvalInvalidationInvalid();
  }
  try {
    return approvalObjectFreeze({
      approval,
      pointers: createRevisionPointersSnapshot({
        saved: (pointers as RevisionPointersSnapshot).saved,
        draft: createDraftRevisionPointer(draftRevision, approval.snapshotHash),
      }),
    });
  } catch (error) {
    if (error instanceof PersistenceValidationError) throw error;
    approvalInvalidationInvalid();
  }
}

export function createApprovalRecord(input: unknown): ApprovalRecord {
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      approvalArrayIsArray(input)
    ) {
      approvalRecordInvalid();
    }
  } catch {
    approvalRecordInvalid();
  }

  const approvalEnvelope = readOwnApprovalProperty(input, "approvalEnvelope");
  let evidence;
  try {
    evidence = readCanonicalApprovalEvidence(approvalEnvelope);
  } catch {
    approvalRecordInvalid();
  }
  const documentId = requireIdentifier(
    readOwnApprovalProperty(
      input,
      "documentId",
      "PERSISTENCE_DOCUMENT_ID_INVALID",
    ),
    "PERSISTENCE_DOCUMENT_ID_INVALID",
  );
  const revisionId = requireIdentifier(
    readOwnApprovalProperty(
      input,
      "revisionId",
      "PERSISTENCE_REVISION_ID_INVALID",
    ),
    "PERSISTENCE_REVISION_ID_INVALID",
  );
  const snapshotHash = readOwnApprovalProperty(input, "snapshotHash");
  const approvalEnvelopeBytes = readOwnApprovalProperty(
    input,
    "approvalEnvelopeBytes",
  );
  const canonicalDocumentBytes = readOwnApprovalProperty(
    input,
    "canonicalDocumentBytes",
  );
  if (!validAssetHash(snapshotHash)) approvalRecordInvalid();
  const copiedApprovalEnvelopeBytes = copyApprovalBytes(approvalEnvelopeBytes);
  const copiedCanonicalDocumentBytes = copyApprovalBytes(
    canonicalDocumentBytes,
  );
  const manifest = copyApprovalManifest(
    readOwnApprovalProperty(input, "verifiedAssetManifest"),
  );
  const audit = copyApprovalAudit(readOwnApprovalProperty(input, "audit"));
  if (
    snapshotHash !== evidence.snapshotHash ||
    !equalBytes(copiedApprovalEnvelopeBytes, evidence.approvalEnvelopeBytes) ||
    !equalBytes(
      copiedCanonicalDocumentBytes,
      evidence.canonicalDocumentBytes,
    ) ||
    !equalApprovalManifest(manifest, evidence.verifiedAssetManifest)
  ) {
    approvalRecordInvalid();
  }
  return new StoredApprovalRecord(
    documentId,
    revisionId,
    snapshotHash,
    evidence.runtimeVersion,
    copiedApprovalEnvelopeBytes,
    copiedCanonicalDocumentBytes,
    manifest,
    audit,
  );
}
