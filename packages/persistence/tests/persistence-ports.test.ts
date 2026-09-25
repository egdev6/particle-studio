import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  FIRST_SLICE_DOCUMENT,
  canonicalizeSceneDocument,
  createApprovalEnvelope,
  readCanonicalApprovalEvidence,
  type SceneDocumentV1,
} from "@particle-studio/scene-document";
import {
  PersistenceValidationError,
  createCompleteRevision,
  createInvalidAutosaveCandidate,
  createValidAutosaveCandidate,
  selectRecoveryOffer,
  acceptRecoveryOffer,
  declineRecoveryOffer,
  discardRecoveryOffer,
  type InvalidAutosaveCandidateReason,
  createDraftRevisionPointer,
  createRevisionPointersSnapshot,
  createSavedRevisionPointer,
  createContentAddressedAsset,
  createApprovalRecord,
  forkApprovedDraft,
  reuseIdenticalApprovalRecord,
  readApprovalRecordRuntimeVersion,
  validateApprovalRecord,
} from "../src/index.js";

const document = () => structuredClone(FIRST_SLICE_DOCUMENT) as SceneDocumentV1;

function expectValidationError(
  input: Parameters<typeof createCompleteRevision>[0],
  code: PersistenceValidationError["code"],
) {
  expect(() => createCompleteRevision(input)).toThrow(
    expect.objectContaining({ code }),
  );
}

describe("content-addressed assets", () => {
  it("validates immutable SHA-256 metadata and isolates caller and returned bytes", () => {
    const input = new Uint8Array([1, 2, 3]);
    const asset = createContentAddressedAsset({
      sha256:
        "sha256:039058c6f2c0cb492c533b0a4d14ef77a0f2b4d4b6a2dc6f2b89b6f63b4b61b5",
      mimeType: "image/png",
      byteLength: input.byteLength,
      bytes: input,
    });

    input[0] = 9;
    const returned = asset.bytes;
    returned[1] = 9;
    expect(asset).toMatchObject({
      sha256:
        "sha256:039058c6f2c0cb492c533b0a4d14ef77a0f2b4d4b6a2dc6f2b89b6f63b4b61b5",
      mimeType: "image/png",
      byteLength: 3,
    });
    expect(asset.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(asset.bytes).not.toBe(returned);
  });

  it("rejects malformed asset identities and byte metadata with stable errors", () => {
    const valid = {
      sha256:
        "sha256:039058c6f2c0cb492c533b0a4d14ef77a0f2b4d4b6a2dc6f2b89b6f63b4b61b5",
      mimeType: "image/png",
      byteLength: 3,
      bytes: new Uint8Array([1, 2, 3]),
    };

    expect(() =>
      createContentAddressedAsset({ ...valid, sha256: "sha256:ABC" }),
    ).toThrow(
      expect.objectContaining({ code: "PERSISTENCE_ASSET_SHA256_INVALID" }),
    );
    expect(() =>
      createContentAddressedAsset({ ...valid, mimeType: " " }),
    ).toThrow(
      expect.objectContaining({ code: "PERSISTENCE_ASSET_MIME_TYPE_INVALID" }),
    );
    expect(() =>
      createContentAddressedAsset({ ...valid, byteLength: 2 }),
    ).toThrow(
      expect.objectContaining({
        code: "PERSISTENCE_ASSET_BYTE_LENGTH_INVALID",
      }),
    );
  });
});

describe("complete persistence revisions", () => {
  it("creates an immutable canonical revision identity", () => {
    const revision = createCompleteRevision({
      documentId: "document-1",
      revisionId: "revision-1",
      sequence: 1,
      document: FIRST_SLICE_DOCUMENT,
    });
    const canonical = canonicalizeSceneDocument(FIRST_SLICE_DOCUMENT);

    expect(revision).toMatchObject({
      documentId: "document-1",
      revisionId: "revision-1",
      sequence: 1,
      canonicalization: {
        identifier: "jcs-1",
        byteLength: canonical.bytes.byteLength,
      },
    });
    expect(revision.canonicalBytes).toEqual(canonical.bytes);
  });

  it("rejects invalid identity fields, sequences, and documents with stable errors", () => {
    const valid = {
      documentId: "document-1",
      revisionId: "revision-1",
      sequence: 1,
      document: FIRST_SLICE_DOCUMENT,
    };

    expectValidationError(
      { ...valid, documentId: "  " },
      "PERSISTENCE_DOCUMENT_ID_INVALID",
    );
    expectValidationError(
      { ...valid, revisionId: "" },
      "PERSISTENCE_REVISION_ID_INVALID",
    );
    expectValidationError(
      { ...valid, sequence: Number.MAX_SAFE_INTEGER + 1 },
      "PERSISTENCE_SEQUENCE_INVALID",
    );
    expectValidationError(
      { ...valid, sequence: -1 },
      "PERSISTENCE_SEQUENCE_INVALID",
    );
    expectValidationError(
      { ...valid, document: { schemaVersion: 99 } },
      "PERSISTENCE_SCENE_DOCUMENT_INVALID",
    );
  });

  it("defensively preserves canonical document and byte truth across input and output aliases", () => {
    const input = document();
    const revision = createCompleteRevision({
      documentId: "document-1",
      revisionId: "revision-1",
      sequence: 1,
      document: input,
    });
    const expectedBytes = revision.canonicalBytes;

    input.elements[0]!.opacity = 0;
    const outputDocument = revision.document;
    const outputBytes = revision.canonicalBytes;
    outputBytes[0] = 0;

    expect(Object.isFrozen(outputDocument)).toBe(true);
    expect(() => {
      outputDocument.elements[0]!.opacity = 0;
    }).toThrow(TypeError);
    expect(revision.document.elements[0]!.opacity).toBe(1);
    expect(revision.canonicalBytes).toEqual(expectedBytes);
  });

  it("keeps saved and draft pointer snapshots distinct and immutable", () => {
    const savedRevision = createCompleteRevision({
      documentId: "document-1",
      revisionId: "saved-1",
      sequence: 1,
      document: FIRST_SLICE_DOCUMENT,
    });
    const draftRevision = createCompleteRevision({
      documentId: "document-1",
      revisionId: "draft-2",
      sequence: 2,
      document: FIRST_SLICE_DOCUMENT,
    });
    const saved = createSavedRevisionPointer(savedRevision);
    const draft = createDraftRevisionPointer(draftRevision);
    const snapshot = createRevisionPointersSnapshot({ saved, draft });

    expect(snapshot).toEqual({ saved, draft });
    expect(snapshot.saved).not.toBe(saved);
    expect(snapshot.draft).not.toBe(draft);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.saved)).toBe(true);
    expect(Object.isFrozen(snapshot.draft)).toBe(true);
    expect(() => Object.assign(saved, { sequence: 99 })).toThrow(TypeError);
    expect(snapshot.saved).toMatchObject({ kind: "saved", sequence: 1 });
    expect(snapshot.draft).toMatchObject({ kind: "draft", sequence: 2 });
  });

  it("keeps durable revisions free of Canvas pixels, render commands, and ImageData", () => {
    const revision = createCompleteRevision({
      documentId: "document-1",
      revisionId: "revision-1",
      sequence: 1,
      document: FIRST_SLICE_DOCUMENT,
    });

    expect(Object.keys(revision)).toEqual([
      "documentId",
      "revisionId",
      "sequence",
      "canonicalization",
    ]);
    expect("canvasPixels" in revision).toBe(false);
    expect("renderCommands" in revision).toBe(false);
    expect("imageData" in revision.document).toBe(false);
  });
});

describe("valid autosave recovery offers", () => {
  const autosave = (documentId: string, revisionId: string, sequence: number) =>
    createValidAutosaveCandidate(
      createCompleteRevision({
        documentId,
        revisionId,
        sequence,
        document: FIRST_SLICE_DOCUMENT,
      }),
    );

  const saved = (sequence: number) =>
    createSavedRevisionPointer(
      createCompleteRevision({
        documentId: "document-1",
        revisionId: `saved-${sequence}`,
        sequence,
        document: FIRST_SLICE_DOCUMENT,
      }),
    );

  it("offers the newest valid autosave without applying it", () => {
    const snapshot = createRevisionPointersSnapshot({
      saved: null,
      draft: createDraftRevisionPointer(
        createCompleteRevision({
          documentId: "document-1",
          revisionId: "draft-1",
          sequence: 1,
          document: FIRST_SLICE_DOCUMENT,
        }),
      ),
    });
    const candidates = [autosave("document-1", "autosave-2", 2)];

    const result = selectRecoveryOffer({
      documentId: "document-1",
      autosaveCandidates: candidates,
      savedRevision: null,
      discardedRevisionIds: [],
    });

    expect(result).toMatchObject({
      offer: {
        kind: "recovery-offer",
        revision: { revisionId: "autosave-2", sequence: 2 },
      },
    });
    expect(Object.keys(result)).toEqual(["offer"]);
    expect(snapshot).toMatchObject({
      saved: null,
      draft: { revisionId: "draft-1" },
    });
    expect(candidates).toHaveLength(1);
  });

  it("ranks by sequence then revision ID independently of input order", () => {
    const candidates = [
      autosave("document-1", "autosave-z", 4),
      autosave("document-1", "autosave-a", 4),
      autosave("document-1", "autosave-newer", 5),
    ];
    const input = {
      documentId: "document-1",
      savedRevision: saved(1),
      discardedRevisionIds: [],
    };

    const forward = selectRecoveryOffer({
      ...input,
      autosaveCandidates: candidates,
    });
    const reverse = selectRecoveryOffer({
      ...input,
      autosaveCandidates: [...candidates].reverse(),
    });
    expect(forward.offer?.revision.revisionId).toBe("autosave-newer");
    expect(reverse.offer?.revision.revisionId).toBe("autosave-newer");

    const tie = selectRecoveryOffer({
      ...input,
      autosaveCandidates: candidates.filter(
        (candidate) => candidate.revision.sequence === 4,
      ),
    });
    expect(tie.offer?.revision.revisionId).toBe("autosave-a");
  });

  it("uses UTF-16 code-unit ordering for equal-sequence Unicode IDs", () => {
    const composed = autosave("document-1", "é", 4);
    const decomposed = autosave("document-1", "e\u0301", 4);
    const input = {
      documentId: "document-1",
      savedRevision: saved(1),
      discardedRevisionIds: [],
    };

    expect(
      selectRecoveryOffer({
        ...input,
        autosaveCandidates: [composed, decomposed],
      }).offer?.revision.revisionId,
    ).toBe("e\u0301");
    expect(
      selectRecoveryOffer({
        ...input,
        autosaveCandidates: [decomposed, composed],
      }).offer?.revision.revisionId,
    ).toBe("e\u0301");
  });

  it("requires a strictly older saved baseline", () => {
    const candidate = autosave("document-1", "autosave-2", 2);

    expect(
      selectRecoveryOffer({
        documentId: "document-1",
        autosaveCandidates: [candidate],
        savedRevision: saved(1),
        discardedRevisionIds: [],
      }).offer?.revision.revisionId,
    ).toBe("autosave-2");
    expect(
      selectRecoveryOffer({
        documentId: "document-1",
        autosaveCandidates: [candidate],
        savedRevision: saved(2),
        discardedRevisionIds: [],
      }).offer,
    ).toBeNull();
    expect(
      selectRecoveryOffer({
        documentId: "document-1",
        autosaveCandidates: [candidate],
        savedRevision: saved(3),
        discardedRevisionIds: [],
      }).offer,
    ).toBeNull();
  });

  it("filters foreign and discarded revisions and returns no offer when none remain", () => {
    const eligible = autosave("document-1", "eligible", 2);
    const result = selectRecoveryOffer({
      documentId: "document-1",
      autosaveCandidates: [
        autosave("foreign-document", "foreign", 9),
        autosave("document-1", "discarded", 8),
        eligible,
      ],
      savedRevision: null,
      discardedRevisionIds: ["discarded"],
    });
    expect(result.offer?.revision.revisionId).toBe("eligible");
    expect(
      selectRecoveryOffer({
        documentId: "document-1",
        autosaveCandidates: [eligible],
        savedRevision: saved(2),
        discardedRevisionIds: [],
      }).offer,
    ).toBeNull();
  });

  it("defensively copies offers and rejects malformed or mismatched selection input", () => {
    const input = document();
    const revision = createCompleteRevision({
      documentId: "document-1",
      revisionId: "autosave-2",
      sequence: 2,
      document: input,
    });
    const candidates = [createValidAutosaveCandidate(revision)];
    const result = selectRecoveryOffer({
      documentId: "document-1",
      autosaveCandidates: candidates,
      savedRevision: null,
      discardedRevisionIds: [],
    });
    const offerDocument = result.offer!.revision.document;
    const offerBytes = result.offer!.revision.canonicalBytes;

    input.elements[0]!.opacity = 0;
    candidates.reverse();
    offerBytes[0] = 0;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.offer)).toBe(true);
    expect(Object.isFrozen(offerDocument)).toBe(true);
    expect(() => {
      offerDocument.elements[0]!.opacity = 0;
    }).toThrow(TypeError);
    expect(result.offer!.revision.document.elements[0]!.opacity).toBe(1);
    expect(result.offer!.revision.canonicalBytes[0]).not.toBe(0);
    expect(() =>
      selectRecoveryOffer({
        documentId: "document-1",
        autosaveCandidates: null as never,
        savedRevision: null,
        discardedRevisionIds: [],
      }),
    ).toThrow(
      expect.objectContaining({ code: "PERSISTENCE_RECOVERY_INPUT_INVALID" }),
    );
    expect(() =>
      selectRecoveryOffer({
        documentId: "document-1",
        autosaveCandidates: [],
        savedRevision: createSavedRevisionPointer(
          createCompleteRevision({
            documentId: "other-document",
            revisionId: "saved-1",
            sequence: 1,
            document: FIRST_SLICE_DOCUMENT,
          }),
        ),
        discardedRevisionIds: [],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "PERSISTENCE_RECOVERY_SAVED_DOCUMENT_MISMATCH",
      }),
    );
  });
});

describe("invalid autosave recovery diagnostics", () => {
  const invalid = (
    documentId: string,
    revisionId: string,
    sequence: number,
    reason: InvalidAutosaveCandidateReason,
  ) =>
    createInvalidAutosaveCandidate({
      documentId,
      revisionId,
      sequence,
      reason,
    });

  it("skips a newer invalid record, offers the next valid revision, and freezes diagnostics", () => {
    const input = {
      documentId: "document-1",
      revisionId: "broken-newest",
      sequence: 5,
      reason: "invalid-document" as const,
    };
    const newestInvalid = createInvalidAutosaveCandidate(input);
    const result = selectRecoveryOffer({
      documentId: "document-1",
      autosaveCandidates: [
        newestInvalid,
        createValidAutosaveCandidate(
          createCompleteRevision({
            documentId: "document-1",
            revisionId: "valid-fallback",
            sequence: 4,
            document: FIRST_SLICE_DOCUMENT,
          }),
        ),
      ],
      savedRevision: null,
      discardedRevisionIds: [],
    });

    input.reason = "corrupt";
    expect(result.offer?.revision.revisionId).toBe("valid-fallback");
    expect(result.diagnostics).toEqual([
      {
        documentId: "document-1",
        revisionId: "broken-newest",
        sequence: 5,
        reason: "invalid-document",
      },
    ]);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
    expect(Object.isFrozen(result.diagnostics[0])).toBe(true);
    expect(result.diagnostics).not.toBe(result.diagnostics);
    expect(result.diagnostics[0]).not.toBe(result.diagnostics[0]);
    expect(() =>
      Object.assign(result.diagnostics[0]!, { reason: "corrupt" }),
    ).toThrow(TypeError);
    expect(newestInvalid.reason).toBe("invalid-document");
  });

  it("orders invalid diagnostics by descending sequence then UTF-16 revision ID regardless of input order", () => {
    const candidates = [
      invalid("document-1", "é", 5, "corrupt"),
      invalid("document-1", "e\u0301", 5, "incomplete"),
      invalid("document-1", "later", 6, "invalid-document"),
    ];
    const select = (autosaveCandidates: typeof candidates) =>
      selectRecoveryOffer({
        documentId: "document-1",
        autosaveCandidates,
        savedRevision: null,
        discardedRevisionIds: [],
      }).diagnostics.map(({ revisionId, reason }) => ({ revisionId, reason }));

    expect(select(candidates)).toEqual([
      { revisionId: "later", reason: "invalid-document" },
      { revisionId: "e\u0301", reason: "incomplete" },
      { revisionId: "é", reason: "corrupt" },
    ]);
    expect(select([...candidates].reverse())).toEqual(select(candidates));
  });

  it("returns only typed local diagnostics when all candidates are invalid", () => {
    const result = selectRecoveryOffer({
      documentId: "document-1",
      autosaveCandidates: [
        invalid("foreign-document", "foreign", 9, "corrupt"),
        invalid("document-1", "discarded", 8, "incomplete"),
        invalid("document-1", "local", 7, "invalid-document"),
      ],
      savedRevision: null,
      discardedRevisionIds: ["discarded"],
    });

    expect(result.offer).toBeNull();
    expect(result.diagnostics).toEqual([
      {
        documentId: "document-1",
        revisionId: "local",
        sequence: 7,
        reason: "invalid-document",
      },
    ]);
  });

  it("rejects malformed invalid candidates without mutating the supplied recovery input", () => {
    const input = {
      documentId: "document-1",
      revisionId: "broken",
      sequence: 1,
      reason: "corrupt" as const,
    };
    const candidates = [createInvalidAutosaveCandidate(input)];

    expect(() =>
      selectRecoveryOffer({
        documentId: "document-1",
        autosaveCandidates: [{ ...candidates[0], reason: "unknown" } as never],
        savedRevision: null,
        discardedRevisionIds: [],
      }),
    ).toThrow(
      expect.objectContaining({ code: "PERSISTENCE_RECOVERY_INPUT_INVALID" }),
    );
    expect(input).toEqual({
      documentId: "document-1",
      revisionId: "broken",
      sequence: 1,
      reason: "corrupt",
    });
  });

  it("declines without changing pointers so the unchanged selection reoffers", () => {
    const offeredRevision = createCompleteRevision({
      documentId: "document-1",
      revisionId: "autosave-2",
      sequence: 2,
      document: FIRST_SLICE_DOCUMENT,
    });
    const saved = createSavedRevisionPointer(
      createCompleteRevision({
        documentId: "document-1",
        revisionId: "saved-1",
        sequence: 1,
        document: FIRST_SLICE_DOCUMENT,
      }),
    );
    const pointers = createRevisionPointersSnapshot({
      saved,
      draft: createDraftRevisionPointer(
        createCompleteRevision({
          documentId: "document-1",
          revisionId: "draft-1",
          sequence: 1,
          document: FIRST_SLICE_DOCUMENT,
        }),
      ),
    });
    const selection = {
      documentId: "document-1",
      autosaveCandidates: [createValidAutosaveCandidate(offeredRevision)],
      savedRevision: saved,
      discardedRevisionIds: [],
    };
    const offer = selectRecoveryOffer(selection).offer!;

    const result = declineRecoveryOffer({ offer, pointers });

    expect(result.pointers).toEqual(pointers);
    expect(result.pointers).not.toBe(pointers);
    expect(selectRecoveryOffer(selection).offer?.revision.revisionId).toBe(
      "autosave-2",
    );
  });

  it("returns an explicit discard suppression identity without advancing pointers", () => {
    const offeredRevision = createCompleteRevision({
      documentId: "document-1",
      revisionId: "autosave-2",
      sequence: 2,
      document: FIRST_SLICE_DOCUMENT,
    });
    const saved = createSavedRevisionPointer(
      createCompleteRevision({
        documentId: "document-1",
        revisionId: "saved-1",
        sequence: 1,
        document: FIRST_SLICE_DOCUMENT,
      }),
    );
    const pointers = createRevisionPointersSnapshot({ saved, draft: null });
    const selection = {
      documentId: "document-1",
      autosaveCandidates: [createValidAutosaveCandidate(offeredRevision)],
      savedRevision: saved,
      discardedRevisionIds: [],
    };
    const offer = selectRecoveryOffer(selection).offer!;

    const result = discardRecoveryOffer({ offer, pointers });

    expect(result.pointers).toEqual(pointers);
    expect(result.suppression).toEqual({
      documentId: "document-1",
      revisionId: "autosave-2",
    });
    expect(
      selectRecoveryOffer({
        ...selection,
        discardedRevisionIds: [result.suppression.revisionId],
      }).offer,
    ).toBeNull();
  });

  it("rejects stale or cross-document decisions and defensively copies discard output", () => {
    const savedPointer = (sequence: number) =>
      createSavedRevisionPointer(
        createCompleteRevision({
          documentId: "document-1",
          revisionId: `saved-${sequence}`,
          sequence,
          document: FIRST_SLICE_DOCUMENT,
        }),
      );
    const offer = selectRecoveryOffer({
      documentId: "document-1",
      autosaveCandidates: [
        createValidAutosaveCandidate(
          createCompleteRevision({
            documentId: "document-1",
            revisionId: "autosave-2",
            sequence: 2,
            document: FIRST_SLICE_DOCUMENT,
          }),
        ),
      ],
      savedRevision: null,
      discardedRevisionIds: [],
    }).offer!;
    const stale = createRevisionPointersSnapshot({
      saved: savedPointer(2),
      draft: null,
    });
    const foreignDraft = createRevisionPointersSnapshot({
      saved: null,
      draft: createDraftRevisionPointer(
        createCompleteRevision({
          documentId: "other-document",
          revisionId: "draft-1",
          sequence: 1,
          document: FIRST_SLICE_DOCUMENT,
        }),
      ),
    });

    expect(() => declineRecoveryOffer({ offer, pointers: stale })).toThrow(
      expect.objectContaining({ code: "PERSISTENCE_RECOVERY_OFFER_STALE" }),
    );
    expect(() =>
      discardRecoveryOffer({ offer, pointers: foreignDraft }),
    ).toThrow(
      expect.objectContaining({
        code: "PERSISTENCE_RECOVERY_DECISION_DOCUMENT_MISMATCH",
      }),
    );

    const result = discardRecoveryOffer({
      offer,
      pointers: createRevisionPointersSnapshot({
        saved: savedPointer(1),
        draft: null,
      }),
    });
    const firstSuppression = result.suppression;
    expect(Object.isFrozen(firstSuppression)).toBe(true);
    expect(firstSuppression).not.toBe(result.suppression);
    expect(() =>
      Object.assign(firstSuppression, { revisionId: "changed" }),
    ).toThrow(TypeError);
    expect(result.suppression.revisionId).toBe("autosave-2");
  });
});

describe("explicit recovery acceptance", () => {
  it("advances only the draft pointer to the offered immutable revision", () => {
    const offeredRevision = createCompleteRevision({
      documentId: "document-1",
      revisionId: "autosave-2",
      sequence: 2,
      document: FIRST_SLICE_DOCUMENT,
    });
    const offer = selectRecoveryOffer({
      documentId: "document-1",
      autosaveCandidates: [createValidAutosaveCandidate(offeredRevision)],
      savedRevision: null,
      discardedRevisionIds: [],
    }).offer!;
    const saved = createSavedRevisionPointer(
      createCompleteRevision({
        documentId: "document-1",
        revisionId: "saved-1",
        sequence: 1,
        document: FIRST_SLICE_DOCUMENT,
      }),
    );

    const result = acceptRecoveryOffer({ offer, savedRevision: saved });

    expect(result.pointers).toEqual({
      saved,
      draft: {
        kind: "draft",
        documentId: "document-1",
        revisionId: "autosave-2",
        sequence: 2,
      },
    });
    expect(result.revision).toMatchObject({
      documentId: "document-1",
      revisionId: "autosave-2",
      sequence: 2,
    });
  });

  it("rejects an offered revision older than the same-document saved pointer", () => {
    const offeredRevision = createCompleteRevision({
      documentId: "document-1",
      revisionId: "autosave-2",
      sequence: 2,
      document: FIRST_SLICE_DOCUMENT,
    });
    const offer = selectRecoveryOffer({
      documentId: "document-1",
      autosaveCandidates: [createValidAutosaveCandidate(offeredRevision)],
      savedRevision: null,
      discardedRevisionIds: [],
    }).offer!;
    const newerSaved = createSavedRevisionPointer(
      createCompleteRevision({
        documentId: "document-1",
        revisionId: "saved-3",
        sequence: 3,
        document: FIRST_SLICE_DOCUMENT,
      }),
    );

    expect(() =>
      acceptRecoveryOffer({ offer, savedRevision: newerSaved }),
    ).toThrow(
      expect.objectContaining({ code: "PERSISTENCE_RECOVERY_OFFER_STALE" }),
    );
  });

  it("rejects an offered revision equal to the same-document saved pointer", () => {
    const offeredRevision = createCompleteRevision({
      documentId: "document-1",
      revisionId: "autosave-2",
      sequence: 2,
      document: FIRST_SLICE_DOCUMENT,
    });
    const offer = selectRecoveryOffer({
      documentId: "document-1",
      autosaveCandidates: [createValidAutosaveCandidate(offeredRevision)],
      savedRevision: null,
      discardedRevisionIds: [],
    }).offer!;
    const equalSaved = createSavedRevisionPointer(
      createCompleteRevision({
        documentId: "document-1",
        revisionId: "saved-2",
        sequence: 2,
        document: FIRST_SLICE_DOCUMENT,
      }),
    );

    expect(() =>
      acceptRecoveryOffer({ offer, savedRevision: equalSaved }),
    ).toThrow(
      expect.objectContaining({ code: "PERSISTENCE_RECOVERY_OFFER_STALE" }),
    );
  });

  it("preserves an absent saved pointer and defensively returns the offered revision", () => {
    const sourceDocument = document();
    const offeredRevision = createCompleteRevision({
      documentId: "document-1",
      revisionId: "autosave-7",
      sequence: 7,
      document: sourceDocument,
    });
    const offer = selectRecoveryOffer({
      documentId: "document-1",
      autosaveCandidates: [createValidAutosaveCandidate(offeredRevision)],
      savedRevision: null,
      discardedRevisionIds: [],
    }).offer!;
    const expectedBytes = offer.revision.canonicalBytes;

    const first = acceptRecoveryOffer({ offer, savedRevision: null });
    const second = acceptRecoveryOffer({ offer, savedRevision: null });
    const returnedDocument = first.revision.document;
    const returnedBytes = first.revision.canonicalBytes;

    sourceDocument.elements[0]!.opacity = 0;
    returnedBytes[0] = 0;
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.pointers)).toBe(true);
    expect(Object.isFrozen(first.pointers.draft)).toBe(true);
    expect(Object.isFrozen(returnedDocument)).toBe(true);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.pointers.saved).toBeNull();
    expect(first.pointers.draft).toMatchObject({
      documentId: "document-1",
      revisionId: "autosave-7",
      sequence: 7,
    });
    expect(first.revision.document).toEqual(offer.revision.document);
    expect(first.revision.document.elements[0]!.opacity).toBe(1);
    expect(first.revision.canonicalBytes).toEqual(expectedBytes);
    expect(() => {
      returnedDocument.elements[0]!.opacity = 0;
    }).toThrow(TypeError);
    expect(offer.revision.canonicalBytes).toEqual(expectedBytes);
  });

  it("rejects malformed offers and saved pointers from another document", () => {
    const offer = selectRecoveryOffer({
      documentId: "document-1",
      autosaveCandidates: [
        createValidAutosaveCandidate(
          createCompleteRevision({
            documentId: "document-1",
            revisionId: "autosave-2",
            sequence: 2,
            document: FIRST_SLICE_DOCUMENT,
          }),
        ),
      ],
      savedRevision: null,
      discardedRevisionIds: [],
    }).offer!;
    const foreignSaved = createSavedRevisionPointer(
      createCompleteRevision({
        documentId: "other-document",
        revisionId: "saved-1",
        sequence: 1,
        document: FIRST_SLICE_DOCUMENT,
      }),
    );

    expect(() =>
      acceptRecoveryOffer({ offer, savedRevision: foreignSaved }),
    ).toThrow(
      expect.objectContaining({
        code: "PERSISTENCE_RECOVERY_SAVED_DOCUMENT_MISMATCH",
      }),
    );
    expect(() =>
      acceptRecoveryOffer({
        offer: { kind: "recovery-offer" } as never,
        savedRevision: null,
      }),
    ).toThrow(
      expect.objectContaining({ code: "PERSISTENCE_RECOVERY_INPUT_INVALID" }),
    );
  });
});

describe("immutable approval records", () => {
  async function approvalRecordInput(
    approvedAt = 10,
    options: {
      documentId?: string;
      revisionId?: string;
      runtimeVersion?: string;
      document?: SceneDocumentV1;
      assetHash?: string;
    } = {},
  ) {
    const approvalEnvelope = await createApprovalEnvelope({
      document: options.document ?? FIRST_SLICE_DOCUMENT,
      runtimeVersion: options.runtimeVersion ?? "runtime-v1",
      verifiedAssetManifest: [
        {
          sha256:
            options.assetHash ??
            "sha256:039058c6f2c0cb492c533b0a4d14ef77a0f2b4d4b6a2dc6f2b89b6f63b4b61b5",
          mimeType: "image/png",
          byteLength: 3,
        },
      ],
    });
    const evidence = readCanonicalApprovalEvidence(approvalEnvelope);
    return {
      documentId: options.documentId ?? "document-1",
      revisionId: options.revisionId ?? "revision-1",
      approvalEnvelope,
      snapshotHash: evidence.snapshotHash,
      approvalEnvelopeBytes: evidence.approvalEnvelopeBytes,
      canonicalDocumentBytes: evidence.canonicalDocumentBytes,
      verifiedAssetManifest: evidence.verifiedAssetManifest,
      audit: { approvedAt, actorLabel: "local-human" },
    };
  }

  it("binds genuine canonical approval evidence while isolating input and output copies", async () => {
    const input = await approvalRecordInput();
    const expectedApprovalEnvelopeBytes = input.approvalEnvelopeBytes.slice();
    const record = createApprovalRecord(input);
    input.approvalEnvelopeBytes[0] = 0;

    const returnedBytes = record.approvalEnvelopeBytes;
    returnedBytes[0] = 0;

    expect(record).toMatchObject({
      documentId: "document-1",
      revisionId: "revision-1",
      snapshotHash: input.snapshotHash,
      audit: { approvedAt: 10, actorLabel: "local-human" },
    });
    expect(record.approvalEnvelopeBytes).toEqual(expectedApprovalEnvelopeBytes);
    expect(record.approvalEnvelopeBytes).not.toBe(returnedBytes);
    expect(Object.isFrozen(record)).toBe(true);
    expect(validateApprovalRecord(record)).toBe(record);
    expect(() => validateApprovalRecord({ ...record })).toThrow(
      expect.objectContaining({ code: "PERSISTENCE_APPROVAL_RECORD_INVALID" }),
    );
  });

  it("accepts genuine cross-realm Uint8Array approval evidence and copies it locally", async () => {
    const input = await approvalRecordInput();
    const foreignApprovalEnvelopeBytes = runInNewContext(
      "new Uint8Array(bytes)",
      { bytes: Array.from(input.approvalEnvelopeBytes) },
    ) as Uint8Array;
    const foreignCanonicalDocumentBytes = runInNewContext(
      "new Uint8Array(bytes)",
      { bytes: Array.from(input.canonicalDocumentBytes) },
    ) as Uint8Array;

    const record = createApprovalRecord({
      ...input,
      approvalEnvelopeBytes: foreignApprovalEnvelopeBytes,
      canonicalDocumentBytes: foreignCanonicalDocumentBytes,
    });
    foreignApprovalEnvelopeBytes[0] = 0;
    foreignCanonicalDocumentBytes[0] = 0;

    expect(record.approvalEnvelopeBytes).toEqual(input.approvalEnvelopeBytes);
    expect(record.canonicalDocumentBytes).toEqual(input.canonicalDocumentBytes);
    expect(record.approvalEnvelopeBytes).not.toBe(foreignApprovalEnvelopeBytes);
    expect(record.canonicalDocumentBytes).not.toBe(
      foreignCanonicalDocumentBytes,
    );
  });

  it("excludes local audit time from the snapshot hash", async () => {
    const first = createApprovalRecord(await approvalRecordInput(10));
    const second = createApprovalRecord(await approvalRecordInput(11));

    expect(first.snapshotHash).toBe(second.snapshotHash);
    expect(first.audit.approvedAt).toBe(10);
    expect(second.audit.approvedAt).toBe(11);
  });

  it("rejects invalid bindings without observing forged canonical authority getters", async () => {
    const input = await approvalRecordInput();
    for (const [field, value, code] of [
      ["documentId", " ", "PERSISTENCE_DOCUMENT_ID_INVALID"],
      ["revisionId", "", "PERSISTENCE_REVISION_ID_INVALID"],
      ["snapshotHash", "sha256:ABC", "PERSISTENCE_APPROVAL_RECORD_INVALID"],
      [
        "audit",
        { approvedAt: -1, actorLabel: "local-human" },
        "PERSISTENCE_APPROVAL_RECORD_INVALID",
      ],
      [
        "approvalEnvelopeBytes",
        new Uint8Array([0]),
        "PERSISTENCE_APPROVAL_RECORD_INVALID",
      ],
      [
        "canonicalDocumentBytes",
        new Uint8Array([0]),
        "PERSISTENCE_APPROVAL_RECORD_INVALID",
      ],
      ["verifiedAssetManifest", [], "PERSISTENCE_APPROVAL_RECORD_INVALID"],
    ] as const) {
      expect(() => createApprovalRecord({ ...input, [field]: value })).toThrow(
        expect.objectContaining({ code }),
      );
    }
    let getterCalls = 0;
    const forgedAuthority = Object.defineProperty({}, "envelope", {
      get() {
        getterCalls += 1;
        return null;
      },
    });

    expect(() =>
      createApprovalRecord({ ...input, approvalEnvelope: forgedAuthority }),
    ).toThrow(expect.any(Error));
    expect(getterCalls).toBe(0);
  });

  it("preserves exact approval bindings and rejects hostile record fields", async () => {
    const input = await approvalRecordInput();
    const trustedEntry = input.verifiedAssetManifest[0]!;
    const expectApprovalError = (
      candidate: unknown,
      code = "PERSISTENCE_APPROVAL_RECORD_INVALID",
    ) => {
      expect(() => createApprovalRecord(candidate)).toThrow(
        expect.objectContaining({ code }),
      );
    };
    const mismatch = {
      ...input,
      verifiedAssetManifest: [{ ...trustedEntry, byteLength: 4 }],
    };
    const arrayPrototype = Array.prototype;
    const original = {
      every: arrayPrototype.every,
      forEach: arrayPrototype.forEach,
      map: arrayPrototype.map,
      push: arrayPrototype.push,
      iterator: arrayPrototype[Symbol.iterator],
    };
    let mismatchError: unknown;
    let genuine: unknown;

    try {
      arrayPrototype.every = () => true;
      arrayPrototype.forEach = () => undefined;
      arrayPrototype.map = () => [trustedEntry];
      arrayPrototype.push = () => 0;
      arrayPrototype[Symbol.iterator] = function* () {};
      try {
        createApprovalRecord(mismatch);
      } catch (error) {
        mismatchError = error;
      }
      try {
        genuine = createApprovalRecord(input);
      } catch (error) {
        genuine = error;
      }
    } finally {
      arrayPrototype.every = original.every;
      arrayPrototype.forEach = original.forEach;
      arrayPrototype.map = original.map;
      arrayPrototype.push = original.push;
      arrayPrototype[Symbol.iterator] = original.iterator;
    }

    expect(mismatchError).toEqual(
      expect.objectContaining({ code: "PERSISTENCE_APPROVAL_RECORD_INVALID" }),
    );
    expect(genuine).toMatchObject({ snapshotHash: input.snapshotHash });

    let topLevelGetterCalls = 0;
    const topLevelGetter = Object.defineProperty({ ...input }, "documentId", {
      get() {
        topLevelGetterCalls += 1;
        return "document-1";
      },
    });
    const topLevelProxy = new Proxy(
      { ...input },
      {
        getOwnPropertyDescriptor() {
          throw new Error("top-level proxy");
        },
      },
    );
    let manifestGetterCalls = 0;
    const manifestEntryGetter = Object.defineProperty(
      { ...trustedEntry },
      "sha256",
      {
        get() {
          manifestGetterCalls += 1;
          return trustedEntry.sha256;
        },
      },
    );
    const manifestProxy = new Proxy(input.verifiedAssetManifest, {
      getOwnPropertyDescriptor() {
        throw new Error("manifest proxy");
      },
    });
    let auditGetterCalls = 0;
    const auditGetter = Object.defineProperty(
      { ...input.audit },
      "approvedAt",
      {
        get() {
          auditGetterCalls += 1;
          return input.audit.approvedAt;
        },
      },
    );
    const auditProxy = new Proxy(input.audit, {
      getOwnPropertyDescriptor() {
        throw new Error("audit proxy");
      },
    });

    expectApprovalError(topLevelGetter, "PERSISTENCE_DOCUMENT_ID_INVALID");
    expectApprovalError(topLevelProxy);
    expectApprovalError({
      ...input,
      verifiedAssetManifest: [manifestEntryGetter],
    });
    expectApprovalError({ ...input, verifiedAssetManifest: manifestProxy });
    expectApprovalError({ ...input, audit: auditGetter });
    expectApprovalError({ ...input, audit: auditProxy });
    expect(topLevelGetterCalls).toBe(0);
    expect(manifestGetterCalls).toBe(0);
    expect(auditGetterCalls).toBe(0);
    expect(() => validateApprovalRecord(topLevelGetter)).toThrow(
      expect.objectContaining({ code: "PERSISTENCE_APPROVAL_RECORD_INVALID" }),
    );

    const { documentId: _, revisionId: __, ...withoutIdentifiers } = input;
    const inheritedDocumentId = Object.assign(
      Object.create({ documentId: input.documentId }),
      withoutIdentifiers,
      { revisionId: input.revisionId },
    );
    const missingRevisionId = { ...input };
    delete (missingRevisionId as { revisionId?: string }).revisionId;
    const inheritedManifestEntry = Object.assign(
      Object.create({ sha256: trustedEntry.sha256 }),
      {
        mimeType: trustedEntry.mimeType,
        byteLength: trustedEntry.byteLength,
      },
    );
    const inheritedAudit = Object.assign(
      Object.create({ actorLabel: "local-human" }),
      { approvedAt: input.audit.approvedAt },
    );

    expectApprovalError(inheritedDocumentId, "PERSISTENCE_DOCUMENT_ID_INVALID");
    expectApprovalError(missingRevisionId, "PERSISTENCE_REVISION_ID_INVALID");
    expectApprovalError({
      ...input,
      verifiedAssetManifest: [inheritedManifestEntry],
    });
    expectApprovalError({ ...input, audit: inheritedAudit });
  });

  it("rejects non-Uint8, proxy, detached, shared, and spoofed byte evidence", async () => {
    const input = await approvalRecordInput();
    const expectApprovalError = (bytes: unknown) => {
      expect(() =>
        createApprovalRecord({ ...input, approvalEnvelopeBytes: bytes }),
      ).toThrow(
        expect.objectContaining({
          code: "PERSISTENCE_APPROVAL_RECORD_INVALID",
        }),
      );
    };
    let redirectingTraps = 0;
    const redirecting = new Proxy(input.approvalEnvelopeBytes, {
      get() {
        redirectingTraps += 1;
        return new Uint8Array([0]);
      },
    });
    const throwing = new Proxy(input.canonicalDocumentBytes, {
      get() {
        throw new Error("byte proxy observed");
      },
    });
    let prototypeTraps = 0;
    const prototypeProxy = new Proxy(input.approvalEnvelopeBytes, {
      getPrototypeOf() {
        prototypeTraps += 1;
        return Uint8Array.prototype;
      },
    });
    const { proxy: revoked, revoke } = Proxy.revocable(
      input.approvalEnvelopeBytes,
      {},
    );
    revoke();
    const foreign = Object.create(Uint8Array.prototype) as Uint8Array;
    let spoofGetterCalls = 0;
    const spoofed = Object.create(Uint8Array.prototype) as Uint8Array;
    for (const property of [
      Symbol.toStringTag,
      "constructor",
      "BYTES_PER_ELEMENT",
      "length",
      "byteLength",
      "buffer",
    ] as const) {
      Object.defineProperty(spoofed, property, {
        get() {
          spoofGetterCalls += 1;
          throw new Error("forged byte property observed");
        },
      });
    }
    const incompatibleTypedArrays: unknown[] = [
      new Uint8ClampedArray(1),
      new Int8Array(1),
      new Uint16Array(1),
      new Int16Array(1),
      new Uint32Array(1),
      new Int32Array(1),
      new Float32Array(1),
      new Float64Array(1),
      new BigInt64Array(1),
      new BigUint64Array(1),
    ];
    const float16Array = (globalThis as Record<string, unknown>).Float16Array;
    if (typeof float16Array === "function") {
      incompatibleTypedArrays.push(
        new (float16Array as new (length: number) => unknown)(1),
      );
    }
    const detached = input.approvalEnvelopeBytes.slice();
    structuredClone(detached.buffer, { transfer: [detached.buffer] });

    for (const bytes of [
      redirecting,
      throwing,
      prototypeProxy,
      revoked,
      foreign,
      spoofed,
      new DataView(new ArrayBuffer(1)),
      new ArrayBuffer(1),
      ...incompatibleTypedArrays,
      detached,
    ]) {
      expectApprovalError(bytes);
    }
    if (typeof SharedArrayBuffer !== "undefined") {
      expectApprovalError(new Uint8Array(new SharedArrayBuffer(1)));
    }
    expect(redirectingTraps).toBe(0);
    expect(prototypeTraps).toBe(0);
    expect(spoofGetterCalls).toBe(0);
    expect(() => validateApprovalRecord(redirecting)).toThrow(
      expect.objectContaining({ code: "PERSISTENCE_APPROVAL_RECORD_INVALID" }),
    );
  });

  it("keeps genuine approval evidence authoritative after primordial poisoning", async () => {
    const input = await approvalRecordInput();
    const expectedBytes = input.approvalEnvelopeBytes.slice();
    const existing = createApprovalRecord(input);
    const forged = { ...existing };
    const invalidTime = { ...input, audit: { ...input.audit, approvedAt: -1 } };
    const invalidBytes = {
      ...input,
      canonicalDocumentBytes: new Uint8Array([0]),
    };
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
    const byteLength = Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      "byteLength",
    )!;
    const original = {
      slice: Uint8Array.prototype.slice,
      set: Uint8Array.prototype.set,
      weakSetAdd: WeakSet.prototype.add,
      weakSetHas: WeakSet.prototype.has,
      weakMapGet: WeakMap.prototype.get,
      weakMapSet: WeakMap.prototype.set,
      reflectApply: Reflect.apply,
      descriptor: Object.getOwnPropertyDescriptor,
      prototype: Object.getPrototypeOf,
      freeze: Object.freeze,
      arrayIsArray: Array.isArray,
      safeInteger: Number.isSafeInteger,
      call: Function.prototype.call,
      bind: Function.prototype.bind,
    };
    let existingValidation: unknown;
    let existingBytes: Uint8Array | undefined;
    let invalidTimeError: unknown;
    let invalidBytesError: unknown;
    let forgedError: unknown;
    let created: unknown;
    let createdBytes: Uint8Array | undefined;

    try {
      Uint8Array.prototype.slice = (() =>
        new Uint8Array([0])) as typeof Uint8Array.prototype.slice;
      Uint8Array.prototype.set = (() =>
        undefined) as typeof Uint8Array.prototype.set;
      Object.defineProperty(typedArrayPrototype, "byteLength", {
        configurable: true,
        get: () => 0,
      });
      WeakSet.prototype.add = (() =>
        new WeakSet()) as typeof WeakSet.prototype.add;
      WeakSet.prototype.has = (() => false) as typeof WeakSet.prototype.has;
      WeakMap.prototype.get = (() => undefined) as typeof WeakMap.prototype.get;
      WeakMap.prototype.set = (() =>
        new WeakMap()) as typeof WeakMap.prototype.set;
      Reflect.apply = (() => {
        throw new Error("redirected apply");
      }) as typeof Reflect.apply;
      Object.getOwnPropertyDescriptor = (() => {
        throw new Error("redirected descriptor");
      }) as typeof Object.getOwnPropertyDescriptor;
      Object.getPrototypeOf = (() => {
        throw new Error("redirected prototype");
      }) as typeof Object.getPrototypeOf;
      Object.freeze = ((value: unknown) => value) as typeof Object.freeze;
      Array.isArray = (() => true) as typeof Array.isArray;
      Number.isSafeInteger = (() => true) as typeof Number.isSafeInteger;
      Function.prototype.call = (() =>
        undefined) as typeof Function.prototype.call;
      Function.prototype.bind = (() => () =>
        undefined) as typeof Function.prototype.bind;

      try {
        existingValidation = validateApprovalRecord(existing);
        existingBytes = existing.approvalEnvelopeBytes;
        existingBytes[0] = 0;
      } catch (error) {
        existingValidation = error;
      }
      try {
        createApprovalRecord(invalidTime);
      } catch (error) {
        invalidTimeError = error;
      }
      try {
        validateApprovalRecord(forged);
      } catch (error) {
        forgedError = error;
      }
      try {
        createApprovalRecord(invalidBytes);
      } catch (error) {
        invalidBytesError = error;
      }
      try {
        created = createApprovalRecord(input);
        createdBytes = (created as { approvalEnvelopeBytes: Uint8Array })
          .approvalEnvelopeBytes;
        createdBytes[0] = 0;
      } catch (error) {
        created = error;
      }
    } finally {
      Uint8Array.prototype.slice = original.slice;
      Uint8Array.prototype.set = original.set;
      Object.defineProperty(typedArrayPrototype, "byteLength", byteLength);
      WeakSet.prototype.add = original.weakSetAdd;
      WeakSet.prototype.has = original.weakSetHas;
      WeakMap.prototype.get = original.weakMapGet;
      WeakMap.prototype.set = original.weakMapSet;
      Reflect.apply = original.reflectApply;
      Object.getOwnPropertyDescriptor = original.descriptor;
      Object.getPrototypeOf = original.prototype;
      Object.freeze = original.freeze;
      Array.isArray = original.arrayIsArray;
      Number.isSafeInteger = original.safeInteger;
      Function.prototype.call = original.call;
      Function.prototype.bind = original.bind;
    }

    expect(existingValidation).toBe(existing);
    expect(existingBytes?.[0]).toBe(0);
    expect(existing.approvalEnvelopeBytes).toEqual(expectedBytes);
    expect(created).toMatchObject({ snapshotHash: input.snapshotHash });
    expect(
      (created as { approvalEnvelopeBytes: Uint8Array }).approvalEnvelopeBytes,
    ).toEqual(expectedBytes);
    expect(createdBytes?.[0]).toBe(0);
    expect(Object.isFrozen(created)).toBe(true);
    expect(invalidTimeError).toEqual(
      expect.objectContaining({ code: "PERSISTENCE_APPROVAL_RECORD_INVALID" }),
    );
    expect(invalidBytesError).toEqual(
      expect.objectContaining({ code: "PERSISTENCE_APPROVAL_RECORD_INVALID" }),
    );
    expect(forgedError).toEqual(
      expect.objectContaining({ code: "PERSISTENCE_APPROVAL_RECORD_INVALID" }),
    );
    expect(() => validateApprovalRecord({ ...existing })).toThrow(
      expect.objectContaining({ code: "PERSISTENCE_APPROVAL_RECORD_INVALID" }),
    );
  });

  it("forks a linked draft from genuine approval authority without mutating approval or saved state", async () => {
    const approved = createCompleteRevision({
      documentId: "document-1",
      revisionId: "approved-1",
      sequence: 1,
      document: FIRST_SLICE_DOCUMENT,
    });
    const draft = createCompleteRevision({
      documentId: "document-1",
      revisionId: "draft-2",
      sequence: 2,
      document: FIRST_SLICE_DOCUMENT,
    });
    const approval = createApprovalRecord(
      await approvalRecordInput(10, { revisionId: "approved-1" }),
    );
    const pointers = createRevisionPointersSnapshot({
      saved: createSavedRevisionPointer(approved),
      draft: createDraftRevisionPointer(approved),
    });
    const approvedBytes = approval.canonicalDocumentBytes;

    const result = forkApprovedDraft({
      approval,
      approvedRevision: approved,
      draftRevision: draft,
      pointers,
      reason: "content",
    });

    expect(result.approval).toBe(approval);
    expect(result.pointers.saved).toEqual(pointers.saved);
    expect(result.pointers.saved).not.toBe(pointers.saved);
    expect(result.pointers.draft).toEqual({
      kind: "draft",
      documentId: "document-1",
      revisionId: "draft-2",
      sequence: 2,
      parentApprovalHash: approval.snapshotHash,
    });
    expect(approval.canonicalDocumentBytes).toEqual(approvedBytes);
    expect(pointers.draft).toMatchObject({ revisionId: "approved-1" });
  });

  it("requires a distinct linked child draft for content, schema, and verified-asset invalidation", async () => {
    const approved = createCompleteRevision({
      documentId: "document-1",
      revisionId: "approved-1",
      sequence: 1,
      document: FIRST_SLICE_DOCUMENT,
    });
    const approval = createApprovalRecord(
      await approvalRecordInput(10, { revisionId: "approved-1" }),
    );
    const changedDocument = document();
    changedDocument.elements[0]!.opacity = 0.5;
    const drafts = [
      ["content", changedDocument],
      ["schema-version", FIRST_SLICE_DOCUMENT],
      ["verified-assets", FIRST_SLICE_DOCUMENT],
    ] as const;

    for (const [reason, draftDocument] of drafts) {
      const draft = createCompleteRevision({
        documentId: "document-1",
        revisionId: `${reason}-draft`,
        sequence: 2,
        document: draftDocument,
      });
      const result = forkApprovedDraft({
        approval,
        approvedRevision: approved,
        draftRevision: draft,
        pointers: createRevisionPointersSnapshot({
          saved: createSavedRevisionPointer(approved),
          draft: createDraftRevisionPointer(approved),
        }),
        reason,
      });

      expect(result.pointers.draft).toMatchObject({
        revisionId: `${reason}-draft`,
        parentApprovalHash: approval.snapshotHash,
      });
      expect(result.pointers.draft?.revisionId).not.toBe(approved.revisionId);
    }
  });

  it("accepts legacy draft pointers but rejects mismatched revisions and forged approval authority", async () => {
    const approved = createCompleteRevision({
      documentId: "document-1",
      revisionId: "approved-1",
      sequence: 1,
      document: FIRST_SLICE_DOCUMENT,
    });
    const approval = createApprovalRecord(
      await approvalRecordInput(10, { revisionId: "approved-1" }),
    );
    const draft = createCompleteRevision({
      documentId: "document-1",
      revisionId: "draft-2",
      sequence: 2,
      document: FIRST_SLICE_DOCUMENT,
    });
    const legacyDraft = Object.freeze({
      kind: "draft" as const,
      documentId: "document-1",
      revisionId: "legacy-draft",
      sequence: 0,
    });
    const pointers = createRevisionPointersSnapshot({
      saved: createSavedRevisionPointer(approved),
      draft: legacyDraft,
    });

    expect(pointers.draft).not.toHaveProperty("parentApprovalHash");
    expect(() =>
      forkApprovedDraft({
        approval,
        approvedRevision: approved,
        draftRevision: draft,
        pointers,
        reason: "content",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "PERSISTENCE_APPROVAL_INVALIDATION_INVALID",
      }),
    );
    const mismatchedApprovedDocument = document();
    mismatchedApprovedDocument.elements[0]!.opacity = 0.5;
    const mismatchedApproved = createCompleteRevision({
      documentId: "document-1",
      revisionId: "approved-1",
      sequence: 1,
      document: mismatchedApprovedDocument,
    });
    expect(() =>
      forkApprovedDraft({
        approval,
        approvedRevision: mismatchedApproved,
        draftRevision: draft,
        pointers,
        reason: "content",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "PERSISTENCE_APPROVAL_INVALIDATION_INVALID",
      }),
    );
    expect(() =>
      forkApprovedDraft({
        approval: { ...approval },
        approvedRevision: approved,
        draftRevision: draft,
        pointers,
        reason: "content",
      }),
    ).toThrow(
      expect.objectContaining({ code: "PERSISTENCE_APPROVAL_RECORD_INVALID" }),
    );
  });

  it("returns frozen defensive pointers and rejects accessor authority after import-time primordial poisoning", async () => {
    const approved = createCompleteRevision({
      documentId: "document-1",
      revisionId: "approved-1",
      sequence: 1,
      document: FIRST_SLICE_DOCUMENT,
    });
    const draft = createCompleteRevision({
      documentId: "document-1",
      revisionId: "draft-2",
      sequence: 2,
      document: FIRST_SLICE_DOCUMENT,
    });
    const approval = createApprovalRecord(
      await approvalRecordInput(10, { revisionId: "approved-1" }),
    );
    const pointers = createRevisionPointersSnapshot({
      saved: createSavedRevisionPointer(approved),
      draft: createDraftRevisionPointer(approved),
    });
    const original = {
      descriptor: Object.getOwnPropertyDescriptor,
      freeze: Object.freeze,
      reflectApply: Reflect.apply,
    };
    const invalid = { code: "PERSISTENCE_APPROVAL_INVALIDATION_INVALID" };
    let result: ReturnType<typeof forkApprovedDraft> | undefined;
    let getterCalls = 0;

    try {
      Object.getOwnPropertyDescriptor = (() => {
        throw new Error("poisoned descriptor");
      }) as typeof Object.getOwnPropertyDescriptor;
      Object.freeze = ((value: unknown) => value) as typeof Object.freeze;
      Reflect.apply = (() => {
        throw new Error("poisoned apply");
      }) as typeof Reflect.apply;
      result = forkApprovedDraft({
        approval,
        approvedRevision: approved,
        draftRevision: draft,
        pointers,
        reason: "verified-assets",
      });
      expect(() =>
        forkApprovedDraft(
          Object.defineProperty({}, "approval", {
            get() {
              getterCalls += 1;
              return approval;
            },
          }),
        ),
      ).toThrow(expect.objectContaining(invalid));
      expect(() =>
        forkApprovedDraft({
          approval,
          approvedRevision: approved,
          draftRevision: draft,
          pointers: new Proxy(pointers, {
            get: () => {
              throw Error();
            },
          }),
          reason: "content",
        }),
      ).toThrow(expect.objectContaining(invalid));
      expect(() =>
        forkApprovedDraft({
          approval,
          approvedRevision: approved,
          draftRevision: Object.create(draft, { sequence: { value: 2.5 } }),
          pointers,
          reason: "content",
        }),
      ).toThrow(expect.objectContaining(invalid));
    } finally {
      Object.getOwnPropertyDescriptor = original.descriptor;
      Object.freeze = original.freeze;
      Reflect.apply = original.reflectApply;
    }

    expect(result).toMatchObject({ approval });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.pointers)).toBe(true);
    expect(Object.isFrozen(result?.pointers.draft)).toBe(true);
    expect(getterCalls).toBe(0);
    expect(() =>
      Object.assign(result!.pointers.draft!, { sequence: 99 }),
    ).toThrow(TypeError);
    expect(result!.pointers.draft?.sequence).toBe(2);
  });

  it("reuses the exact existing record when only valid audit metadata differs", async () => {
    const existing = createApprovalRecord(await approvalRecordInput(10));
    const candidate = createApprovalRecord(await approvalRecordInput(11));

    const reused = reuseIdenticalApprovalRecord(existing, candidate);

    expect(reused).toBe(existing);
    expect(reused.audit).toEqual({ approvedAt: 10, actorLabel: "local-human" });
    expect(candidate.audit).toEqual({
      approvedAt: 11,
      actorLabel: "local-human",
    });
  });

  it("rejects copied authority in the candidate position", async () => {
    const existing = createApprovalRecord(await approvalRecordInput(10));
    const candidate = createApprovalRecord(await approvalRecordInput(11));

    expect(() =>
      reuseIdenticalApprovalRecord(existing, { ...candidate }),
    ).toThrow(
      expect.objectContaining({ code: "PERSISTENCE_APPROVAL_RECORD_INVALID" }),
    );
  });

  it("rejects genuine records with a difference in every immutable identity dimension", async () => {
    const existing = createApprovalRecord(await approvalRecordInput());
    const changedDocument = document();
    changedDocument.elements[0]!.opacity = 0.5;
    const candidates = await Promise.all([
      approvalRecordInput(10, { documentId: "document-2" }),
      approvalRecordInput(10, { revisionId: "revision-2" }),
      approvalRecordInput(10, { runtimeVersion: "runtime-v2" }),
      approvalRecordInput(10, { document: changedDocument }),
      approvalRecordInput(10, {
        assetHash:
          "sha256:4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a",
      }),
    ]);

    for (const input of candidates) {
      expect(() =>
        reuseIdenticalApprovalRecord(existing, createApprovalRecord(input)),
      ).toThrow(
        expect.objectContaining({
          code: "PERSISTENCE_APPROVAL_RECORD_CONFLICT",
        }),
      );
    }
  });

  it("reads runtime version only from a genuine private approval record", async () => {
    const record = createApprovalRecord(
      await approvalRecordInput(10, { runtimeVersion: "runtime-v2" }),
    );
    const copied = { ...record };
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "runtimeVersion", {
      get() {
        getterCalls += 1;
        throw new Error("must not read forged runtime version");
      },
    });
    const inherited = Object.create(
      Object.defineProperty({}, "runtimeVersion", {
        get() {
          getterCalls += 1;
          throw new Error("must not read inherited runtime version");
        },
      }),
    );
    const proxy = new Proxy(
      {},
      {
        get() {
          getterCalls += 1;
          throw new Error("must not read proxy runtime version");
        },
        getOwnPropertyDescriptor() {
          getterCalls += 1;
          throw new Error("must not inspect proxy runtime version");
        },
      },
    );

    expect(readApprovalRecordRuntimeVersion(record)).toBe("runtime-v2");
    expect(Object.keys(record)).toEqual([
      "documentId",
      "revisionId",
      "snapshotHash",
    ]);
    expect("runtimeVersion" in record).toBe(false);
    for (const forged of [copied, accessor, inherited, proxy]) {
      expect(() => readApprovalRecordRuntimeVersion(forged)).toThrow(
        expect.objectContaining({
          code: "PERSISTENCE_APPROVAL_RECORD_INVALID",
        }),
      );
    }
    expect(getterCalls).toBe(0);
  });

  it("preserves genuine runtime evidence after named post-import primordial poisoning", async () => {
    const record = createApprovalRecord(
      await approvalRecordInput(10, { runtimeVersion: "runtime-v3" }),
    );
    const original = {
      weakMapGet: WeakMap.prototype.get,
      weakSetHas: WeakSet.prototype.has,
      reflectApply: Reflect.apply,
      descriptor: Object.getOwnPropertyDescriptor,
      prototype: Object.getPrototypeOf,
    };
    let runtimeVersion: unknown;
    let copiedError: unknown;

    try {
      WeakMap.prototype.get = (() => undefined) as typeof WeakMap.prototype.get;
      WeakSet.prototype.has = (() => true) as typeof WeakSet.prototype.has;
      Reflect.apply = (() => {
        throw new Error("redirected apply");
      }) as typeof Reflect.apply;
      Object.getOwnPropertyDescriptor = (() => {
        throw new Error("redirected descriptor");
      }) as typeof Object.getOwnPropertyDescriptor;
      Object.getPrototypeOf = (() => {
        throw new Error("redirected prototype");
      }) as typeof Object.getPrototypeOf;
      runtimeVersion = readApprovalRecordRuntimeVersion(record);
      try {
        readApprovalRecordRuntimeVersion({ ...record });
      } catch (error) {
        copiedError = error;
      }
    } finally {
      WeakMap.prototype.get = original.weakMapGet;
      WeakSet.prototype.has = original.weakSetHas;
      Reflect.apply = original.reflectApply;
      Object.getOwnPropertyDescriptor = original.descriptor;
      Object.getPrototypeOf = original.prototype;
    }

    expect(runtimeVersion).toBe("runtime-v3");
    expect(copiedError).toEqual(
      expect.objectContaining({ code: "PERSISTENCE_APPROVAL_RECORD_INVALID" }),
    );
  });

  it("accepts only the exact runtime-version invalidation reason and preserves legacy pointers", async () => {
    const approved = createCompleteRevision({
      documentId: "document-1",
      revisionId: "approved-1",
      sequence: 1,
      document: FIRST_SLICE_DOCUMENT,
    });
    const draft = createCompleteRevision({
      documentId: "document-1",
      revisionId: "runtime-draft",
      sequence: 2,
      document: FIRST_SLICE_DOCUMENT,
    });
    const approval = createApprovalRecord(
      await approvalRecordInput(10, {
        revisionId: "approved-1",
        runtimeVersion: "runtime-v1",
      }),
    );
    const pointers = createRevisionPointersSnapshot({
      saved: createSavedRevisionPointer(approved),
      draft: createDraftRevisionPointer(approved),
    });
    const input = {
      approval,
      approvedRevision: approved,
      draftRevision: draft,
      pointers,
    };

    expect(
      forkApprovedDraft({ ...input, reason: "runtime-version" }),
    ).toMatchObject({
      approval,
      pointers: {
        draft: {
          revisionId: "runtime-draft",
          parentApprovalHash: approval.snapshotHash,
        },
      },
    });
    for (const reason of [
      "runtime",
      "runtime_version",
      "runtime-version ",
      "Runtime-version",
    ]) {
      expect(() => forkApprovedDraft({ ...input, reason })).toThrow(
        expect.objectContaining({
          code: "PERSISTENCE_APPROVAL_INVALIDATION_INVALID",
        }),
      );
    }
  });

  it("rejects copied authority and preserves genuine reuse after primordial poisoning", async () => {
    const existing = createApprovalRecord(await approvalRecordInput(10));
    const candidate = createApprovalRecord(await approvalRecordInput(11));
    const forged = { ...existing };
    const original = {
      weakMapGet: WeakMap.prototype.get,
      weakSetHas: WeakSet.prototype.has,
      reflectApply: Reflect.apply,
      arrayIsArray: Array.isArray,
      safeInteger: Number.isSafeInteger,
      byteSet: Uint8Array.prototype.set,
    };
    let reused: unknown;
    let forgedError: unknown;

    try {
      WeakMap.prototype.get = (() => undefined) as typeof WeakMap.prototype.get;
      WeakSet.prototype.has = (() => true) as typeof WeakSet.prototype.has;
      Reflect.apply = (() => {
        throw new Error("redirected apply");
      }) as typeof Reflect.apply;
      Array.isArray = (() => true) as typeof Array.isArray;
      Number.isSafeInteger = (() => true) as typeof Number.isSafeInteger;
      Uint8Array.prototype.set = (() =>
        undefined) as typeof Uint8Array.prototype.set;

      try {
        reused = reuseIdenticalApprovalRecord(existing, candidate);
      } catch (error) {
        reused = error;
      }
      try {
        reuseIdenticalApprovalRecord(forged, candidate);
      } catch (error) {
        forgedError = error;
      }
    } finally {
      WeakMap.prototype.get = original.weakMapGet;
      WeakSet.prototype.has = original.weakSetHas;
      Reflect.apply = original.reflectApply;
      Array.isArray = original.arrayIsArray;
      Number.isSafeInteger = original.safeInteger;
      Uint8Array.prototype.set = original.byteSet;
    }

    expect(reused).toBe(existing);
    expect(forgedError).toEqual(
      expect.objectContaining({ code: "PERSISTENCE_APPROVAL_RECORD_INVALID" }),
    );
  });
});
