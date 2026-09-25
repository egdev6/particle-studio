/// <reference lib="dom" />
import { Dexie, type Table } from "dexie";
import { createApprovalEnvelope } from "@particle-studio/scene-document";
import {
  createCompleteRevision,
  createContentAddressedAsset,
  createInvalidAutosaveCandidate,
  createRevisionPointersSnapshot,
  createValidAutosaveCandidate,
  selectRecoveryOffer,
  createApprovalRecord,
  reuseIdenticalApprovalRecord,
  validateApprovalRecord,
  type ApprovalRecord,
  type AssetPersistencePort,
  type AutosaveCandidate,
  type ContentAddressedAsset,
  type CompleteSceneRevision,
  type PersistenceAdapterPort,
  type RecoveryOfferResult,
  type RevisionPointersSnapshot,
  type SavedRevisionPointer,
  type DraftRevisionPointer,
} from "@particle-studio/persistence";

type StoredRevision = {
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
  readonly document: CompleteSceneRevision["document"];
  readonly canonicalization: CompleteSceneRevision["canonicalization"];
  readonly canonicalBytes: Uint8Array;
};

type StoredAsset = {
  readonly sha256: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly bytes: Uint8Array;
};

type StoredPointers = {
  readonly documentId: string;
  readonly saved: SavedRevisionPointer | null;
  readonly draft: DraftRevisionPointer | null;
};

type StoredApproval = {
  readonly documentId: string;
  readonly revisionId: string;
  readonly snapshotHash: string;
  readonly approvalEnvelopeBytes: Uint8Array;
  readonly canonicalDocumentBytes: Uint8Array;
  readonly verifiedAssetManifest: ApprovalRecord["verifiedAssetManifest"];
  readonly audit: ApprovalRecord["audit"];
  readonly integrityHash: string;
};
type UnsealedApproval = Omit<StoredApproval, "integrityHash">;

export type IndexedDbPersistenceErrorCode =
  | "PERSISTENCE_INDEXEDDB_QUOTA_EXCEEDED"
  | "PERSISTENCE_INDEXEDDB_WRITE_FAILED"
  | "PERSISTENCE_INDEXEDDB_POINTER_INCOMPLETE"
  | "PERSISTENCE_INDEXEDDB_ASSET_MISSING"
  | "PERSISTENCE_INDEXEDDB_ASSET_UNREADABLE"
  | "PERSISTENCE_INDEXEDDB_ASSET_HASH_MISMATCH"
  | "PERSISTENCE_INDEXEDDB_ASSET_CONFLICT";

export interface IndexedDbAutosaveStorage {
  readAutosaveRevisions(
    documentId: string,
  ): Promise<readonly CompleteSceneRevision[]>;
  readRecoveryOffer(documentId: string): Promise<RecoveryOfferResult>;
  writeAutosaveRevision(revision: CompleteSceneRevision): Promise<void>;
}

export interface IndexedDbApprovalStorage {
  readApproval(
    documentId: string,
    revisionId: string,
  ): Promise<ApprovalRecord | null>;
  writeApproval(record: ApprovalRecord): Promise<void>;
}

const AUTOSAVE_RETENTION_LIMIT = 10;
const SHA256_HEX_ALPHABET = "0123456789abcdef",
  CapturedUint8Array = Uint8Array,
  capturedEncoder = new TextEncoder(),
  capturedEncode = capturedEncoder.encode.bind(capturedEncoder),
  capturedDecoder = new TextDecoder(),
  capturedDecode = capturedDecoder.decode.bind(capturedDecoder),
  capturedUint8ArraySet = CapturedUint8Array.prototype.set,
  capturedReflectApply = Reflect.apply;
const capturedTypedArrayPrototype = Object.getPrototypeOf(
  CapturedUint8Array.prototype,
);
const capturedTypedArrayToStringTag = Object.getOwnPropertyDescriptor(
  capturedTypedArrayPrototype,
  Symbol.toStringTag,
)!.get!;
const capturedTypedArrayByteLength = Object.getOwnPropertyDescriptor(
  capturedTypedArrayPrototype,
  "byteLength",
)!.get!;
const capturedTypedArrayBuffer = Object.getOwnPropertyDescriptor(
  capturedTypedArrayPrototype,
  "buffer",
)!.get!;
const capturedTypedArrayByteOffset = Object.getOwnPropertyDescriptor(
  capturedTypedArrayPrototype,
  "byteOffset",
)!.get!;
const capturedTypedArrayLength = Object.getOwnPropertyDescriptor(
  capturedTypedArrayPrototype,
  "length",
)!.get!;
const capturedArrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)!.get!;
const { parse: capturedJsonParse, stringify: capturedJsonStringify } = JSON;
type Digest = (name: string, data: Uint8Array) => Promise<ArrayBuffer>;
type CryptoGlobal = { crypto: { subtle: { digest: Digest } } };
// SAFETY: Node 24 and the supported browser baseline expose Web Crypto.
const capturedSubtle = (globalThis as unknown as CryptoGlobal).crypto.subtle;
const capturedDigest = capturedSubtle.digest.bind(capturedSubtle);

export class IndexedDbPersistenceError extends Error {
  readonly name = "IndexedDbPersistenceError";

  constructor(readonly code: IndexedDbPersistenceErrorCode) {
    super(code);
  }
}

class PersistenceDatabase extends Dexie {
  assets!: Table<StoredAsset, string>;
  autosaves!: Table<StoredRevision, [string, string]>;
  revisions!: Table<StoredRevision, [string, string]>;
  pointers!: Table<StoredPointers, string>;
  approvals!: Table<StoredApproval, [string, string]>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      revisions: "[documentId+revisionId], documentId",
      pointers: "documentId",
    });
    this.version(2).stores({
      autosaves: "[documentId+revisionId], documentId",
    });
    this.version(3).stores({ assets: "sha256" });
    this.version(4).stores({
      approvals: "[documentId+revisionId], snapshotHash",
    });
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digestBytes = new CapturedUint8Array(
    await capturedDigest("SHA-256", bytes),
  );
  let hash = "sha256:";
  for (let index = 0; index < digestBytes.byteLength; index += 1) {
    const byte = digestBytes[index]!;
    hash += SHA256_HEX_ALPHABET[byte >>> 4]! + SHA256_HEX_ALPHABET[byte & 15]!;
  }
  return hash;
}

function copyStoredUint8Array(value: unknown): Uint8Array | null {
  try {
    if (
      capturedReflectApply(capturedTypedArrayToStringTag, value, []) !==
      "Uint8Array"
    ) {
      return null;
    }
    const byteLength = capturedReflectApply(
      capturedTypedArrayByteLength,
      value,
      [],
    );
    const buffer = capturedReflectApply(capturedTypedArrayBuffer, value, []);
    const bufferByteLength = capturedReflectApply(
      capturedArrayBufferByteLength,
      buffer,
      [],
    );
    const byteOffset = capturedReflectApply(
      capturedTypedArrayByteOffset,
      value,
      [],
    );
    const length = capturedReflectApply(capturedTypedArrayLength, value, []);
    if (
      !Number.isSafeInteger(byteLength) ||
      !Number.isSafeInteger(bufferByteLength) ||
      !Number.isSafeInteger(byteOffset) ||
      !Number.isSafeInteger(length) ||
      byteLength < 0 ||
      byteOffset < 0 ||
      length < 0 ||
      byteLength !== length ||
      byteOffset + byteLength > bufferByteLength
    ) {
      return null;
    }
    const copy = new CapturedUint8Array(byteLength);
    capturedReflectApply(capturedUint8ArraySet, copy, [value]);
    return copy;
  } catch {
    return null;
  }
}

async function readStoredAsset(
  record: StoredAsset,
): Promise<ContentAddressedAsset> {
  const bytes = copyStoredUint8Array(record.bytes);
  if (
    typeof record.mimeType !== "string" ||
    bytes === null ||
    !Number.isSafeInteger(record.byteLength) ||
    record.byteLength !== bytes.byteLength
  ) {
    throw new IndexedDbPersistenceError(
      "PERSISTENCE_INDEXEDDB_ASSET_UNREADABLE",
    );
  }
  if ((await sha256(bytes)) !== record.sha256) {
    throw new IndexedDbPersistenceError(
      "PERSISTENCE_INDEXEDDB_ASSET_HASH_MISMATCH",
    );
  }
  try {
    return createContentAddressedAsset({
      sha256: record.sha256,
      mimeType: record.mimeType,
      byteLength: record.byteLength,
      bytes,
    });
  } catch {
    throw new IndexedDbPersistenceError(
      "PERSISTENCE_INDEXEDDB_ASSET_UNREADABLE",
    );
  }
}

function storeAsset(asset: ContentAddressedAsset): StoredAsset {
  return {
    sha256: asset.sha256,
    mimeType: asset.mimeType,
    byteLength: asset.byteLength,
    bytes: asset.bytes,
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function copyRevision(revision: CompleteSceneRevision): CompleteSceneRevision {
  return createCompleteRevision({
    documentId: revision.documentId,
    revisionId: revision.revisionId,
    sequence: revision.sequence,
    document: revision.document,
  });
}

function storeRevision(revision: CompleteSceneRevision): StoredRevision {
  return {
    documentId: revision.documentId,
    revisionId: revision.revisionId,
    sequence: revision.sequence,
    document: revision.document,
    canonicalization: revision.canonicalization,
    canonicalBytes: revision.canonicalBytes,
  };
}

function readStoredRevision(
  record: StoredRevision,
): CompleteSceneRevision | null {
  try {
    const canonicalBytes = copyStoredUint8Array(record.canonicalBytes);
    if (canonicalBytes === null) return null;
    const revision = createCompleteRevision(record);
    return record.canonicalization.identifier ===
      revision.canonicalization.identifier &&
      record.canonicalization.byteLength ===
        revision.canonicalization.byteLength &&
      sameBytes(canonicalBytes, revision.canonicalBytes)
      ? revision
      : null;
  } catch {
    return null;
  }
}

function readAutosaveCandidate(record: StoredRevision): AutosaveCandidate {
  const canonicalBytes = copyStoredUint8Array(record.canonicalBytes);
  const revision = readStoredRevision(record);
  if (revision !== null) return createValidAutosaveCandidate(revision);

  return createInvalidAutosaveCandidate({
    documentId: record.documentId,
    revisionId: record.revisionId,
    sequence: record.sequence,
    reason:
      record.document === undefined ||
      record.canonicalization === undefined ||
      canonicalBytes === null
        ? "incomplete"
        : "corrupt",
  });
}

function sameRevision(
  pointer: SavedRevisionPointer | DraftRevisionPointer,
  revision: CompleteSceneRevision,
): boolean {
  return (
    pointer.documentId === revision.documentId &&
    pointer.revisionId === revision.revisionId &&
    pointer.sequence === revision.sequence
  );
}

async function storedPointerIsComplete(
  revisions: Table<StoredRevision, [string, string]>,
  documentId: string,
  pointer: SavedRevisionPointer | DraftRevisionPointer | null,
): Promise<boolean> {
  if (pointer === null) return true;
  if (pointer.documentId !== documentId) return false;
  const record = await revisions.get([pointer.documentId, pointer.revisionId]);
  const revision = record === undefined ? null : readStoredRevision(record);
  return revision !== null && sameRevision(pointer, revision);
}

function compareNewestRevision(
  left: CompleteSceneRevision,
  right: CompleteSceneRevision,
): number {
  const sequenceDifference = right.sequence - left.sequence;
  return sequenceDifference === 0
    ? left.revisionId < right.revisionId
      ? -1
      : left.revisionId > right.revisionId
        ? 1
        : 0
    : sequenceDifference;
}

function currentPointerIsComplete(
  pointer: SavedRevisionPointer | DraftRevisionPointer | null,
  current: CompleteSceneRevision,
): boolean {
  return (
    pointer === null ||
    (pointer.documentId === current.documentId &&
      sameRevision(pointer, current))
  );
}

function pointerSnapshot(
  record: StoredPointers,
): RevisionPointersSnapshot | null {
  try {
    return createRevisionPointersSnapshot(record);
  } catch {
    return null;
  }
}

async function sealApproval(record: UnsealedApproval): Promise<string> {
  return sha256(
    capturedEncode(
      capturedJsonStringify({ ...record, integrityHash: undefined }),
    ),
  );
}

async function storeApproval(record: ApprovalRecord): Promise<StoredApproval> {
  const approval = validateApprovalRecord(record);
  const unsealed = {
    documentId: approval.documentId,
    revisionId: approval.revisionId,
    snapshotHash: approval.snapshotHash,
    approvalEnvelopeBytes: approval.approvalEnvelopeBytes,
    canonicalDocumentBytes: approval.canonicalDocumentBytes,
    verifiedAssetManifest: approval.verifiedAssetManifest,
    audit: approval.audit,
  };
  return { ...unsealed, integrityHash: await sealApproval(unsealed) };
}

async function readStoredApproval(record: StoredApproval) {
  try {
    const approvalEnvelopeBytes = copyStoredUint8Array(
      record.approvalEnvelopeBytes,
    );
    const canonicalDocumentBytes = copyStoredUint8Array(
      record.canonicalDocumentBytes,
    );
    if (approvalEnvelopeBytes === null || canonicalDocumentBytes === null) {
      throw new Error("invalid approval bytes");
    }
    const unsealed = {
      documentId: record.documentId,
      revisionId: record.revisionId,
      snapshotHash: record.snapshotHash,
      approvalEnvelopeBytes,
      canonicalDocumentBytes,
      verifiedAssetManifest: record.verifiedAssetManifest,
      audit: record.audit,
    };
    if (record.integrityHash !== (await sealApproval(unsealed))) {
      throw new Error();
    }
    const parsed = capturedJsonParse(capturedDecode(approvalEnvelopeBytes));
    const approvalEnvelope = await createApprovalEnvelope({
      document: parsed.document,
      runtimeVersion: parsed.runtimeVersion,
      verifiedAssetManifest: record.verifiedAssetManifest,
    });
    return createApprovalRecord({
      documentId: record.documentId,
      revisionId: record.revisionId,
      approvalEnvelope,
      snapshotHash: record.snapshotHash,
      approvalEnvelopeBytes,
      canonicalDocumentBytes,
      verifiedAssetManifest: record.verifiedAssetManifest,
      audit: record.audit,
    });
  } catch {
    throw new IndexedDbPersistenceError("PERSISTENCE_INDEXEDDB_WRITE_FAILED");
  }
}

async function verifyApprovalAssets(
  record: ApprovalRecord,
  readAsset: (sha256: string) => Promise<ContentAddressedAsset>,
): Promise<void> {
  const manifest = record.verifiedAssetManifest;
  let index = 0;
  while (index < manifest.length) {
    const expected = manifest[index];
    if (expected === undefined) {
      throw new IndexedDbPersistenceError(
        "PERSISTENCE_INDEXEDDB_ASSET_CONFLICT",
      );
    }
    const asset = await readAsset(expected.sha256);
    if (
      asset.sha256 !== expected.sha256 ||
      asset.mimeType !== expected.mimeType ||
      asset.byteLength !== expected.byteLength
    ) {
      throw new IndexedDbPersistenceError(
        "PERSISTENCE_INDEXEDDB_ASSET_CONFLICT",
      );
    }
    index += 1;
  }
}

function isQuotaExceededError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { readonly name?: unknown }).name === "QuotaExceededError"
  );
}

export function createIndexedDbPersistenceAdapter(input: {
  readonly databaseName: string;
  readonly injectAssetWriteFailure?: () => void;
  readonly injectPointerPublicationFailure?: () => void;
}): PersistenceAdapterPort &
  IndexedDbAutosaveStorage &
  IndexedDbApprovalStorage &
  AssetPersistencePort {
  const database = new PersistenceDatabase(input.databaseName);

  const readAsset = async (
    assetHash: string,
  ): Promise<ContentAddressedAsset> => {
    let record: StoredAsset | undefined;
    try {
      record = await database.assets.get(assetHash);
    } catch {
      throw new IndexedDbPersistenceError(
        "PERSISTENCE_INDEXEDDB_ASSET_UNREADABLE",
      );
    }
    if (record === undefined) {
      throw new IndexedDbPersistenceError(
        "PERSISTENCE_INDEXEDDB_ASSET_MISSING",
      );
    }
    return Dexie.waitFor(readStoredAsset(record));
  };

  return {
    readAsset,

    async readApproval(documentId: string, revisionId: string) {
      const stored = await database.approvals.get([documentId, revisionId]);
      return stored === undefined ? null : readStoredApproval(stored);
    },

    async writeApproval(record: ApprovalRecord) {
      const approval = validateApprovalRecord(record);
      try {
        await database.transaction(
          "rw",
          database.approvals,
          database.assets,
          database.revisions,
          database.pointers,
          async () => {
            await verifyApprovalAssets(approval, readAsset);
            const existing = await database.approvals.get([
              approval.documentId,
              approval.revisionId,
            ]);
            if (existing === undefined) {
              await database.approvals.add(
                await Dexie.waitFor(storeApproval(approval)),
              );
              return;
            }
            reuseIdenticalApprovalRecord(
              await Dexie.waitFor(readStoredApproval(existing)),
              approval,
            );
          },
        );
      } catch (error) {
        if (
          error instanceof IndexedDbPersistenceError ||
          (error instanceof Error &&
            error.name === "PersistenceValidationError")
        ) {
          throw error;
        }
        throw new IndexedDbPersistenceError(
          isQuotaExceededError(error)
            ? "PERSISTENCE_INDEXEDDB_QUOTA_EXCEEDED"
            : "PERSISTENCE_INDEXEDDB_WRITE_FAILED",
        );
      }
    },

    async writeAsset(assetInput) {
      const bytes = assetInput.bytes.slice();
      const asset = createContentAddressedAsset({
        sha256: await sha256(bytes),
        mimeType: assetInput.mimeType,
        byteLength: bytes.byteLength,
        bytes,
      });
      try {
        await database.transaction("rw", database.assets, async () => {
          const existing = await database.assets.get(asset.sha256);
          if (existing === undefined) {
            input.injectAssetWriteFailure?.();
            await database.assets.add(storeAsset(asset));
            return;
          }
          const verified = await readStoredAsset(existing);
          if (
            verified.mimeType !== asset.mimeType ||
            verified.byteLength !== asset.byteLength ||
            !sameBytes(verified.bytes, asset.bytes)
          ) {
            throw new IndexedDbPersistenceError(
              "PERSISTENCE_INDEXEDDB_ASSET_CONFLICT",
            );
          }
        });
      } catch (error) {
        if (error instanceof IndexedDbPersistenceError) throw error;
        throw new IndexedDbPersistenceError(
          isQuotaExceededError(error)
            ? "PERSISTENCE_INDEXEDDB_QUOTA_EXCEEDED"
            : "PERSISTENCE_INDEXEDDB_WRITE_FAILED",
        );
      }
      return asset;
    },

    async readRevision(documentId, revisionId) {
      const record = await database.revisions.get([documentId, revisionId]);
      return record === undefined ? null : readStoredRevision(record);
    },

    async readAutosaveRevisions(documentId) {
      const records = await database.autosaves
        .where("documentId")
        .equals(documentId)
        .toArray();
      return records
        .map(readStoredRevision)
        .filter(
          (revision): revision is CompleteSceneRevision => revision !== null,
        )
        .sort(compareNewestRevision);
    },

    async readRecoveryOffer(documentId) {
      const [records, pointers] = await Promise.all([
        database.autosaves.where("documentId").equals(documentId).toArray(),
        this.readPointers(documentId),
      ]);
      const candidates = records.map(readAutosaveCandidate);
      const result = selectRecoveryOffer({
        documentId,
        autosaveCandidates: candidates,
        savedRevision: pointers.saved,
        discardedRevisionIds: [],
      });
      await Promise.all(
        candidates
          .filter((candidate) => candidate.kind === "invalid-autosave")
          .map((candidate) =>
            database.autosaves.delete([
              candidate.documentId,
              candidate.revisionId,
            ]),
          ),
      );
      return result;
    },

    async readPointers(documentId) {
      const record = await database.pointers.get(documentId);
      if (record === undefined) {
        return createRevisionPointersSnapshot({ saved: null, draft: null });
      }
      const pointers = pointerSnapshot(record);
      if (pointers === null || record.documentId !== documentId) {
        throw new IndexedDbPersistenceError(
          "PERSISTENCE_INDEXEDDB_POINTER_INCOMPLETE",
        );
      }
      const complete = await Promise.all([
        storedPointerIsComplete(database.revisions, documentId, pointers.saved),
        storedPointerIsComplete(database.revisions, documentId, pointers.draft),
      ]);
      if (!complete.every(Boolean)) {
        throw new IndexedDbPersistenceError(
          "PERSISTENCE_INDEXEDDB_POINTER_INCOMPLETE",
        );
      }
      return pointers;
    },

    async writeAutosaveRevision(revision) {
      try {
        const complete = copyRevision(revision);
        await database.transaction(
          "rw",
          database.autosaves,
          database.revisions,
          database.pointers,
          async () => {
            if (
              (await database.revisions.get([
                complete.documentId,
                complete.revisionId,
              ])) !== undefined
            ) {
              throw new IndexedDbPersistenceError(
                "PERSISTENCE_INDEXEDDB_WRITE_FAILED",
              );
            }
            await database.revisions.add(storeRevision(complete));
            await database.autosaves.add(storeRevision(complete));

            const record = await database.pointers.get(complete.documentId);
            const saved =
              record !== undefined && record.documentId === complete.documentId
                ? (pointerSnapshot(record)?.saved ?? null)
                : null;
            const retained = (
              await database.autosaves
                .where("documentId")
                .equals(complete.documentId)
                .toArray()
            )
              .map(readStoredRevision)
              .filter(
                (candidate): candidate is CompleteSceneRevision =>
                  candidate !== null &&
                  candidate.revisionId !== saved?.revisionId,
              )
              .sort(compareNewestRevision)
              .slice(AUTOSAVE_RETENTION_LIMIT);
            for (const candidate of retained) {
              const key: [string, string] = [
                candidate.documentId,
                candidate.revisionId,
              ];
              await database.autosaves.delete(key);
              await database.revisions.delete(key);
            }
          },
        );
      } catch (error) {
        throw new IndexedDbPersistenceError(
          isQuotaExceededError(error)
            ? "PERSISTENCE_INDEXEDDB_QUOTA_EXCEEDED"
            : "PERSISTENCE_INDEXEDDB_WRITE_FAILED",
        );
      }
    },

    async writeCompleteRevision(revision, pointers) {
      try {
        const complete = copyRevision(revision);
        const snapshot = createRevisionPointersSnapshot(pointers);
        await database.transaction(
          "rw",
          database.revisions,
          database.pointers,
          async () => {
            const validPointers = await Promise.all(
              [snapshot.saved, snapshot.draft].map(
                async (pointer) =>
                  currentPointerIsComplete(pointer, complete) ||
                  storedPointerIsComplete(
                    database.revisions,
                    complete.documentId,
                    pointer,
                  ),
              ),
            );
            if (!validPointers.every(Boolean)) {
              throw new IndexedDbPersistenceError(
                "PERSISTENCE_INDEXEDDB_POINTER_INCOMPLETE",
              );
            }
            await database.revisions.put(storeRevision(complete));
            input.injectPointerPublicationFailure?.();
            await database.pointers.put({
              documentId: complete.documentId,
              ...snapshot,
            });
          },
        );
      } catch (error) {
        throw new IndexedDbPersistenceError(
          isQuotaExceededError(error)
            ? "PERSISTENCE_INDEXEDDB_QUOTA_EXCEEDED"
            : "PERSISTENCE_INDEXEDDB_WRITE_FAILED",
        );
      }
    },
  };
}

export async function deleteIndexedDbPersistenceDatabase(
  databaseName: string,
): Promise<void> {
  await Dexie.delete(databaseName);
}
