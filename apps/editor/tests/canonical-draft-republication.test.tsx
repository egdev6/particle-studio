import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { FIRST_SLICE_DOCUMENT } from "@particle-studio/scene-document";
import {
  createCompleteRevision, createDraftRevisionPointer, createSavedRevisionPointer,
  createRevisionPointersSnapshot, type ConditionalCompleteRevisionWritePort,
} from "@particle-studio/persistence";
import { createPngImageCache } from "../src/png-image-cache.js";
import {
  publishFirstCanonicalDraft, type FirstCanonicalDraftPublication,
} from "../src/canonical-draft-publication.js";
import {
  createCanonicalDraftReloadService, type CanonicalDraftReloadPublication,
} from "../src/canonical-draft-reload.js";

const hashA = "sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
const hashB = "sha256:787c798e39a5bc1910355bae6d0cd87a36b2e10fd0202a83e3bb6b005da83472";
const approvalHash = `sha256:${"c".repeat(64)}`;
const bytesA = new Uint8Array([1, 2, 3]);
const bytesB = new Uint8Array([4, 5, 6]);

const imageDocument = (sha256: string) => ({
  ...FIRST_SLICE_DOCUMENT,
  rootIds: ["image-1"],
  elements: [{ id: "image-1", type: "image" as const, x: 0, y: 0,
    width: 20, height: 10, opacity: 1,
    asset: { sha256, mimeType: "image/png" as const, byteLength: 3,
      intrinsicWidth: 20, intrinsicHeight: 10 } }],
  tracks: [],
});

function fixture() {
  const savedRevision = createCompleteRevision({
    documentId: "doc-1", revisionId: "saved-1", sequence: 2, document: FIRST_SLICE_DOCUMENT,
  });
  const saved = createSavedRevisionPointer(savedRevision);
  const reloadRevision = createCompleteRevision({
    documentId: "doc-1", revisionId: "rev-1", sequence: 3, document: imageDocument(hashA),
  });
  const revisions = new Map([["rev-1", reloadRevision]]);
  let pointers = createRevisionPointersSnapshot({
    saved, draft: createDraftRevisionPointer(reloadRevision, approvalHash),
  });
  const readPointers = vi.fn(async () => pointers);
  const writeCompleteRevision = vi.fn(async () => { throw new Error("unconditional write"); });
  const writeCompleteRevisionIfPointersMatch = vi.fn(async (
    _revision: Parameters<ConditionalCompleteRevisionWritePort["writeCompleteRevisionIfPointersMatch"]>[0],
    expected: Parameters<ConditionalCompleteRevisionWritePort["writeCompleteRevisionIfPointersMatch"]>[1],
    next: Parameters<ConditionalCompleteRevisionWritePort["writeCompleteRevisionIfPointersMatch"]>[2],
  ) => {
    if (JSON.stringify(pointers) !== JSON.stringify(expected)) throw new Error("stale pointers");
    pointers = next;
  });
  const adapter: ConditionalCompleteRevisionWritePort = {
    readRevision: vi.fn(async (_documentId: string, revisionId: string) => revisions.get(revisionId) ?? null),
    readPointers,
    writeCompleteRevision,
    writeCompleteRevisionIfPointersMatch,
  };
  const rereadVerifiedPng = vi.fn(async (sha256: string) => ({
    sha256, mimeType: "image/png", byteLength: 3, bytes: (sha256 === hashA ? bytesA : bytesB).slice(),
  }));
  const handles: { close: ReturnType<typeof vi.fn> }[] = [];
  const decodeVerifiedPng = vi.fn(async (verified: { sha256: string; bytes: Uint8Array }) => {
    const handle = { close: vi.fn() };
    handles.push(handle);
    return { ...verified, mimeType: "image/png", byteLength: 3, width: 20, height: 10, handle };
  });
  const cache = createPngImageCache({
    importVerifiedPng: async () => { throw new Error("unexpected import"); },
    decodeVerifiedPng: async () => { throw new Error("unexpected decode"); },
  });
  const service = createCanonicalDraftReloadService({
    persistence: adapter, cache,
    prehydration: { rereadVerifiedPng, decodeVerifiedPng },
  });
  const options = {
    editableJson: JSON.stringify(imageDocument(hashB)), documentId: "doc-1",
    revisionId: () => "draft-2", sequence: 4, createdAt: () => 5678,
    persistence: adapter, cache, prehydration: { rereadVerifiedPng, decodeVerifiedPng },
  };
  return {
    options, saved, service, rereadVerifiedPng, decodeVerifiedPng,
    readPointers, writeCompleteRevision, writeCompleteRevisionIfPointersMatch,
    pointers: () => pointers, handles,
  };
}

describe("republication from a live canonical draft reload", () => {
  it("republishes a genuine live reload prior, preserving the full pointer snapshot and approval linkage", async () => {
    const f = fixture();
    const prior = await f.service.reload({ documentId: "doc-1" });
    expect(prior.identity).toEqual({ kind: "draft", documentId: "doc-1", revisionId: "rev-1", sequence: 3 });
    expect(f.readPointers).toHaveBeenCalledTimes(1);
    const before = f.pointers();
    const publication = await publishFirstCanonicalDraft({ ...f.options, priorPublication: prior });
    // One read fixed the reload identity, one fed the republish CAS: no second identity read.
    expect(f.readPointers).toHaveBeenCalledTimes(2);
    expect(f.writeCompleteRevision).not.toHaveBeenCalled();
    const [revision, expected, next] = f.writeCompleteRevisionIfPointersMatch.mock.calls[0]!;
    expect(expected).toEqual(before);
    expect(expected.draft).toMatchObject({ revisionId: "rev-1", parentApprovalHash: approvalHash });
    expect(revision).toMatchObject({ documentId: "doc-1", revisionId: "draft-2", sequence: 4 });
    expect(next.saved).toEqual(f.saved);
    expect(next.draft).toMatchObject({ revisionId: "draft-2", sequence: 4, parentApprovalHash: approvalHash });
    expect(publication).toMatchObject({ createdAt: 5678, revision, pointers: next });
    expect(f.pointers()).toEqual(next);
    expect(publication.workspace.images[0]!.sha256).toBe(hashB);
    prior.release();
    expect(f.service.current).toBeNull();
    expect(f.handles[0]!.close).toHaveBeenCalledTimes(1);
    expect(f.handles[1]!.close).not.toHaveBeenCalled();
    publication.release();
    publication.release();
    expect(f.handles[1]!.close).toHaveBeenCalledTimes(1);
  });

  it("returns the same live reload prior on exact retry without fabricating a timestamp", async () => {
    const f = fixture();
    const prior = await f.service.reload({ documentId: "doc-1" });
    const retry = await publishFirstCanonicalDraft({ ...f.options,
      editableJson: JSON.stringify(imageDocument(hashA)),
      revisionId: () => "rev-1", sequence: 3, priorPublication: prior });
    expect(retry).toBe(prior);
    expect("createdAt" in retry).toBe(false);
    expect(f.writeCompleteRevisionIfPointersMatch).not.toHaveBeenCalled();
    expect(f.rereadVerifiedPng).toHaveBeenCalledTimes(1);
    expect(f.decodeVerifiedPng).toHaveBeenCalledTimes(1);
  });

  it("rejects superseded, released, and foreign reload priors without writing", async () => {
    const f = fixture();
    const superseded = await f.service.reload({ documentId: "doc-1" });
    const released = await f.service.reload({ documentId: "doc-1" });
    await expect(publishFirstCanonicalDraft({ ...f.options, priorPublication: superseded }))
      .rejects.toThrow("EDITOR_CANONICAL_DRAFT_PRIOR_MISMATCH");
    expect(f.writeCompleteRevisionIfPointersMatch).not.toHaveBeenCalled();
    released.release();
    await expect(publishFirstCanonicalDraft({ ...f.options, priorPublication: released }))
      .rejects.toThrow("EDITOR_CANONICAL_DRAFT_PRIOR_MISMATCH");
    const foreign = { ...released, release: () => {} };
    await expect(publishFirstCanonicalDraft({ ...f.options, priorPublication: foreign }))
      .rejects.toThrow("EDITOR_CANONICAL_DRAFT_PRIOR_MISMATCH");
    expect(f.writeCompleteRevisionIfPointersMatch).not.toHaveBeenCalled();
    expect(f.readPointers).toHaveBeenCalledTimes(2);
    expect(f.service.current).toBeNull();
  });

  it("preserves the live reload prior and rolls back staged leases when the atomic write fails", async () => {
    const f = fixture();
    const prior = await f.service.reload({ documentId: "doc-1" });
    f.writeCompleteRevisionIfPointersMatch.mockRejectedValueOnce(new Error("secret disk"));
    await expect(publishFirstCanonicalDraft({ ...f.options, priorPublication: prior }))
      .rejects.toThrow("EDITOR_CANONICAL_DRAFT_WRITE_FAILED");
    expect(f.handles[1]!.close).toHaveBeenCalledTimes(1);
    expect(f.handles[0]!.close).not.toHaveBeenCalled();
    expect(f.service.current).toBe(prior);
    prior.release();
    expect(f.handles[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("rechecks the prior after prehydration and fails a stale attempt before the write", async () => {
    const f = fixture();
    const prior = await f.service.reload({ documentId: "doc-1" });
    let resume!: () => void;
    f.rereadVerifiedPng.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { resume = resolve; });
      return { sha256: hashB, mimeType: "image/png", byteLength: 3, bytes: bytesB.slice() };
    });
    const pending = publishFirstCanonicalDraft({ ...f.options, priorPublication: prior });
    await vi.waitFor(() => expect(resume).toBeDefined());
    prior.release();
    resume();
    await expect(pending).rejects.toThrow("EDITOR_CANONICAL_DRAFT_PRIOR_MISMATCH");
    expect(f.writeCompleteRevisionIfPointersMatch).not.toHaveBeenCalled();
    expect(f.handles[1]!.close).toHaveBeenCalledTimes(1);
    expect(f.handles[0]!.close).toHaveBeenCalledTimes(1);
    expect(f.service.current).toBeNull();
  });

  it("cannot republish a reload whose captured pointers were malformed, while the reload itself still works", async () => {
    const f = fixture();
    vi.mocked(f.readPointers).mockImplementationOnce(async () => ({
      saved: { kind: "saved", documentId: "other", revisionId: "saved-x", sequence: 1 },
      draft: { kind: "draft", documentId: "doc-1", revisionId: "rev-1", sequence: 3 },
    }));
    const prior = await f.service.reload({ documentId: "doc-1" });
    expect(prior.identity.revisionId).toBe("rev-1");
    await expect(publishFirstCanonicalDraft({ ...f.options, priorPublication: prior }))
      .rejects.toThrow("EDITOR_CANONICAL_DRAFT_PRIOR_MISMATCH");
    expect(f.writeCompleteRevisionIfPointersMatch).not.toHaveBeenCalled();
    vi.mocked(f.readPointers).mockImplementationOnce(async () => ({
      saved: null,
      draft: { kind: "draft", documentId: "doc-1", revisionId: "rev-1", sequence: 3, parentApprovalHash: "sha256:zz" },
    }));
    const invalidHash = await f.service.reload({ documentId: "doc-1" });
    await expect(publishFirstCanonicalDraft({ ...f.options, priorPublication: invalidHash }))
      .rejects.toThrow("EDITOR_CANONICAL_DRAFT_PRIOR_MISMATCH");
    expect(f.writeCompleteRevisionIfPointersMatch).not.toHaveBeenCalled();
  });

  it("carries approval linkage through a second replacement and preserves lease lifetime", async () => {
    const f = fixture();
    const prior = await f.service.reload({ documentId: "doc-1" });
    const first = await publishFirstCanonicalDraft({ ...f.options, priorPublication: prior });
    // A republished live prior is a First publication: narrow it for the second call.
    const firstPublication = first as FirstCanonicalDraftPublication;
    prior.release();
    expect(f.handles[0]!.close).toHaveBeenCalledTimes(1);
    const second = await publishFirstCanonicalDraft({ ...f.options,
      revisionId: () => "draft-3", sequence: 5, priorPublication: firstPublication });
    const [, , next] = f.writeCompleteRevisionIfPointersMatch.mock.calls[1]!;
    expect(next).toMatchObject({ saved: f.saved,
      draft: { revisionId: "draft-3", sequence: 5, parentApprovalHash: approvalHash } });
    expect(second.pointers.draft).toMatchObject({ parentApprovalHash: approvalHash });
    // The duplicate hashB decode is discarded; the established handle outlives both live leases.
    expect(f.handles[2]!.close).toHaveBeenCalledTimes(1);
    expect(f.handles[1]!.close).not.toHaveBeenCalled();
    first.release();
    expect(f.handles[1]!.close).not.toHaveBeenCalled();
    second.release();
    second.release();
    expect(f.handles[1]!.close).toHaveBeenCalledTimes(1);
  });
});

// Type-level contract: never executed; tsc alone checks overload resolution and narrowing.
export async function typeContract(): Promise<void> {
  const f = fixture();
  const prior = await f.service.reload({ documentId: "doc-1" });
  const fabricated = null as unknown as FirstCanonicalDraftPublication;
  expectTypeOf(publishFirstCanonicalDraft(f.options)).toEqualTypeOf<Promise<FirstCanonicalDraftPublication>>();
  expectTypeOf(publishFirstCanonicalDraft({ ...f.options, priorPublication: fabricated }))
    .toEqualTypeOf<Promise<FirstCanonicalDraftPublication>>();
  expectTypeOf(publishFirstCanonicalDraft({ ...f.options, priorPublication: prior }))
    .toEqualTypeOf<Promise<FirstCanonicalDraftPublication | CanonicalDraftReloadPublication>>();
  const union = await publishFirstCanonicalDraft({ ...f.options,
    priorPublication: prior as FirstCanonicalDraftPublication | CanonicalDraftReloadPublication });
  // @ts-expect-error a union-prior result must be narrowed before createdAt exists
  expectTypeOf(union.createdAt).toEqualTypeOf<never>();
}
