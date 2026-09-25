import "fake-indexeddb/auto";
import { Dexie } from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_SLICE_DOCUMENT,
  createApprovalEnvelope,
  readCanonicalApprovalEvidence,
} from "@particle-studio/scene-document";
import {
  createApprovalRecord,
  createCompleteRevision,
  createDraftRevisionPointer,
  createRevisionPointersSnapshot,
  createSavedRevisionPointer,
  type ApprovalRecord,
} from "@particle-studio/persistence";
import {
  createIndexedDbPersistenceAdapter,
  deleteIndexedDbPersistenceDatabase,
} from "../src/index.js";

const databaseName = `persistence-indexeddb-${Date.now()}-${Math.random()}`;
const cryptoLike = globalThis as unknown as {
  crypto: {
    subtle: { digest(name: string, data: Uint8Array): Promise<ArrayBuffer> };
  };
};

function separateRealmSubarray(bytes: Uint8Array): Uint8Array {
  const nodeRuntime = globalThis as unknown as {
    readonly process: {
      getBuiltinModule(name: string): {
        runInNewContext(source: string): unknown;
      };
    };
  };
  return nodeRuntime.process
    .getBuiltinModule("node:vm")
    .runInNewContext(
      `new Uint8Array([0, ${Array.from(bytes).join(",")}]).subarray(1, ${
        bytes.byteLength + 1
      })`,
    ) as Uint8Array;
}

const revision = (
  revisionId: string,
  sequence: number,
  documentId = "document-1",
) =>
  createCompleteRevision({
    documentId,
    revisionId,
    sequence,
    document: FIRST_SLICE_DOCUMENT,
  });

afterEach(async () => {
  vi.restoreAllMocks();
  await deleteIndexedDbPersistenceDatabase(databaseName);
});

async function approval(
  options: { readonly approvedAt?: number; readonly asset?: Uint8Array } = {},
): Promise<ApprovalRecord> {
  const bytes = options.asset ?? new Uint8Array([1, 2, 3]);
  const sha256 = await cryptoLike.crypto.subtle
    .digest("SHA-256", bytes)
    .then(
      (digest: ArrayBuffer) =>
        `sha256:${Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("")}`,
    );
  const approvalEnvelope = await createApprovalEnvelope({
    document: FIRST_SLICE_DOCUMENT,
    runtimeVersion: "runtime-v1",
    verifiedAssetManifest: [
      { sha256, mimeType: "image/png", byteLength: bytes.byteLength },
    ],
  });
  const evidence = readCanonicalApprovalEvidence(approvalEnvelope);
  return createApprovalRecord({
    documentId: "document-1",
    revisionId: "revision-1",
    approvalEnvelope,
    snapshotHash: evidence.snapshotHash,
    approvalEnvelopeBytes: evidence.approvalEnvelopeBytes,
    canonicalDocumentBytes: evidence.canonicalDocumentBytes,
    verifiedAssetManifest: evidence.verifiedAssetManifest,
    audit: { approvedAt: options.approvedAt ?? 10, actorLabel: "local-human" },
  });
}

describe("IndexedDB content-addressed assets", () => {
  it("derives an immutable SHA-256 identity, returns defensive bytes, and is idempotent across adapters", async () => {
    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    const input = new Uint8Array([1, 2, 3]);

    const first = await adapter.writeAsset({
      mimeType: "image/png",
      bytes: input,
    });
    input[0] = 9;
    const returned = first.bytes;
    returned[1] = 9;

    expect(first).toMatchObject({
      sha256:
        "sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
      mimeType: "image/png",
      byteLength: 3,
    });
    expect(first.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(first.bytes).not.toBe(returned);
    expect(await adapter.readPointers("document-1")).toEqual({
      saved: null,
      draft: null,
    });
    expect(await adapter.readRevision("document-1", "asset-write")).toBeNull();

    const reloaded = createIndexedDbPersistenceAdapter({ databaseName });
    await expect(
      reloaded.writeAsset({
        mimeType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).resolves.toEqual(first);
    expect(await reloaded.readAsset(first.sha256)).toEqual(first);
  });

  it("uses captured SHA-256 without invoking a poisoned digest", async () => {
    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    let callbacks = 0;
    vi.spyOn(cryptoLike.crypto.subtle, "digest").mockImplementation(() => {
      callbacks += 1;
      return Promise.resolve(new ArrayBuffer(32));
    });
    await adapter.writeAsset({
      mimeType: "image/png",
      bytes: new Uint8Array([1]),
    });
    expect(callbacks).toBe(0);
  });

  it("rejects a same-address metadata conflict while preserving the original durable asset, revision, and pointers", async () => {
    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    const saved = revision("saved-1", 1);
    const pointers = createRevisionPointersSnapshot({
      saved: createSavedRevisionPointer(saved),
      draft: createDraftRevisionPointer(saved),
    });
    await adapter.writeCompleteRevision(saved, pointers);
    const original = await adapter.writeAsset({
      mimeType: "image/png",
      bytes: new Uint8Array([7, 8, 9]),
    });

    await expect(
      adapter.writeAsset({
        mimeType: "image/png",
        bytes: new Uint8Array([7, 8, 9]),
      }),
    ).resolves.toEqual(original);
    await expect(
      adapter.writeAsset({
        mimeType: "application/octet-stream",
        bytes: new Uint8Array([7, 8, 9]),
      }),
    ).rejects.toMatchObject({
      code: "PERSISTENCE_INDEXEDDB_ASSET_CONFLICT",
    });

    expect(await adapter.readAsset(original.sha256)).toEqual(original);
    expect(await adapter.readRevision("document-1", "saved-1")).toEqual(saved);
    expect(await adapter.readPointers("document-1")).toEqual(pointers);
  });

  it("distinguishes missing, unreadable, mismatched, and quota failures without touching revisions or pointers", async () => {
    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    const saved = revision("saved-1", 1);
    const pointers = createRevisionPointersSnapshot({
      saved: createSavedRevisionPointer(saved),
      draft: createDraftRevisionPointer(saved),
    });
    await adapter.writeCompleteRevision(saved, pointers);
    const expectedHash =
      "sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";

    await expect(adapter.readAsset(expectedHash)).rejects.toMatchObject({
      code: "PERSISTENCE_INDEXEDDB_ASSET_MISSING",
    });
    const database = new Dexie(databaseName);
    database.version(3).stores({ assets: "sha256" });
    await database.table("assets").put({
      sha256: expectedHash,
      mimeType: "image/png",
      byteLength: 3,
      bytes: new Uint8Array([4, 5, 6]),
    });
    const unreadableHash = `sha256:${"a".repeat(64)}`;
    await database.table("assets").put({
      sha256: unreadableHash,
      mimeType: "image/png",
      byteLength: 3,
      bytes: new Uint8Array([1, 2]),
    });
    database.close();
    await expect(adapter.readAsset(expectedHash)).rejects.toMatchObject({
      code: "PERSISTENCE_INDEXEDDB_ASSET_HASH_MISMATCH",
    });
    await expect(adapter.readAsset(unreadableHash)).rejects.toMatchObject({
      code: "PERSISTENCE_INDEXEDDB_ASSET_UNREADABLE",
    });
    await expect(
      adapter.writeAsset({
        mimeType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toMatchObject({
      code: "PERSISTENCE_INDEXEDDB_ASSET_HASH_MISMATCH",
    });
    await expect(adapter.readAsset(expectedHash)).rejects.toMatchObject({
      code: "PERSISTENCE_INDEXEDDB_ASSET_HASH_MISMATCH",
    });

    const quotaAdapter = createIndexedDbPersistenceAdapter({
      databaseName,
      injectAssetWriteFailure() {
        throw Object.assign(new Error("quota exceeded"), {
          name: "QuotaExceededError",
        });
      },
    });
    await expect(
      quotaAdapter.writeAsset({
        mimeType: "image/png",
        bytes: new Uint8Array([7]),
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_INDEXEDDB_QUOTA_EXCEEDED" });
    expect(await adapter.readRevision("document-1", "saved-1")).toEqual(saved);
    expect(await adapter.readPointers("document-1")).toEqual(pointers);
  });
});

describe("cross-realm IndexedDB durable-byte reads", () => {
  it("accepts a genuine separate-realm stored asset subarray and isolates its returned bytes", async () => {
    const localBytes = new Uint8Array([1, 2, 3]);
    const writer = createIndexedDbPersistenceAdapter({ databaseName });
    const stored = await writer.writeAsset({
      mimeType: "image/png",
      bytes: localBytes,
    });
    const database = new Dexie(databaseName);
    database.version(3).stores({ assets: "sha256" });
    await database.table("assets").update(stored.sha256, {
      bytes: separateRealmSubarray(localBytes),
    });
    database.close();

    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    const asset = await adapter.readAsset(stored.sha256);
    expect(asset.bytes).toEqual(localBytes);
    asset.bytes[0] = 9;
    expect((await adapter.readAsset(stored.sha256)).bytes).toEqual(localBytes);
  });

  it("rejects hostile stored byte views through IndexedDB while retaining ordinary zero-length Uint8Array bytes", async () => {
    const database = new Dexie(databaseName);
    database.version(3).stores({ assets: "sha256" });
    const invalidViews: readonly [string, unknown][] = [
      ["clamped", new Uint8ClampedArray([1, 2, 3])],
      ["int8", new Int8Array([1, 2, 3])],
      ["uint16", new Uint16Array([1, 2, 3])],
      ["float32", new Float32Array([1, 2, 3])],
      ["bigint64", new BigInt64Array([1n])],
      ["data-view", new DataView(new ArrayBuffer(3))],
      ["array-buffer", new ArrayBuffer(3)],
      ["shared-buffer", new Uint8Array(new SharedArrayBuffer(3))],
    ];
    for (const [index, [, bytes]] of invalidViews.entries()) {
      await database.table("assets").put({
        sha256: `sha256:${index.toString(16).repeat(64)}`,
        mimeType: "image/png",
        byteLength: 3,
        bytes,
      });
    }
    database.close();

    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    for (const [index] of invalidViews.entries()) {
      await expect(
        adapter.readAsset(`sha256:${index.toString(16).repeat(64)}`),
      ).rejects.toMatchObject({
        code: "PERSISTENCE_INDEXEDDB_ASSET_UNREADABLE",
      });
    }
    const empty = await adapter.writeAsset({
      mimeType: "application/octet-stream",
      bytes: new Uint8Array(),
    });
    const zeroLengthDatabase = new Dexie(databaseName);
    zeroLengthDatabase.version(3).stores({ assets: "sha256" });
    await zeroLengthDatabase
      .table("assets")
      .update(empty.sha256, { bytes: separateRealmSubarray(new Uint8Array()) });
    zeroLengthDatabase.close();
    expect((await adapter.readAsset(empty.sha256)).bytes).toEqual(
      new Uint8Array(),
    );
  });

  it("uses fake IndexedDB storage to reject uncloneable proxy byte records", async () => {
    const database = new Dexie(databaseName);
    database.version(3).stores({ assets: "sha256" });
    const proxiedBytes = new Proxy(new Uint8Array([1]), {});
    const revoked = Proxy.revocable(new Uint8Array([1]), {});
    revoked.revoke();
    for (const [index, bytes] of [proxiedBytes, revoked.proxy].entries()) {
      await expect(
        database.table("assets").put({
          sha256: `sha256:${(index + 8).toString(16).repeat(64)}`,
          mimeType: "image/png",
          byteLength: 1,
          bytes,
        }),
      ).rejects.toBeDefined();
    }
    database.close();
  });

  it("maps invalid revision and autosave byte views to incomplete", async () => {
    const pointerRevision = revision("invalid-pointer", 1, "pointer-document");
    const autosaveRevision = revision("invalid-autosave", 2);
    const pointer = createSavedRevisionPointer(pointerRevision);
    const writer = createIndexedDbPersistenceAdapter({ databaseName });
    await writer.writeCompleteRevision(
      pointerRevision,
      createRevisionPointersSnapshot({ saved: pointer, draft: null }),
    );
    await writer.writeAutosaveRevision(autosaveRevision);
    const database = new Dexie(databaseName);
    database.version(2).stores({
      revisions: "[documentId+revisionId], documentId",
      pointers: "documentId",
      autosaves: "[documentId+revisionId], documentId",
    });
    await database
      .table("revisions")
      .update([pointerRevision.documentId, pointerRevision.revisionId], {
        canonicalBytes: new DataView(new ArrayBuffer(1)),
      });
    await database
      .table("autosaves")
      .update([autosaveRevision.documentId, autosaveRevision.revisionId], {
        canonicalBytes: new ArrayBuffer(1),
      });
    database.close();

    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    await expect(
      adapter.readPointers(pointerRevision.documentId),
    ).rejects.toMatchObject({
      code: "PERSISTENCE_INDEXEDDB_POINTER_INCOMPLETE",
    });
    await expect(
      adapter.readRecoveryOffer(autosaveRevision.documentId),
    ).resolves.toMatchObject({
      diagnostics: [
        {
          documentId: autosaveRevision.documentId,
          revisionId: autosaveRevision.revisionId,
          sequence: autosaveRevision.sequence,
          reason: "incomplete",
        },
      ],
    });
  });

  it("accepts a genuine separate-realm revision subarray when completing a stored pointer", async () => {
    const source = revision("foreign-revision", 1);
    const pointer = createSavedRevisionPointer(source);
    const writer = createIndexedDbPersistenceAdapter({ databaseName });
    await writer.writeCompleteRevision(
      source,
      createRevisionPointersSnapshot({ saved: pointer, draft: null }),
    );
    const database = new Dexie(databaseName);
    database.version(1).stores({
      revisions: "[documentId+revisionId], documentId",
      pointers: "documentId",
    });
    await database
      .table("revisions")
      .update([source.documentId, source.revisionId], {
        canonicalBytes: separateRealmSubarray(source.canonicalBytes),
      });
    database.close();

    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    await expect(adapter.readPointers(source.documentId)).resolves.toEqual({
      saved: pointer,
      draft: null,
    });
    const loaded = await adapter.readRevision(
      source.documentId,
      source.revisionId,
    );
    expect(loaded).not.toBeNull();
    const returnedBytes = loaded?.canonicalBytes;
    returnedBytes?.fill(0);
    expect(
      (await adapter.readRevision(source.documentId, source.revisionId))
        ?.canonicalBytes,
    ).toEqual(source.canonicalBytes);
  });

  it("classifies a genuine separate-realm autosave subarray as valid", async () => {
    const source = revision("foreign-autosave", 1);
    const writer = createIndexedDbPersistenceAdapter({ databaseName });
    await writer.writeAutosaveRevision(source);
    const database = new Dexie(databaseName);
    database.version(2).stores({
      revisions: "[documentId+revisionId], documentId",
      pointers: "documentId",
      autosaves: "[documentId+revisionId], documentId",
    });
    await database
      .table("autosaves")
      .update([source.documentId, source.revisionId], {
        canonicalBytes: separateRealmSubarray(source.canonicalBytes),
      });
    database.close();

    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    await expect(
      adapter.readAutosaveRevisions(source.documentId),
    ).resolves.toEqual([source]);
    await expect(
      adapter.readRecoveryOffer(source.documentId),
    ).resolves.toMatchObject({
      offer: { revision: source },
      diagnostics: [],
    });
  });
});

describe("IndexedDB approval persistence", () => {
  it("accepts genuine separate-realm approval subarrays and returns mutation-isolated bytes", async () => {
    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    const record = await approval();
    const asset = record.verifiedAssetManifest[0]!;
    await adapter.writeAsset({
      mimeType: asset.mimeType,
      bytes: new Uint8Array([1, 2, 3]),
    });
    await adapter.writeApproval(record);

    const approvalEnvelopeBytes = separateRealmSubarray(
      record.approvalEnvelopeBytes,
    );
    const canonicalDocumentBytes = separateRealmSubarray(
      record.canonicalDocumentBytes,
    );
    expect(approvalEnvelopeBytes).not.toBeInstanceOf(Uint8Array);
    expect(canonicalDocumentBytes).not.toBeInstanceOf(Uint8Array);
    let readerDatabase: Dexie | undefined;
    const open = Dexie.prototype.open;
    vi.spyOn(Dexie.prototype, "open").mockImplementation(function (
      this: Dexie,
    ) {
      readerDatabase = this;
      return open.call(this);
    });
    const reader = createIndexedDbPersistenceAdapter({ databaseName });
    await reader.readApproval(record.documentId, record.revisionId);
    const storedTable = (
      readerDatabase as
        | (Dexie & { approvals: ReturnType<Dexie["table"]> })
        | undefined
    )?.approvals;
    if (storedTable === undefined) throw new Error("reader database missing");
    const get = storedTable.get.bind(storedTable);
    let injected = false;
    storedTable.get = ((key: [string, string]) =>
      get(key).then((stored) => {
        injected = true;
        return stored === undefined
          ? undefined
          : {
              ...(stored as object),
              approvalEnvelopeBytes,
              canonicalDocumentBytes,
            };
      })) as typeof storedTable.get;

    const loaded = await reader.readApproval(
      record.documentId,
      record.revisionId,
    );
    expect(injected).toBe(true);
    expect(loaded?.approvalEnvelopeBytes).toEqual(record.approvalEnvelopeBytes);
    expect(loaded?.canonicalDocumentBytes).toEqual(
      record.canonicalDocumentBytes,
    );
    loaded?.approvalEnvelopeBytes.fill(0);
    loaded?.canonicalDocumentBytes.fill(0);
    await expect(
      reader.readApproval(record.documentId, record.revisionId),
    ).resolves.toMatchObject({
      approvalEnvelopeBytes: record.approvalEnvelopeBytes,
      canonicalDocumentBytes: record.canonicalDocumentBytes,
    });
  });

  it("maps either invalid stored approval byte field to the existing write failure", async () => {
    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    const record = await approval();
    const asset = record.verifiedAssetManifest[0]!;
    await adapter.writeAsset({
      mimeType: asset.mimeType,
      bytes: new Uint8Array([1, 2, 3]),
    });
    await adapter.writeApproval(record);

    const database = new Dexie(databaseName);
    database.version(4).stores({
      approvals: "[documentId+revisionId], snapshotHash",
    });
    for (const invalidBytes of [
      new DataView(new ArrayBuffer(1)),
      new ArrayBuffer(1),
    ]) {
      await database
        .table("approvals")
        .update([record.documentId, record.revisionId], {
          approvalEnvelopeBytes: invalidBytes,
        });
      await expect(
        adapter.readApproval(record.documentId, record.revisionId),
      ).rejects.toMatchObject({
        code: "PERSISTENCE_INDEXEDDB_WRITE_FAILED",
      });
      await database
        .table("approvals")
        .update([record.documentId, record.revisionId], {
          approvalEnvelopeBytes: record.approvalEnvelopeBytes,
        });

      await database
        .table("approvals")
        .update([record.documentId, record.revisionId], {
          canonicalDocumentBytes: invalidBytes,
        });
      await expect(
        adapter.readApproval(record.documentId, record.revisionId),
      ).rejects.toMatchObject({
        code: "PERSISTENCE_INDEXEDDB_WRITE_FAILED",
      });
      await database
        .table("approvals")
        .update([record.documentId, record.revisionId], {
          canonicalDocumentBytes: record.canonicalDocumentBytes,
        });
    }
    database.close();
  });

  it("rereads every manifest asset in canonical order and reloads a genuine immutable approval", async () => {
    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    const record = await approval();
    const asset = record.verifiedAssetManifest[0]!;
    await adapter.writeAsset({
      mimeType: asset.mimeType,
      bytes: new Uint8Array([1, 2, 3]),
    });

    await adapter.writeApproval(record);
    const reloaded = await adapter.readApproval(
      record.documentId,
      record.revisionId,
    );

    expect(reloaded).not.toBeNull();
    expect(reloaded).not.toBe(record);
    expect(reloaded?.snapshotHash).toBe(record.snapshotHash);
    expect(reloaded?.approvalEnvelopeBytes).toEqual(
      record.approvalEnvelopeBytes,
    );
    await expect(adapter.writeApproval({ ...record })).rejects.toMatchObject({
      code: "PERSISTENCE_APPROVAL_RECORD_INVALID",
    });
    const database = new Dexie(databaseName);
    database.version(4).stores({
      approvals: "[documentId+revisionId], snapshotHash",
    });
    await database
      .table("approvals")
      .update([record.documentId, record.revisionId], {
        "audit.approvedAt": 11,
      });
    database.close();
    await expect(
      adapter.readApproval(record.documentId, record.revisionId),
    ).rejects.toMatchObject({ code: "PERSISTENCE_INDEXEDDB_WRITE_FAILED" });
  });

  it("preserves the original approval for byte-identical retries and rejects conflicts", async () => {
    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    const original = await approval({ approvedAt: 10 });
    const retry = await approval({ approvedAt: 11 });
    const asset = original.verifiedAssetManifest[0]!;
    await adapter.writeAsset({
      mimeType: asset.mimeType,
      bytes: new Uint8Array([1, 2, 3]),
    });

    await adapter.writeApproval(original);
    await adapter.writeApproval(retry);
    expect(
      (await adapter.readApproval("document-1", "revision-1"))?.audit,
    ).toEqual(original.audit);
    const conflicting = await approval({ asset: new Uint8Array([4, 5, 6]) });
    const conflictingAsset = conflicting.verifiedAssetManifest[0]!;
    await adapter.writeAsset({
      mimeType: conflictingAsset.mimeType,
      bytes: new Uint8Array([4, 5, 6]),
    });
    await expect(adapter.writeApproval(conflicting)).rejects.toMatchObject({
      code: "PERSISTENCE_APPROVAL_RECORD_CONFLICT",
    });
  });

  it("rolls back missing, hash, MIME, and length failures without changing revisions or pointers", async () => {
    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    const record = await approval();
    const saved = revision("saved-1", 1);
    const pointers = createRevisionPointersSnapshot({
      saved: createSavedRevisionPointer(saved),
      draft: createDraftRevisionPointer(saved),
    });
    await adapter.writeCompleteRevision(saved, pointers);

    await expect(adapter.writeApproval(record)).rejects.toMatchObject({
      code: "PERSISTENCE_INDEXEDDB_ASSET_MISSING",
    });
    const asset = record.verifiedAssetManifest[0]!;
    const database = new Dexie(databaseName);
    database.version(4).stores({ assets: "sha256" });
    await database.table("assets").put({
      sha256: asset.sha256,
      mimeType: asset.mimeType,
      byteLength: 3,
      bytes: new Uint8Array([4, 5, 6]),
    });
    await expect(adapter.writeApproval(record)).rejects.toMatchObject({
      code: "PERSISTENCE_INDEXEDDB_ASSET_HASH_MISMATCH",
    });
    await database.table("assets").put({
      sha256: asset.sha256,
      mimeType: "application/octet-stream",
      byteLength: 3,
      bytes: new Uint8Array([1, 2, 3]),
    });
    await expect(adapter.writeApproval(record)).rejects.toMatchObject({
      code: "PERSISTENCE_INDEXEDDB_ASSET_CONFLICT",
    });
    await database.table("assets").put({
      sha256: asset.sha256,
      mimeType: asset.mimeType,
      byteLength: 2,
      bytes: new Uint8Array([1, 2, 3]),
    });
    database.close();
    await expect(adapter.writeApproval(record)).rejects.toMatchObject({
      code: "PERSISTENCE_INDEXEDDB_ASSET_UNREADABLE",
    });
    expect(await adapter.readApproval("document-1", "revision-1")).toBeNull();
    expect(await adapter.readRevision("document-1", "saved-1")).toEqual(saved);
    expect(await adapter.readPointers("document-1")).toEqual(pointers);
  });
});

describe("IndexedDB persistence adapter", () => {
  it("publishes separate saved and draft pointers only for complete revisions", async () => {
    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    const saved = revision("saved-1", 1);
    const draft = revision("draft-2", 2);

    await adapter.writeCompleteRevision(
      saved,
      createRevisionPointersSnapshot({
        saved: createSavedRevisionPointer(saved),
        draft: null,
      }),
    );
    await adapter.writeCompleteRevision(
      draft,
      createRevisionPointersSnapshot({
        saved: createSavedRevisionPointer(saved),
        draft: createDraftRevisionPointer(draft),
      }),
    );

    const reloaded = createIndexedDbPersistenceAdapter({ databaseName });
    expect(await reloaded.readPointers("document-1")).toEqual({
      saved: createSavedRevisionPointer(saved),
      draft: createDraftRevisionPointer(draft),
    });
    expect(await reloaded.readRevision("document-1", "draft-2")).toEqual(draft);
  });

  it("rejects an autosave collision without invalidating the saved bytes or pointers", async () => {
    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    const saved = revision("shared-revision", 4);
    const savedPointers = createRevisionPointersSnapshot({
      saved: createSavedRevisionPointer(saved),
      draft: createDraftRevisionPointer(saved),
    });
    await adapter.writeCompleteRevision(saved, savedPointers);

    const conflictingAutosave = revision("shared-revision", 8);
    await expect(
      adapter.writeAutosaveRevision(conflictingAutosave),
    ).rejects.toMatchObject({ code: "PERSISTENCE_INDEXEDDB_WRITE_FAILED" });
    expect(await adapter.readRevision("document-1", "shared-revision")).toEqual(
      saved,
    );
    expect(await adapter.readPointers("document-1")).toEqual(savedPointers);
  });

  it("retains the ten newest complete autosaves while protecting the saved revision", async () => {
    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    const saved = revision("saved-1", 1);
    const savedPointers = createRevisionPointersSnapshot({
      saved: createSavedRevisionPointer(saved),
      draft: null,
    });
    await adapter.writeCompleteRevision(saved, savedPointers);

    for (let sequence = 2; sequence <= 12; sequence += 1) {
      await adapter.writeAutosaveRevision(
        revision(`autosave-${sequence}`, sequence),
      );
    }

    expect(
      (await adapter.readAutosaveRevisions("document-1")).map(
        ({ revisionId }) => revisionId,
      ),
    ).toEqual([
      "autosave-12",
      "autosave-11",
      "autosave-10",
      "autosave-9",
      "autosave-8",
      "autosave-7",
      "autosave-6",
      "autosave-5",
      "autosave-4",
      "autosave-3",
    ]);
    expect(await adapter.readRevision("document-1", "saved-1")).toEqual(saved);
    expect(await adapter.readPointers("document-1")).toEqual(savedPointers);
  });

  it("orders equal-sequence autosaves by revision ID and excludes a saved autosave", async () => {
    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    const saved = revision("saved-autosave", 1);
    await adapter.writeAutosaveRevision(saved);
    const savedPointers = createRevisionPointersSnapshot({
      saved: createSavedRevisionPointer(saved),
      draft: null,
    });
    await adapter.writeCompleteRevision(saved, savedPointers);

    for (let sequence = 2; sequence <= 11; sequence += 1) {
      await adapter.writeAutosaveRevision(
        revision(`autosave-${sequence}`, sequence),
      );
    }
    await adapter.writeAutosaveRevision(revision("tie-z", 12));
    await adapter.writeAutosaveRevision(revision("tie-a", 12));

    expect(
      (await adapter.readAutosaveRevisions("document-1")).map(
        ({ revisionId }) => revisionId,
      ),
    ).toEqual([
      "tie-a",
      "tie-z",
      "autosave-11",
      "autosave-10",
      "autosave-9",
      "autosave-8",
      "autosave-7",
      "autosave-6",
      "autosave-5",
      "autosave-4",
      "saved-autosave",
    ]);
    expect(await adapter.readPointers("document-1")).toEqual(savedPointers);
  });

  it("rolls back a quota failure while publishing pointers", async () => {
    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    const saved = revision("saved-1", 1);
    const previousPointers = createRevisionPointersSnapshot({
      saved: createSavedRevisionPointer(saved),
      draft: createDraftRevisionPointer(saved),
    });
    await adapter.writeCompleteRevision(saved, previousPointers);

    const rejected = revision("draft-2", 2);
    const quotaFailingAdapter = createIndexedDbPersistenceAdapter({
      databaseName,
      injectPointerPublicationFailure() {
        throw Object.assign(new Error("quota exceeded"), {
          name: "QuotaExceededError",
        });
      },
    });

    await expect(
      quotaFailingAdapter.writeCompleteRevision(
        rejected,
        createRevisionPointersSnapshot({
          saved: createSavedRevisionPointer(saved),
          draft: createDraftRevisionPointer(rejected),
        }),
      ),
    ).rejects.toMatchObject({ code: "PERSISTENCE_INDEXEDDB_QUOTA_EXCEEDED" });
    expect(await adapter.readRevision("document-1", "draft-2")).toBeNull();
    expect(await adapter.readPointers("document-1")).toEqual(previousPointers);
  });

  it("keeps generic write failures and other documents isolated", async () => {
    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    const foreign = revision("foreign-1", 1, "document-2");
    const foreignPointers = createRevisionPointersSnapshot({
      saved: createSavedRevisionPointer(foreign),
      draft: createDraftRevisionPointer(foreign),
    });
    await adapter.writeCompleteRevision(foreign, foreignPointers);

    const rejected = revision("local-1", 1);
    const failingAdapter = createIndexedDbPersistenceAdapter({
      databaseName,
      injectPointerPublicationFailure() {
        throw new Error("write failed");
      },
    });

    await expect(
      failingAdapter.writeCompleteRevision(
        rejected,
        createRevisionPointersSnapshot({
          saved: createSavedRevisionPointer(rejected),
          draft: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "PERSISTENCE_INDEXEDDB_WRITE_FAILED" });
    expect(await adapter.readRevision("document-1", "local-1")).toBeNull();
    expect(await adapter.readPointers("document-2")).toEqual(foreignPointers);
  });

  it("rejects a reloaded pointer belonging to another document", async () => {
    const foreign = revision("foreign-1", 1, "document-2");
    const writer = createIndexedDbPersistenceAdapter({ databaseName });
    await writer.writeCompleteRevision(
      foreign,
      createRevisionPointersSnapshot({
        saved: createSavedRevisionPointer(foreign),
        draft: null,
      }),
    );

    const database = new Dexie(databaseName);
    database.version(1).stores({
      revisions: "[documentId+revisionId], documentId",
      pointers: "documentId",
    });
    await database.table("pointers").put({
      documentId: "document-1",
      saved: createSavedRevisionPointer(foreign),
      draft: null,
    });
    database.close();

    const adapter = createIndexedDbPersistenceAdapter({ databaseName });

    await expect(adapter.readPointers("document-1")).rejects.toMatchObject({
      code: "PERSISTENCE_INDEXEDDB_POINTER_INCOMPLETE",
    });
  });

  it("constructs a diagnostic and fallback before disposing an incomplete autosave", async () => {
    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    const saved = revision("saved-1", 1);
    const fallback = revision("fallback-2", 2);
    const savedPointers = createRevisionPointersSnapshot({
      saved: createSavedRevisionPointer(saved),
      draft: null,
    });
    await adapter.writeCompleteRevision(saved, savedPointers);
    await adapter.writeAutosaveRevision(fallback);

    const database = new Dexie(databaseName);
    database.version(2).stores({
      revisions: "[documentId+revisionId], documentId",
      pointers: "documentId",
      autosaves: "[documentId+revisionId], documentId",
    });
    await database.table("autosaves").put({
      documentId: "document-1",
      revisionId: "incomplete-3",
      sequence: 3,
      document: fallback.document,
      canonicalization: fallback.canonicalization,
    });
    database.close();

    const recovery = adapter as typeof adapter & {
      readRecoveryOffer(documentId: string): Promise<{
        offer: { revision: { revisionId: string } } | null;
        diagnostics: readonly { revisionId: string; reason: string }[];
      }>;
    };

    const firstRead = await recovery.readRecoveryOffer("document-1");
    expect(firstRead.offer?.revision).toEqual(fallback);
    expect(firstRead.diagnostics).toEqual([
      {
        revisionId: "incomplete-3",
        sequence: 3,
        documentId: "document-1",
        reason: "incomplete",
      },
    ]);
    expect(await adapter.readPointers("document-1")).toEqual(savedPointers);

    const secondRead = await recovery.readRecoveryOffer("document-1");
    expect(secondRead.offer?.revision).toEqual(fallback);
    expect(secondRead.diagnostics).toEqual([]);
  });

  it("falls back deterministically after reporting and disposing a corrupt newest autosave", async () => {
    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    const saved = revision("saved-1", 1);
    const fallback = revision("fallback-2", 2);
    const savedPointers = createRevisionPointersSnapshot({
      saved: createSavedRevisionPointer(saved),
      draft: null,
    });
    await adapter.writeCompleteRevision(saved, savedPointers);
    await adapter.writeAutosaveRevision(fallback);

    const database = new Dexie(databaseName);
    database.version(2).stores({
      revisions: "[documentId+revisionId], documentId",
      pointers: "documentId",
      autosaves: "[documentId+revisionId], documentId",
    });
    await database.table("autosaves").put({
      documentId: "document-1",
      revisionId: "corrupt-4",
      sequence: 4,
      document: fallback.document,
      canonicalization: fallback.canonicalization,
      canonicalBytes: new Uint8Array([0]),
    });
    database.close();

    const firstRead = await adapter.readRecoveryOffer("document-1");
    expect(firstRead.offer?.revision.revisionId).toBe("fallback-2");
    expect(firstRead.diagnostics).toEqual([
      {
        documentId: "document-1",
        revisionId: "corrupt-4",
        sequence: 4,
        reason: "corrupt",
      },
    ]);
    expect(await adapter.readPointers("document-1")).toEqual(savedPointers);

    expect((await adapter.readRecoveryOffer("document-1")).diagnostics).toEqual(
      [],
    );
  });

  it("rejects publishing a complete pointer belonging to another document", async () => {
    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    const foreign = revision("foreign-1", 1, "document-2");

    await adapter.writeCompleteRevision(
      foreign,
      createRevisionPointersSnapshot({
        saved: createSavedRevisionPointer(foreign),
        draft: null,
      }),
    );

    await expect(
      adapter.writeCompleteRevision(
        revision("local-1", 1),
        createRevisionPointersSnapshot({
          saved: createSavedRevisionPointer(foreign),
          draft: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "PERSISTENCE_INDEXEDDB_WRITE_FAILED" });
  });
});
