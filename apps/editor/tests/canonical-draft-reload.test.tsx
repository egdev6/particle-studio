import { describe, expect, it, vi } from "vitest";
import { FIRST_SLICE_DOCUMENT } from "@particle-studio/scene-document";
import { createCompleteRevision } from "@particle-studio/persistence";
import { createCanonicalDraftReloadService } from "../src/canonical-draft-reload.js";
import { createPngImageCache } from "../src/png-image-cache.js";

const bytesA = new Uint8Array([1, 2, 3]);
const bytesB = new Uint8Array([97, 98, 99]);
const hashA = "sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
const hashB = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const failure = "EDITOR_CANONICAL_DRAFT_RELOAD_FAILED";

const imageDocument = (...sha256s: string[]) => ({
  ...FIRST_SLICE_DOCUMENT,
  rootIds: sha256s.map((_, index) => `image-${index + 1}`), tracks: [],
  elements: sha256s.map((sha256, index) => ({ id: `image-${index + 1}`, type: "image" as const,
    asset: { sha256, mimeType: "image/png" as const, byteLength: 3,
      intrinsicWidth: 20, intrinsicHeight: 10 },
    x: 0, y: 0, width: 20, height: 10, opacity: 1 })),
});

function setup() {
  const revisions = new Map<string, ReturnType<typeof createCompleteRevision>>();
  const pointer = { revisionId: "rev-1", sequence: 3 };
  const madeHandles: { close: ReturnType<typeof vi.fn> }[] = [];
  const dependencies = {
    persistence: {
      readPointers: vi.fn(async (documentId: string): Promise<unknown> => ({
        draft: { kind: "draft", documentId, revisionId: pointer.revisionId, sequence: pointer.sequence },
      })),
      readRevision: vi.fn(async (_documentId: string, revisionId: string): Promise<unknown> =>
        revisions.get(revisionId)),
    },
    prehydration: {
      rereadVerifiedPng: vi.fn(async (sha256: string): Promise<unknown> => ({
        sha256, mimeType: "image/png", byteLength: 3,
        bytes: (sha256 === hashA ? bytesA : bytesB).slice(),
      })),
      decodeVerifiedPng: vi.fn(async (verified: { sha256: string; bytes: Uint8Array }) => {
        const handle = { close: vi.fn() };
        madeHandles.push(handle);
        return { ...verified, width: 20, height: 10, handle };
      }),
    },
    cache: createPngImageCache({
      importVerifiedPng: async () => { throw new Error("must not write"); },
      decodeVerifiedPng: async () => { throw new Error("must not import"); },
    }),
  };
  return {
    dependencies, pointer, madeHandles,
    revision(revisionId: string, sha256s: string | string[], sequence = 3) {
      pointer.revisionId = revisionId;
      pointer.sequence = sequence;
      revisions.set(revisionId, createCompleteRevision({
        documentId: "doc", revisionId, sequence,
        document: imageDocument(...(Array.isArray(sha256s) ? sha256s : [sha256s])),
      }));
    },
    reference: (sha256: string, index = 0) => ({ elementId: `image-${index + 1}`, sha256,
      mimeType: "image/png", byteLength: 3, intrinsicWidth: 20, intrinsicHeight: 10 }),
  };
}

describe("canonical draft reload", () => {
  it("composes durable reads, parity, and hydration into one atomic swap", async () => {
    const fixture = setup();
    fixture.revision("rev-1", hashA);
    const service = createCanonicalDraftReloadService(fixture.dependencies);
    expect(service.current).toBeNull();
    const publication = await service.reload({ documentId: "doc" });
    expect(service.current).toBe(publication);
    expect(publication.identity).toEqual({ kind: "draft", documentId: "doc", revisionId: "rev-1", sequence: 3 });
    expect(publication.revision.revisionId).toBe("rev-1");
    expect(publication.workspace.plan.references).toEqual([fixture.reference(hashA)]);
    expect(fixture.dependencies.persistence.readPointers).toHaveBeenCalledExactlyOnceWith("doc");
    expect(fixture.dependencies.persistence.readRevision).toHaveBeenCalledExactlyOnceWith("doc", "rev-1");
    expect(fixture.dependencies.prehydration.rereadVerifiedPng).toHaveBeenCalledWith(hashA);
  });

  it("preserves the current publication on read, parity, and preparation failure", async () => {
    const fixture = setup();
    fixture.revision("rev-1", hashA);
    const service = createCanonicalDraftReloadService(fixture.dependencies);
    const publication = await service.reload({ documentId: "doc" });
    const handle = fixture.madeHandles[0]!;
    fixture.dependencies.persistence.readRevision.mockRejectedValueOnce(new Error("private"));
    await expect(service.reload({ documentId: "doc" })).rejects.toThrow(failure);
    expect(service.current).toBe(publication);
    expect(handle.close).not.toHaveBeenCalled();
    fixture.dependencies.persistence.readRevision.mockResolvedValueOnce({
      documentId: "doc", revisionId: "rev-1", sequence: 3, document: { nested: { value: 1 } },
      canonicalization: { identifier: "jcs-1", byteLength: 2 }, canonicalBytes: new Uint8Array([1, 2]),
    });
    await expect(service.reload({ documentId: "doc" })).rejects.toThrow(failure);
    expect(service.current).toBe(publication);
    expect(handle.close).not.toHaveBeenCalled();
    fixture.dependencies.prehydration.rereadVerifiedPng.mockRejectedValueOnce(new Error("private"));
    await expect(service.reload({ documentId: "doc" })).rejects.toThrow(failure);
    expect(service.current).toBe(publication);
    expect(handle.close).not.toHaveBeenCalled();
  });

  it("releases the previous publication only after the swap and tolerates stale releases", async () => {
    const fixture = setup();
    fixture.revision("rev-1", hashA);
    const service = createCanonicalDraftReloadService(fixture.dependencies);
    const first = await service.reload({ documentId: "doc" });
    fixture.revision("rev-2", hashB, 4);
    const second = await service.reload({ documentId: "doc" });
    expect(service.current).toBe(second);
    expect(second.identity.revisionId).toBe("rev-2");
    expect(fixture.madeHandles[0]!.close).toHaveBeenCalledTimes(1);
    expect(fixture.madeHandles[1]!.close).not.toHaveBeenCalled();
    first.release();
    first.release();
    expect(fixture.madeHandles[0]!.close).toHaveBeenCalledTimes(1);
    expect(fixture.madeHandles[1]!.close).not.toHaveBeenCalled();
  });

  it("serializes concurrent reloads so each reads fresh state after its predecessor", async () => {
    const fixture = setup();
    fixture.revision("rev-1", hashA);
    const service = createCanonicalDraftReloadService(fixture.dependencies);
    let resume!: (value: unknown) => void;
    fixture.dependencies.persistence.readPointers.mockImplementationOnce((): Promise<unknown> =>
      new Promise((resolve) => { resume = resolve; }));
    const first = service.reload({ documentId: "doc" });
    const second = service.reload({ documentId: "doc" });
    await vi.waitFor(() =>
      expect(fixture.dependencies.persistence.readPointers).toHaveBeenCalledTimes(1));
    fixture.revision("rev-2", hashB, 4);
    resume({ draft: { kind: "draft", documentId: "doc", revisionId: "rev-1", sequence: 3 } });
    const [one, two] = await Promise.all([first, second]);
    expect(one.identity.revisionId).toBe("rev-1");
    expect(two.identity.revisionId).toBe("rev-2");
    expect(service.current).toBe(two);
    expect(fixture.dependencies.persistence.readPointers).toHaveBeenCalledTimes(2);
    expect(fixture.madeHandles[0]!.close).toHaveBeenCalledTimes(1);
    expect(fixture.madeHandles[1]!.close).not.toHaveBeenCalled();
  });

  it("routes both release entry points through one authority in either order", async () => {
    const fixture = setup();
    fixture.revision("rev-1", hashA);
    const service = createCanonicalDraftReloadService(fixture.dependencies);
    const publication = await service.reload({ documentId: "doc" });
    publication.workspace.release();
    expect(service.current).toBeNull();
    expect(fixture.madeHandles[0]!.close).toHaveBeenCalledTimes(1);
    publication.release();
    expect(fixture.madeHandles[0]!.close).toHaveBeenCalledTimes(1);
    const reloaded = await service.reload({ documentId: "doc" });
    expect(service.current).toBe(reloaded);
    expect(reloaded.workspace.images[0]?.sha256).toBe(hashA);
    reloaded.release();
    expect(service.current).toBeNull();
    expect(fixture.madeHandles[1]!.close).toHaveBeenCalledTimes(1);
    reloaded.workspace.release();
    expect(fixture.madeHandles[1]!.close).toHaveBeenCalledTimes(1);
  });

  it("hydrates a reference-free document without touching image dependencies", async () => {
    const fixture = setup();
    const service = createCanonicalDraftReloadService(fixture.dependencies);
    fixture.pointer.revisionId = "plain";
    fixture.dependencies.persistence.readRevision.mockResolvedValueOnce(
      createCompleteRevision({ documentId: "doc", revisionId: "plain", sequence: 3,
        document: FIRST_SLICE_DOCUMENT }));
    const publication = await service.reload({ documentId: "doc" });
    expect(publication.workspace.images).toEqual([]);
    expect(fixture.dependencies.prehydration.rereadVerifiedPng).not.toHaveBeenCalled();
  });

  it("snapshots options and ports at call time so queued work cannot mix sources", async () => {
    const fixture = setup();
    fixture.revision("rev-1", hashA);
    const dependencies = fixture.dependencies;
    const service = createCanonicalDraftReloadService(dependencies);
    const request = { documentId: "doc" };
    const first = service.reload(request);
    // Reassignment after the call, before the queued attempt runs, has no effect.
    request.documentId = "other";
    const alt = setup();
    alt.revision("rev-1", hashB);
    dependencies.persistence = alt.dependencies.persistence;
    dependencies.prehydration = alt.dependencies.prehydration;
    dependencies.cache = alt.dependencies.cache;
    const publication = await first;
    expect(publication.identity.documentId).toBe("doc");
    expect(publication.workspace.images[0]?.sha256).toBe(hashA);
    expect(alt.dependencies.persistence.readPointers).not.toHaveBeenCalled();
    expect(alt.dependencies.prehydration.rereadVerifiedPng).not.toHaveBeenCalled();
  });

  it("maps malformed dependencies and unknown documents to one public error", async () => {
    const service = createCanonicalDraftReloadService({} as never);
    await expect(service.reload({ documentId: "doc" })).rejects.toThrow(failure);
    const fixture = setup();
    const valid = createCanonicalDraftReloadService(fixture.dependencies);
    await expect(valid.reload({ documentId: "missing" })).rejects.toThrow(failure);
  });

  it("releases only the failed attempt's leases when adoption fails after the first new one", async () => {
    const fixture = setup();
    fixture.revision("rev-1", hashA);
    const cache = fixture.dependencies.cache;
    let adoptions = 0;
    const service = createCanonicalDraftReloadService({ ...fixture.dependencies,
      cache: { ...cache, adoptStaged: (candidate: unknown) =>
        ++adoptions === 3 ? null : cache.adoptStaged(candidate) } });
    const first = await service.reload({ documentId: "doc" });
    fixture.revision("rev-2", [hashA, hashB], 4);
    await expect(service.reload({ documentId: "doc" })).rejects.toThrow(failure);
    expect(service.current).toBe(first);
    // Only the new attempt's resources were cleaned: the live hashA lease stays.
    expect(fixture.madeHandles[0]!.close).not.toHaveBeenCalled();
    expect(fixture.madeHandles[1]!.close).toHaveBeenCalledTimes(1);
    expect(fixture.madeHandles[2]!.close).toHaveBeenCalledTimes(1);
    expect(cache.resolveImage({ sha256: hashA, mimeType: "image/png", byteLength: 3,
      width: 20, height: 10 })).not.toBeNull();
  });

  it("cannot corrupt the replacement via a stale release from a cleanup callback", async () => {
    const fixture = setup();
    fixture.revision("rev-1", hashA);
    let stale: { release(): void } | null = null;
    fixture.dependencies.prehydration.decodeVerifiedPng.mockImplementationOnce(async (verified) => {
      const handle = { close: vi.fn(() => { stale?.release(); }) };
      fixture.madeHandles.push(handle);
      return { ...verified, width: 20, height: 10, handle };
    });
    const service = createCanonicalDraftReloadService(fixture.dependencies);
    stale = await service.reload({ documentId: "doc" });
    fixture.revision("rev-2", hashB, 4);
    const second = await service.reload({ documentId: "doc" });
    expect(service.current).toBe(second);
    expect(fixture.madeHandles[0]!.close).toHaveBeenCalledTimes(1);
    expect(fixture.madeHandles[1]!.close).not.toHaveBeenCalled();
    expect(second.workspace.images[0]?.sha256).toBe(hashB);
  });

  it("allows an explicit current release mid-read and still publishes the attempt", async () => {
    const fixture = setup();
    fixture.revision("rev-1", hashA);
    const service = createCanonicalDraftReloadService(fixture.dependencies);
    const first = await service.reload({ documentId: "doc" });
    fixture.revision("rev-2", hashB, 4);
    let resume!: (value: unknown) => void;
    fixture.dependencies.prehydration.rereadVerifiedPng.mockImplementationOnce((): Promise<unknown> =>
      new Promise((resolve) => { resume = resolve; }));
    const pending = service.reload({ documentId: "doc" });
    await vi.waitFor(() =>
      expect(fixture.dependencies.prehydration.rereadVerifiedPng).toHaveBeenCalledTimes(2));
    first.release();
    expect(service.current).toBeNull();
    resume({ sha256: hashB, mimeType: "image/png", byteLength: 3, bytes: bytesB.slice() });
    const second = await pending;
    expect(service.current).toBe(second);
    expect(fixture.madeHandles[0]!.close).toHaveBeenCalledTimes(1);
    second.release();
  });
});
