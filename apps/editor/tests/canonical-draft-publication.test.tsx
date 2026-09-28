import { describe, expect, it, vi } from "vitest";
import { FIRST_SLICE_DOCUMENT } from "@particle-studio/scene-document";
import {
  createCompleteRevision, createSavedRevisionPointer,
  createRevisionPointersSnapshot, type ConditionalCompleteRevisionWritePort,
} from "@particle-studio/persistence";
import { createPngImageCache } from "../src/png-image-cache.js";
import { publishFirstCanonicalDraft } from "../src/canonical-draft-publication.js";

const hash = "sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
const bytes = new Uint8Array([1, 2, 3]);
const imageDocument = {
  ...FIRST_SLICE_DOCUMENT,
  rootIds: ["image-1"],
  elements: [{ id: "image-1", type: "image" as const, x: 0, y: 0,
    width: 20, height: 10, opacity: 1,
    asset: { sha256: hash, mimeType: "image/png" as const, byteLength: 3,
      intrinsicWidth: 20, intrinsicHeight: 10 } }],
  tracks: [],
};

function fixture(document: unknown = imageDocument) {
  const savedRevision = createCompleteRevision({
    documentId: "doc-1", revisionId: "saved-1", sequence: 2,
    document: FIRST_SLICE_DOCUMENT,
  });
  const saved = createSavedRevisionPointer(savedRevision);
  const pointers = createRevisionPointersSnapshot({ saved, draft: null });
  let currentPointers = pointers;
  const events: string[] = [];
  const writeCompleteRevision = vi.fn(async () => { events.push("unconditional write"); });
  const writeCompleteRevisionIfPointersMatch = vi.fn(async (
    _revision: Parameters<ConditionalCompleteRevisionWritePort["writeCompleteRevisionIfPointersMatch"]>[0],
    expected: Parameters<ConditionalCompleteRevisionWritePort["writeCompleteRevisionIfPointersMatch"]>[1],
    next: Parameters<ConditionalCompleteRevisionWritePort["writeCompleteRevisionIfPointersMatch"]>[2],
  ) => {
    if (JSON.stringify(currentPointers) !== JSON.stringify(expected)) throw new Error("stale pointers");
    currentPointers = next;
    events.push("write");
  });
  const adapter: ConditionalCompleteRevisionWritePort = {
    readRevision: vi.fn(async () => null),
    readPointers: vi.fn(async () => currentPointers),
    writeCompleteRevision,
    writeCompleteRevisionIfPointersMatch,
  };
  const handle = { close: vi.fn() };
  const rereadVerifiedPng = vi.fn(async () => {
    events.push("reread");
    return { sha256: hash, mimeType: "image/png", byteLength: 3, bytes: bytes.slice() };
  });
  const decodeVerifiedPng = vi.fn(async (asset: { sha256: string; bytes: Uint8Array }) => {
    events.push("decode");
    return { ...asset, mimeType: "image/png", byteLength: 3,
      width: 20, height: 10, handle };
  });
  const cache = createPngImageCache({
    importVerifiedPng: async () => { throw new Error("unexpected import"); },
    decodeVerifiedPng: async () => { throw new Error("unexpected decode"); },
  });
  const options = {
    editableJson: JSON.stringify(document), documentId: "doc-1",
    revisionId: () => "draft-1", sequence: 3, createdAt: () => 1234,
    persistence: adapter, cache, prehydration: { rereadVerifiedPng, decodeVerifiedPng },
  };
  return { options, saved, pointers, events, handle, writeCompleteRevision,
    writeCompleteRevisionIfPointersMatch, setPointers: (next: typeof pointers) => { currentPointers = next; },
    rereadVerifiedPng, decodeVerifiedPng, adapter };
}

describe("first canonical draft publication", () => {
  it("prehydrates all references before atomically writing a complete revision and draft pointer", async () => {
    const f = fixture();
    const publication = await publishFirstCanonicalDraft(f.options);
    expect(f.events).toEqual(["reread", "decode", "write"]);
    expect(f.writeCompleteRevision).not.toHaveBeenCalled();
    expect(f.writeCompleteRevisionIfPointersMatch).toHaveBeenCalledTimes(1);
    const [revision, expected, pointers] = f.writeCompleteRevisionIfPointersMatch.mock.calls[0]!;
    expect(expected).toEqual(f.pointers);
    expect(revision).toMatchObject({ documentId: "doc-1", revisionId: "draft-1", sequence: 3 });
    expect(revision.document).toEqual(publication.workspace.plan.document);
    expect(pointers).toEqual({ saved: f.saved,
      draft: { kind: "draft", documentId: "doc-1", revisionId: "draft-1", sequence: 3 } });
    expect(publication).toMatchObject({ createdAt: 1234, revision, pointers });
    expect(publication.workspace.images).toHaveLength(1);
    expect(Object.isFrozen(publication)).toBe(true);
    expect(Object.isFrozen(publication.workspace)).toBe(true);
    publication.release();
    publication.release();
    expect(f.handle.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the caller's original values and port across a pending pointer read", async () => {
    const f = fixture();
    let finishRead!: (pointers: typeof f.pointers) => void;
    vi.mocked(f.adapter.readPointers).mockImplementationOnce(() =>
      new Promise((resolve) => { finishRead = resolve; }));
    const redirectedWrite = vi.fn();
    const pending = publishFirstCanonicalDraft(f.options);
    expect(f.adapter.readPointers).toHaveBeenCalledWith("doc-1");
    f.options.documentId = "doc-2";
    f.options.sequence = 99;
    f.options.revisionId = () => "redirected";
    f.options.createdAt = () => 9999;
    f.options.prehydration = { ...f.options.prehydration,
      rereadVerifiedPng: vi.fn(async () => { throw new Error("redirected prehydration"); }) };
    f.options.cache = createPngImageCache({
      importVerifiedPng: async () => { throw new Error("redirected cache"); },
      decodeVerifiedPng: async () => { throw new Error("redirected cache"); },
    });
    f.options.persistence = { ...f.adapter,
      writeCompleteRevisionIfPointersMatch: redirectedWrite };
    finishRead(f.pointers);
    const publication = await pending;
    expect(publication.revision).toMatchObject({ documentId: "doc-1", revisionId: "draft-1", sequence: 3 });
    expect(publication.createdAt).toBe(1234);
    expect(f.rereadVerifiedPng).toHaveBeenCalledTimes(1);
    expect(f.writeCompleteRevisionIfPointersMatch).toHaveBeenCalledTimes(1);
    expect(redirectedWrite).not.toHaveBeenCalled();
    publication.release();
  });

  it("retains both prehydration callbacks when their object is mutated during a pending pointer read", async () => {
    const f = fixture();
    let finishRead!: (pointers: typeof f.pointers) => void;
    vi.mocked(f.adapter.readPointers).mockImplementationOnce(() =>
      new Promise((resolve) => { finishRead = resolve; }));
    const dependencies = f.options.prehydration;
    const pending = publishFirstCanonicalDraft(f.options);
    expect(f.adapter.readPointers).toHaveBeenCalledWith("doc-1");
    const redirectedReread = vi.fn(async () => { throw new Error("redirected reread"); });
    const redirectedDecode = vi.fn(async () => { throw new Error("redirected decode"); });
    dependencies.rereadVerifiedPng = redirectedReread;
    dependencies.decodeVerifiedPng = redirectedDecode;
    expect(f.options.prehydration).toBe(dependencies);
    finishRead(f.pointers);
    const publication = await pending;
    expect(f.events).toEqual(["reread", "decode", "write"]);
    expect(f.rereadVerifiedPng).toHaveBeenCalledTimes(1);
    expect(f.decodeVerifiedPng).toHaveBeenCalledTimes(1);
    expect(redirectedReread).not.toHaveBeenCalled();
    expect(redirectedDecode).not.toHaveBeenCalled();
    publication.release();
  });

  it("retains the conditional write on the same port across a pending pointer read", async () => {
    const f = fixture();
    let finishRead!: (pointers: typeof f.pointers) => void;
    vi.mocked(f.adapter.readPointers).mockImplementationOnce(() =>
      new Promise((resolve) => { finishRead = resolve; }));
    f.writeCompleteRevisionIfPointersMatch.mockImplementationOnce(async function (this: ConditionalCompleteRevisionWritePort) {
      expect(this).toBe(f.adapter);
      throw new Error("disk");
    });
    const pending = publishFirstCanonicalDraft(f.options);
    expect(f.adapter.readPointers).toHaveBeenCalledWith("doc-1");
    const redirectedWrite = vi.fn(async () => {});
    f.adapter.writeCompleteRevisionIfPointersMatch = redirectedWrite;
    expect(f.options.persistence).toBe(f.adapter);
    finishRead(f.pointers);
    await expect(pending).rejects.toThrow("disk");
    expect(f.writeCompleteRevisionIfPointersMatch).toHaveBeenCalledTimes(1);
    expect(redirectedWrite).not.toHaveBeenCalled();
    expect(f.handle.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the original port when the caller swaps it during prehydration", async () => {
    const f = fixture();
    let resume!: () => void;
    f.rereadVerifiedPng.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { resume = resolve; });
      return { sha256: hash, mimeType: "image/png", byteLength: 3, bytes: bytes.slice() };
    });
    const pending = publishFirstCanonicalDraft(f.options);
    await vi.waitFor(() => expect(resume).toBeDefined());
    const redirectedWrite = vi.fn();
    f.options.persistence = { ...f.adapter,
      writeCompleteRevisionIfPointersMatch: redirectedWrite };
    resume();
    const publication = await pending;
    expect(f.writeCompleteRevisionIfPointersMatch).toHaveBeenCalledTimes(1);
    expect(redirectedWrite).not.toHaveBeenCalled();
    publication.release();
  });

  it("keeps an existing saved pointer and permits an empty first draft without decoding", async () => {
    const f = fixture(FIRST_SLICE_DOCUMENT);
    const publication = await publishFirstCanonicalDraft(f.options);
    expect(publication.pointers.saved).toEqual(f.saved);
    expect(publication.workspace.images).toEqual([]);
    expect(f.rereadVerifiedPng).not.toHaveBeenCalled();
    expect(f.decodeVerifiedPng).not.toHaveBeenCalled();
    publication.release();
  });

  it("does not write or expose a workspace for an invalid sequence or existing draft", async () => {
    const f = fixture();
    await expect(publishFirstCanonicalDraft({ ...f.options, sequence: 2 })).rejects.toThrow();
    await expect(publishFirstCanonicalDraft({ ...f.options, sequence: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow();
    vi.mocked(f.adapter.readPointers).mockResolvedValue(createRevisionPointersSnapshot({
      saved: f.saved, draft: { kind: "draft", documentId: "doc-1", revisionId: "other", sequence: 3 },
    }));
    await expect(publishFirstCanonicalDraft(f.options)).rejects.toThrow();
    expect(f.writeCompleteRevisionIfPointersMatch).not.toHaveBeenCalled();
    expect(f.writeCompleteRevision).not.toHaveBeenCalled();
  });

  it("does not write if prehydration fails and releases leases if the atomic write fails", async () => {
    const f = fixture();
    f.rereadVerifiedPng.mockRejectedValueOnce(new Error("missing"));
    await expect(publishFirstCanonicalDraft(f.options)).rejects.toThrow();
    expect(f.writeCompleteRevisionIfPointersMatch).not.toHaveBeenCalled();
    f.writeCompleteRevisionIfPointersMatch.mockRejectedValueOnce(new Error("disk"));
    await expect(publishFirstCanonicalDraft(f.options)).rejects.toThrow("disk");
    expect(f.handle.close).toHaveBeenCalledTimes(1);
    expect(f.writeCompleteRevision).not.toHaveBeenCalled();
  });

  it("does not expose the workspace before the conditional write finishes", async () => {
    const f = fixture();
    let finishWrite!: () => void;
    f.writeCompleteRevisionIfPointersMatch.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishWrite = resolve; });
      f.events.push("write");
    });
    let exposed = false;
    const pending = publishFirstCanonicalDraft(f.options).then((result) => {
      exposed = true;
      return result;
    });
    await vi.waitFor(() => expect(finishWrite).toBeDefined());
    expect(exposed).toBe(false);
    expect(f.handle.close).not.toHaveBeenCalled();
    finishWrite();
    const publication = await pending;
    expect(exposed).toBe(true);
    publication.release();
  });

  it.each(["saved", "draft"] as const)("rejects a %s pointer race during pending prehydration", async (changed) => {
    const f = fixture();
    let resume!: () => void;
    f.rereadVerifiedPng.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { resume = resolve; });
      return { sha256: hash, mimeType: "image/png", byteLength: 3, bytes: bytes.slice() };
    });
    const publication = publishFirstCanonicalDraft(f.options);
    // The read has completed when prehydration starts, but the write has not happened.
    await vi.waitFor(() => expect(resume).toBeDefined());
    f.setPointers(createRevisionPointersSnapshot({
      saved: changed === "saved" ? createSavedRevisionPointer(createCompleteRevision({
        documentId: "doc-1", revisionId: "saved-2", sequence: 3, document: FIRST_SLICE_DOCUMENT,
      })) : f.saved,
      draft: changed === "draft" ? { kind: "draft", documentId: "doc-1", revisionId: "rival", sequence: 3 } : null,
    }));
    resume();
    await expect(publication).rejects.toThrow("stale pointers");
    expect(f.writeCompleteRevisionIfPointersMatch).toHaveBeenCalledTimes(1);
    expect(f.writeCompleteRevision).not.toHaveBeenCalled();
    expect(f.handle.close).toHaveBeenCalledTimes(1);
  });
});
