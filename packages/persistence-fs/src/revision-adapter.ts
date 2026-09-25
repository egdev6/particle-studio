import {
  createCompleteRevision,
  createDraftRevisionPointer,
  createRevisionPointersSnapshot,
  createSavedRevisionPointer,
  type CompleteSceneRevision,
  type DraftRevisionPointer,
  type PersistenceAdapterPort,
  type RevisionPointersSnapshot,
  type SavedRevisionPointer,
} from "@particle-studio/persistence";
import {
  prepareCreateTarget,
  prepareReplaceableTarget,
  publishImmutableFile,
  publishReplaceablePointer,
  RootConfinementError,
  type RootConfinement,
} from "./index.js";
import { hasRootConfinementAuthority } from "./confinement-contracts.js";
import {
  domainSegment,
  documentSegmentFor,
  privateRootDirectory,
} from "./confinement-layout.js";
import {
  ensureConfinementDirectory,
  inspectConfinementFile,
  type ConfinementFileSnapshot,
} from "./confinement-file.js";

export const MAX_REVISION_RECORD_BYTES = 16 * 1024 * 1024;
export const MAX_POINTER_RECORD_BYTES = 64 * 1024;

export type FileSystemPersistenceErrorCode =
  | "PERSISTENCE_FS_AUTHORITY_INVALID"
  | "PERSISTENCE_FS_REVISION_INPUT_INVALID"
  | "PERSISTENCE_FS_REVISION_INVALID"
  | "PERSISTENCE_FS_REVISION_RECORD_COLLISION"
  | "PERSISTENCE_FS_REVISION_RECORD_SYMLINK"
  | "PERSISTENCE_FS_REVISION_RECORD_OVERSIZE"
  | "PERSISTENCE_FS_REVISION_RECORD_MALFORMED"
  | "PERSISTENCE_FS_REVISION_RECORD_IDENTITY_MISMATCH"
  | "PERSISTENCE_FS_REVISION_RECORD_CORRUPT"
  | "PERSISTENCE_FS_REVISION_RECORD_UNAVAILABLE"
  | "PERSISTENCE_FS_REVISION_PUBLICATION_FAILED"
  | "PERSISTENCE_FS_REVISION_PUBLICATION_DURABILITY_UNCERTAIN"
  | "PERSISTENCE_FS_POINTER_INPUT_INVALID"
  | "PERSISTENCE_FS_POINTER_INVALID"
  | "PERSISTENCE_FS_POINTER_INCOMPLETE"
  | "PERSISTENCE_FS_POINTER_RECORD_SYMLINK"
  | "PERSISTENCE_FS_POINTER_RECORD_OVERSIZE"
  | "PERSISTENCE_FS_POINTER_RECORD_MALFORMED"
  | "PERSISTENCE_FS_POINTER_RECORD_IDENTITY_MISMATCH"
  | "PERSISTENCE_FS_POINTER_RECORD_CORRUPT"
  | "PERSISTENCE_FS_POINTER_RECORD_UNAVAILABLE"
  | "PERSISTENCE_FS_POINTER_PUBLICATION_FAILED"
  | "PERSISTENCE_FS_POINTER_PUBLICATION_DURABILITY_UNCERTAIN";

export type {
  CompleteSceneRevision,
  DraftRevisionPointer,
  PersistenceAdapterPort,
  RevisionPointersSnapshot,
  SavedRevisionPointer,
} from "@particle-studio/persistence";

export class FileSystemPersistenceError extends Error {
  readonly name = "FileSystemPersistenceError";

  constructor(readonly code: FileSystemPersistenceErrorCode) {
    super(code);
  }
}

export interface FileSystemPersistenceAdapterOptions {
  readonly authority: RootConfinement;
}

export interface RevisionPersistenceTestConfiguration {
  readonly observe?: (event: string) => void;
  readonly failPointerPublication?: () => boolean;
}

let testConfiguration: RevisionPersistenceTestConfiguration | undefined;

/** This is intentionally reachable only through a relative test-only module. */
export function setRevisionPersistenceTestConfiguration(
  configuration: RevisionPersistenceTestConfiguration | undefined,
): void {
  testConfiguration = configuration;
}

const revisionsDirectoryName = "revisions";
const pointersDirectoryName = "pointers";
const pointerSnapshotFileName = "pointers.json";
const recordVersion = 1;
const canonicalizationIdentifier = "jcs-1";
const approvalHashPattern = /^sha256:[a-f0-9]{64}$/;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function fsError(code: FileSystemPersistenceErrorCode): FileSystemPersistenceError {
  return new FileSystemPersistenceError(code);
}

function observe(event: string): void {
  testConfiguration?.observe?.(event);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function sameRevision(
  pointer: { readonly documentId: string; readonly revisionId: string; readonly sequence: number },
  revision: CompleteSceneRevision,
): boolean {
  return (
    pointer.documentId === revision.documentId &&
    pointer.revisionId === revision.revisionId &&
    pointer.sequence === revision.sequence
  );
}

function revisionRecordRelativePath(documentId: string, revisionId: string): string {
  const revisionSegment = domainSegment("revision-id", [documentId, revisionId]);
  return `${privateRootDirectory}/${revisionsDirectoryName}/${documentSegmentFor(documentId)}/${revisionSegment}.json`;
}

function pointerSnapshotRelativePath(documentId: string): string {
  return `${privateRootDirectory}/${pointersDirectoryName}/${documentSegmentFor(documentId)}/${pointerSnapshotFileName}`;
}

interface RevisionRecordContent {
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
  readonly canonicalization: { readonly identifier: string; readonly byteLength: number };
  readonly documentText: string;
}

/**
 * Deterministic record serialization. The document subtree is embedded as its
 * own canonical JSON text, so a record round-trips byte-identically if and
 * only if every stored byte matches the regenerated canonical form.
 */
function revisionRecordText(record: RevisionRecordContent): string {
  return (
    `{"recordVersion":${recordVersion},"recordKind":"complete-scene-revision",` +
    `"documentId":${JSON.stringify(record.documentId)},` +
    `"revisionId":${JSON.stringify(record.revisionId)},` +
    `"sequence":${record.sequence},` +
    `"canonicalization":{"identifier":${JSON.stringify(record.canonicalization.identifier)},"byteLength":${record.canonicalization.byteLength}},` +
    `"document":${record.documentText}}`
  );
}

interface PointerRecordContent {
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
  readonly parentApprovalHash?: string;
}

function pointerRecordContent(
  pointer: SavedRevisionPointer | DraftRevisionPointer,
): PointerRecordContent {
  return {
    documentId: pointer.documentId,
    revisionId: pointer.revisionId,
    sequence: pointer.sequence,
    ...(pointer.kind === "draft" && pointer.parentApprovalHash !== undefined
      ? { parentApprovalHash: pointer.parentApprovalHash }
      : {}),
  };
}

function pointerValueText(pointer: PointerRecordContent | null, kind: "saved" | "draft"): string {
  if (pointer === null) return "null";
  const base =
    `{"kind":"${kind}",` +
    `"documentId":${JSON.stringify(pointer.documentId)},` +
    `"revisionId":${JSON.stringify(pointer.revisionId)},` +
    `"sequence":${pointer.sequence}`;
  if (kind === "draft" && pointer.parentApprovalHash !== undefined) {
    return `${base},"parentApprovalHash":${JSON.stringify(pointer.parentApprovalHash)}}`;
  }
  return `${base}}`;
}

/**
 * Deterministic serialization of the one versioned pointer snapshot record per
 * document: an exact-shape {saved,draft} pair published atomically as a whole.
 */
function pointerSnapshotText(
  documentId: string,
  saved: PointerRecordContent | null,
  draft: PointerRecordContent | null,
): string {
  return (
    `{"recordVersion":${recordVersion},"recordKind":"revision-pointers-snapshot",` +
    `"documentId":${JSON.stringify(documentId)},` +
    `"saved":${pointerValueText(saved, "saved")},` +
    `"draft":${pointerValueText(draft, "draft")}}`
  );
}

function encodeRevisionRecord(revision: CompleteSceneRevision): Uint8Array {
  return textEncoder.encode(
    revisionRecordText({
      documentId: revision.documentId,
      revisionId: revision.revisionId,
      sequence: revision.sequence,
      canonicalization: revision.canonicalization,
      documentText: textDecoder.decode(revision.canonicalBytes),
    }),
  );
}

function decodeRecordText(
  bytes: Uint8Array,
  malformedCode: FileSystemPersistenceErrorCode,
): string {
  try {
    return textDecoder.decode(bytes);
  } catch {
    throw fsError(malformedCode);
  }
}

function requireRecordIdentifier(
  value: unknown,
  malformedCode: FileSystemPersistenceErrorCode,
): string {
  if (!validIdentifier(value)) throw fsError(malformedCode);
  return value;
}

function requireRecordSequence(
  value: unknown,
  malformedCode: FileSystemPersistenceErrorCode,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw fsError(malformedCode);
  }
  return value;
}

interface RevisionRecordEnvelope {
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
  readonly document: unknown;
}

function parseRevisionRecord(bytes: Uint8Array): RevisionRecordEnvelope {
  const malformedCode = "PERSISTENCE_FS_REVISION_RECORD_MALFORMED" as const;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeRecordText(bytes, malformedCode));
  } catch {
    throw fsError(malformedCode);
  }
  if (typeof parsed !== "object" || parsed === null) throw fsError(malformedCode);
  const record = parsed as Record<string, unknown>;
  if (record.recordVersion !== recordVersion) throw fsError(malformedCode);
  if (record.recordKind !== "complete-scene-revision") throw fsError(malformedCode);
  const canonicalization = record.canonicalization;
  if (typeof canonicalization !== "object" || canonicalization === null) {
    throw fsError(malformedCode);
  }
  const canonical = canonicalization as Record<string, unknown>;
  if (canonical.identifier !== canonicalizationIdentifier) throw fsError(malformedCode);
  const byteLength = canonical.byteLength;
  if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw fsError(malformedCode);
  }
  return {
    documentId: requireRecordIdentifier(record.documentId, malformedCode),
    revisionId: requireRecordIdentifier(record.revisionId, malformedCode),
    sequence: requireRecordSequence(record.sequence, malformedCode),
    document: record.document,
  };
}

interface PointerRecordEnvelope {
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
  readonly parentApprovalHash: string | undefined;
}

function parsePointerValue(
  value: unknown,
  kind: "saved" | "draft",
  malformedCode: FileSystemPersistenceErrorCode,
): PointerRecordEnvelope | null {
  if (value === null) return null;
  if (typeof value !== "object") throw fsError(malformedCode);
  const record = value as Record<string, unknown>;
  const expectedKeys =
    kind === "saved"
      ? ["kind", "documentId", "revisionId", "sequence"]
      : ["kind", "documentId", "revisionId", "sequence", "parentApprovalHash"];
  for (const key of Object.keys(record)) {
    if (!expectedKeys.includes(key)) throw fsError(malformedCode);
  }
  if (record.kind !== kind) throw fsError(malformedCode);
  let parentApprovalHash: string | undefined;
  if (
    kind === "draft" &&
    Object.prototype.hasOwnProperty.call(record, "parentApprovalHash")
  ) {
    const hash = record.parentApprovalHash;
    if (typeof hash !== "string" || !approvalHashPattern.test(hash)) {
      throw fsError(malformedCode);
    }
    parentApprovalHash = hash;
  }
  return {
    documentId: requireRecordIdentifier(record.documentId, malformedCode),
    revisionId: requireRecordIdentifier(record.revisionId, malformedCode),
    sequence: requireRecordSequence(record.sequence, malformedCode),
    parentApprovalHash,
  };
}

interface PointerSnapshotEnvelope {
  readonly documentId: string;
  readonly saved: PointerRecordEnvelope | null;
  readonly draft: PointerRecordEnvelope | null;
}

function parsePointerSnapshotRecord(bytes: Uint8Array): PointerSnapshotEnvelope {
  const malformedCode = "PERSISTENCE_FS_POINTER_RECORD_MALFORMED" as const;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeRecordText(bytes, malformedCode));
  } catch {
    throw fsError(malformedCode);
  }
  if (typeof parsed !== "object" || parsed === null) throw fsError(malformedCode);
  const record = parsed as Record<string, unknown>;
  if (record.recordVersion !== recordVersion) throw fsError(malformedCode);
  if (record.recordKind !== "revision-pointers-snapshot") throw fsError(malformedCode);
  const documentId = requireRecordIdentifier(record.documentId, malformedCode);
  const saved = parsePointerValue(record.saved, "saved", malformedCode);
  const draft = parsePointerValue(record.draft, "draft", malformedCode);
  for (const pointer of [saved, draft]) {
    if (pointer !== null && pointer.documentId !== documentId) {
      throw fsError("PERSISTENCE_FS_POINTER_RECORD_IDENTITY_MISMATCH");
    }
  }
  return { documentId, saved, draft };
}

function mapRecordSnapshot(
  snapshot: ConfinementFileSnapshot,
  codes: {
    readonly symlink: FileSystemPersistenceErrorCode;
    readonly oversize: FileSystemPersistenceErrorCode;
    readonly unavailable: FileSystemPersistenceErrorCode;
  },
): { readonly kind: "absent" } | { readonly kind: "regular"; readonly bytes: Uint8Array } {
  if (snapshot.kind === "absent") return snapshot;
  if (snapshot.kind === "symlink") throw fsError(codes.symlink);
  if (snapshot.kind === "oversize") throw fsError(codes.oversize);
  if (snapshot.kind !== "regular") throw fsError(codes.unavailable);
  return snapshot;
}

async function readRevisionRecord(
  authority: RootConfinement,
  documentId: string,
  revisionId: string,
): Promise<CompleteSceneRevision | null> {
  const snapshot = mapRecordSnapshot(
    await inspectConfinementFile(
      authority,
      { role: "outputs", path: revisionRecordRelativePath(documentId, revisionId) },
      MAX_REVISION_RECORD_BYTES,
    ),
    {
      symlink: "PERSISTENCE_FS_REVISION_RECORD_SYMLINK",
      oversize: "PERSISTENCE_FS_REVISION_RECORD_OVERSIZE",
      unavailable: "PERSISTENCE_FS_REVISION_RECORD_UNAVAILABLE",
    },
  );
  if (snapshot.kind === "absent") return null;

  const envelope = parseRevisionRecord(snapshot.bytes);
  if (envelope.documentId !== documentId || envelope.revisionId !== revisionId) {
    throw fsError("PERSISTENCE_FS_REVISION_RECORD_IDENTITY_MISMATCH");
  }

  let candidate: CompleteSceneRevision;
  try {
    candidate = createCompleteRevision({
      documentId: envelope.documentId,
      revisionId: envelope.revisionId,
      sequence: envelope.sequence,
      document: envelope.document,
    });
  } catch {
    throw fsError("PERSISTENCE_FS_REVISION_RECORD_MALFORMED");
  }

  const regenerated = textEncoder.encode(
    revisionRecordText({
      documentId: envelope.documentId,
      revisionId: envelope.revisionId,
      sequence: envelope.sequence,
      canonicalization: candidate.canonicalization,
      documentText: textDecoder.decode(candidate.canonicalBytes),
    }),
  );
  if (!sameBytes(regenerated, snapshot.bytes)) {
    throw fsError("PERSISTENCE_FS_REVISION_RECORD_CORRUPT");
  }
  return candidate;
}

function reconstructStoredPointer<const K extends "saved" | "draft">(
  kind: K,
  envelope: PointerRecordEnvelope | null,
): (K extends "saved" ? SavedRevisionPointer : DraftRevisionPointer) | null {
  if (envelope === null) return null;
  // createPointer consumes only the revision identity fields of this object.
  const identity = {
    documentId: envelope.documentId,
    revisionId: envelope.revisionId,
    sequence: envelope.sequence,
  } as CompleteSceneRevision;
  try {
    const pointer =
      kind === "saved"
        ? createSavedRevisionPointer(identity)
        : createDraftRevisionPointer(identity, envelope.parentApprovalHash);
    return pointer as K extends "saved" ? SavedRevisionPointer : DraftRevisionPointer;
  } catch {
    throw fsError("PERSISTENCE_FS_POINTER_RECORD_MALFORMED");
  }
}

async function readPointerSnapshotRecord(
  authority: RootConfinement,
  documentId: string,
): Promise<{
  readonly saved: SavedRevisionPointer | null;
  readonly draft: DraftRevisionPointer | null;
} | null> {
  const snapshot = mapRecordSnapshot(
    await inspectConfinementFile(
      authority,
      { role: "outputs", path: pointerSnapshotRelativePath(documentId) },
      MAX_POINTER_RECORD_BYTES,
    ),
    {
      symlink: "PERSISTENCE_FS_POINTER_RECORD_SYMLINK",
      oversize: "PERSISTENCE_FS_POINTER_RECORD_OVERSIZE",
      unavailable: "PERSISTENCE_FS_POINTER_RECORD_UNAVAILABLE",
    },
  );
  if (snapshot.kind === "absent") return null;

  const envelope = parsePointerSnapshotRecord(snapshot.bytes);
  if (envelope.documentId !== documentId) {
    throw fsError("PERSISTENCE_FS_POINTER_RECORD_IDENTITY_MISMATCH");
  }

  const regenerated = textEncoder.encode(
    pointerSnapshotText(envelope.documentId, envelope.saved, envelope.draft),
  );
  if (!sameBytes(regenerated, snapshot.bytes)) {
    throw fsError("PERSISTENCE_FS_POINTER_RECORD_CORRUPT");
  }

  return {
    saved: reconstructStoredPointer("saved", envelope.saved),
    draft: reconstructStoredPointer("draft", envelope.draft),
  };
}

function reconstructRevision(revision: CompleteSceneRevision): CompleteSceneRevision {
  if (revision === null || typeof revision !== "object") {
    throw fsError("PERSISTENCE_FS_REVISION_INVALID");
  }
  try {
    return createCompleteRevision({
      documentId: revision.documentId,
      revisionId: revision.revisionId,
      sequence: revision.sequence,
      document: revision.document,
    });
  } catch {
    throw fsError("PERSISTENCE_FS_REVISION_INVALID");
  }
}

function reconstructSnapshot(pointers: RevisionPointersSnapshot): RevisionPointersSnapshot {
  if (pointers === null || typeof pointers !== "object") {
    throw fsError("PERSISTENCE_FS_POINTER_INPUT_INVALID");
  }
  try {
    return createRevisionPointersSnapshot({ saved: pointers.saved, draft: pointers.draft });
  } catch {
    throw fsError("PERSISTENCE_FS_POINTER_INVALID");
  }
}

async function storedPointerIsComplete(
  authority: RootConfinement,
  pointer: SavedRevisionPointer | DraftRevisionPointer,
  documentId: string,
): Promise<boolean> {
  if (pointer.documentId !== documentId) return false;
  let stored: CompleteSceneRevision | null;
  try {
    stored = await readRevisionRecord(authority, pointer.documentId, pointer.revisionId);
  } catch (error: unknown) {
    if (error instanceof FileSystemPersistenceError) return false;
    throw error;
  }
  return stored !== null && sameRevision(pointer, stored);
}

async function validateSnapshotPointers(
  authority: RootConfinement,
  snapshot: RevisionPointersSnapshot,
  complete: CompleteSceneRevision,
): Promise<void> {
  for (const pointer of [snapshot.saved, snapshot.draft]) {
    if (pointer === null) continue;
    if (sameRevision(pointer, complete)) continue;
    if (await storedPointerIsComplete(authority, pointer, complete.documentId)) continue;
    throw fsError("PERSISTENCE_FS_POINTER_INCOMPLETE");
  }
}

async function validateSnapshotCompleteness(
  authority: RootConfinement,
  snapshot: RevisionPointersSnapshot,
  documentId: string,
): Promise<void> {
  for (const pointer of [snapshot.saved, snapshot.draft]) {
    if (pointer === null) continue;
    if (await storedPointerIsComplete(authority, pointer, documentId)) continue;
    throw fsError("PERSISTENCE_FS_POINTER_INCOMPLETE");
  }
}

async function ensureLayoutDirectory(
  authority: RootConfinement,
  relativePath: string,
  event: string,
): Promise<void> {
  observe(event);
  await ensureConfinementDirectory(authority, { role: "outputs", path: relativePath });
}

type PublicationPhase = "revision" | "pointer";

/**
 * Map every publication-phase failure into the stable adapter error surface.
 * Already-surface adapter errors pass through unchanged so record-level codes
 * keep their meaning; confinement durability-uncertain results keep their
 * durability distinction; every other confinement or injected failure maps to
 * the phase's publication-failed code.
 */
function mapPublicationFailure(phase: PublicationPhase, error: unknown): never {
  if (error instanceof FileSystemPersistenceError) throw error;
  if (error instanceof RootConfinementError) {
    if (error.code === "PERSISTENCE_FS_PUBLICATION_DURABILITY_UNCERTAIN") {
      throw fsError(
        phase === "revision"
          ? "PERSISTENCE_FS_REVISION_PUBLICATION_DURABILITY_UNCERTAIN"
          : "PERSISTENCE_FS_POINTER_PUBLICATION_DURABILITY_UNCERTAIN",
      );
    }
    if (phase === "revision" && error.code === "PERSISTENCE_FS_CREATE_TARGET_EXISTS") {
      throw fsError("PERSISTENCE_FS_REVISION_RECORD_COLLISION");
    }
  }
  throw fsError(
    phase === "revision"
      ? "PERSISTENCE_FS_REVISION_PUBLICATION_FAILED"
      : "PERSISTENCE_FS_POINTER_PUBLICATION_FAILED",
  );
}

/**
 * Create the root-confined filesystem persistence adapter. Every operation is
 * bound to the accepted authority and mutates only the private outputs-role
 * layout. A write first prevalidates every record and pointer reference, then
 * publishes the immutable revision record (reusing a byte-identical stored
 * record without rewriting it), then always publishes the whole {saved,draft}
 * pointer snapshot — including the all-null snapshot that clears previously
 * stored pointers — as one atomically replaced record. A failed write never
 * reports success; a pointer failure leaves at most an orphan revision.
 */
export function createFileSystemPersistenceAdapter(
  options: FileSystemPersistenceAdapterOptions,
): PersistenceAdapterPort {
  const authority =
    options === null || typeof options !== "object" ? undefined : options.authority;
  if (!hasRootConfinementAuthority(authority)) {
    throw fsError("PERSISTENCE_FS_AUTHORITY_INVALID");
  }
  const confinement = authority as RootConfinement;

  async function readRevision(
    documentId: string,
    revisionId: string,
  ): Promise<CompleteSceneRevision | null> {
    if (!validIdentifier(documentId) || !validIdentifier(revisionId)) {
      throw fsError("PERSISTENCE_FS_REVISION_INPUT_INVALID");
    }
    return readRevisionRecord(confinement, documentId, revisionId);
  }

  async function readPointers(documentId: string): Promise<RevisionPointersSnapshot> {
    if (!validIdentifier(documentId)) {
      throw fsError("PERSISTENCE_FS_POINTER_INPUT_INVALID");
    }
    const stored = await readPointerSnapshotRecord(confinement, documentId);
    if (stored === null) {
      return createRevisionPointersSnapshot({ saved: null, draft: null });
    }
    let snapshot: RevisionPointersSnapshot;
    try {
      snapshot = createRevisionPointersSnapshot({
        saved: stored.saved,
        draft: stored.draft,
      });
    } catch {
      throw fsError("PERSISTENCE_FS_POINTER_RECORD_MALFORMED");
    }
    await validateSnapshotCompleteness(confinement, snapshot, documentId);
    return snapshot;
  }

  async function writeCompleteRevision(
    revision: CompleteSceneRevision,
    pointers: RevisionPointersSnapshot,
  ): Promise<void> {
    const complete = reconstructRevision(revision);
    const snapshot = reconstructSnapshot(pointers);

    // Validate every referenced revision before publishing anything.
    await validateSnapshotPointers(confinement, snapshot, complete);

    // Build and size-check every record before any publication.
    const recordBytes = encodeRevisionRecord(complete);
    if (recordBytes.byteLength > MAX_REVISION_RECORD_BYTES) {
      throw fsError("PERSISTENCE_FS_REVISION_RECORD_OVERSIZE");
    }
    // Every successful write publishes a complete versioned snapshot record,
    // including the all-null snapshot that clears previously stored pointers;
    // a stale non-empty snapshot must never survive an all-null write.
    const snapshotBytes = textEncoder.encode(
      pointerSnapshotText(
        complete.documentId,
        snapshot.saved === null ? null : pointerRecordContent(snapshot.saved),
        snapshot.draft === null ? null : pointerRecordContent(snapshot.draft),
      ),
    );
    if (snapshotBytes.byteLength > MAX_POINTER_RECORD_BYTES) {
      throw fsError("PERSISTENCE_FS_POINTER_RECORD_OVERSIZE");
    }

    try {
      // Inspect before mutating anything: an identical stored record is
      // reused without provisioning or rewriting; a conflicting or corrupt
      // record fails explicitly with no filesystem mutation.
      const existing = await readRevisionRecord(
        confinement,
        complete.documentId,
        complete.revisionId,
      );
      if (existing !== null) {
        const identical =
          existing.documentId === complete.documentId &&
          existing.revisionId === complete.revisionId &&
          existing.sequence === complete.sequence &&
          sameBytes(existing.canonicalBytes, complete.canonicalBytes);
        if (!identical) {
          throw fsError("PERSISTENCE_FS_REVISION_RECORD_COLLISION");
        }
        observe("revision-record-reused");
      } else {
        const documentSegment = documentSegmentFor(complete.documentId);
        await ensureLayoutDirectory(
          confinement,
          privateRootDirectory,
          "ensure-directory:private-root",
        );
        await ensureLayoutDirectory(
          confinement,
          `${privateRootDirectory}/${revisionsDirectoryName}`,
          "ensure-directory:revisions",
        );
        await ensureLayoutDirectory(
          confinement,
          `${privateRootDirectory}/${revisionsDirectoryName}/${documentSegment}`,
          "ensure-directory:revisions/document",
        );
        const preparedRevision = await prepareCreateTarget(confinement, {
          role: "outputs",
          path: revisionRecordRelativePath(complete.documentId, complete.revisionId),
        });
        await publishImmutableFile(confinement, preparedRevision, recordBytes);
        observe("revision-record-published");
      }
    } catch (error: unknown) {
      throw mapPublicationFailure("revision", error);
    }

    try {
      const documentSegment = documentSegmentFor(complete.documentId);
      await ensureLayoutDirectory(
        confinement,
        `${privateRootDirectory}/${pointersDirectoryName}`,
        "ensure-directory:pointers",
      );
      await ensureLayoutDirectory(
        confinement,
        `${privateRootDirectory}/${pointersDirectoryName}/${documentSegment}`,
        "ensure-directory:pointers/document",
      );
      if (testConfiguration?.failPointerPublication?.() === true) {
        throw new Error("injected pointer publication failure");
      }
      const preparedPointer = await prepareReplaceableTarget(confinement, {
        role: "outputs",
        path: pointerSnapshotRelativePath(complete.documentId),
      });
      await publishReplaceablePointer(confinement, preparedPointer, snapshotBytes);
      observe("pointer-snapshot-published");
    } catch (error: unknown) {
      throw mapPublicationFailure("pointer", error);
    }
  }

  return { readRevision, readPointers, writeCompleteRevision };
}
