import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIRST_SLICE_DOCUMENT } from "@particle-studio/scene-document";
import {
  createCompleteRevision, createDraftRevisionPointer, createRevisionPointersSnapshot,
} from "@particle-studio/persistence";
import {
  createIndexedDbPersistenceAdapter, deleteIndexedDbPersistenceDatabase,
} from "@particle-studio/persistence-indexeddb";
import { createPngImageCache } from "../src/png-image-cache.js";
import { createDurableDraftWorkspace } from "../src/durable-draft-workspace.js";
import type {
  DurableDraftPublishInput, DurableDraftPublication,
  DurableDraftWriteWorkspaceDependencies, DurableDraftWorkspaceDependencies,
} from "../src/durable-draft-workspace.js";
import { prehydrateCanonicalReferences } from "../src/canonical-reference-prehydration.js";

const hashA = "sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
const hashB = "sha256:787c798e39a5bc1910355bae6d0cd87a36b2e10fd0202a83e3bb6b005da83472";
const approvalHash = `sha256:${"c".repeat(64)}`;
const bytesA = new Uint8Array([1, 2, 3]);
const bytesB = new Uint8Array([4, 5, 6]);

type Handle = { close(): void };

const imageDocument = (...shas: string[]) => ({
  ...FIRST_SLICE_DOCUMENT,
  rootIds: shas.map((_, index) => `image-${index + 1}`),
  elements: shas.map((sha, index) => ({
    id: `image-${index + 1}`, type: "image" as const, x: 0, y: index * 5,
    width: 20, height: 10, opacity: 1,
    asset: { sha256: sha, mimeType: "image/png" as const, byteLength: 3,
      intrinsicWidth: 20, intrinsicHeight: 10 },
  })),
  tracks: [],
});

const databases: string[] = [];

function fixture() {
  const databaseName = `durable-draft-workspace-${Date.now()}-${Math.random()}`;
  databases.push(databaseName);
  const adapter = createIndexedDbPersistenceAdapter({ databaseName });
  const log: string[] = [];
  const handles: Handle[] = [];
  const closed: Handle[] = [];
  let gate: Promise<void> | null = null;
  let failDecodeFor: string | null = null;
  const rereadVerifiedPng = async (sha256: string) => {
    log.push(`reread:${sha256}`);
    if (gate) await gate;
    return adapter.readAsset(sha256);
  };
  const decodeVerifiedPng = async (verified: {
    sha256: string; byteLength: number; bytes: Uint8Array;
  }) => {
    log.push(`decode:${verified.sha256}`);
    if (failDecodeFor === verified.sha256) throw new Error("controlled decode failure");
    const handle: Handle = { close: () => { closed.push(handle); } };
    handles.push(handle);
    return { sha256: verified.sha256, mimeType: "image/png", byteLength: verified.byteLength,
      width: 20, height: 10, handle, bytes: verified.bytes };
  };
  const cache = createPngImageCache({
    importVerifiedPng: async () => { throw new Error("unexpected import"); },
    decodeVerifiedPng: async () => { throw new Error("unexpected decode"); },
  });
  const deps = {
    persistence: adapter, cache, prehydration: { rereadVerifiedPng, decodeVerifiedPng },
  };
  const workspace = createDurableDraftWorkspace(deps);
  const seedDraft = async (revisionId: string, sequence: number, sha256: string,
    bytes: Uint8Array | null, parentApprovalHash?: string) => {
    if (bytes) await adapter.writeAsset({ mimeType: "image/png", bytes });
    const revision = createCompleteRevision({
      documentId: "doc-1", revisionId, sequence, document: imageDocument(sha256),
    });
    await adapter.writeCompleteRevision(revision, createRevisionPointersSnapshot({
      saved: null, draft: createDraftRevisionPointer(revision, parentApprovalHash),
    }));
  };
  return {
    adapter, workspace, deps, log, handles, closed,
    gate: (pending: Promise<void> | null) => { gate = pending; },
    failDecode: (sha256: string | null) => { failDecodeFor = sha256; },
    seedDraft,
  };
}

const publishInput = (revisionId: string, sequence: number, sha256: string) => ({
  documentId: "doc-1", editableJson: JSON.stringify(imageDocument(sha256)),
  revisionId: () => revisionId, sequence, createdAt: () => 1234,
});

afterEach(async () => {
  while (databases.length > 0) {
    await deleteIndexedDbPersistenceDatabase(databases.pop()!);
  }
});

describe("durable draft workspace (actual persistence-indexeddb adapter)", () => {
  it("reloads a durable draft through the real adapter and releases via both paths", async () => {
    const f = fixture();
    await f.seedDraft("rev-1", 1, hashA, bytesA, approvalHash);
    expect(f.workspace.current).toBeNull();
    const loaded = await f.workspace.reload({ documentId: "doc-1" });
    expect(loaded.revision).toMatchObject({ documentId: "doc-1", revisionId: "rev-1", sequence: 1 });
    expect(loaded.workspace.images).toHaveLength(1);
    expect(loaded.workspace.images[0]!.sha256).toBe(hashA);
    expect(loaded.workspace.plan.canonicalEditableJson).toBeTruthy();
    expect(f.workspace.current).toBe(loaded);
    // Approval linkage survives through the real adapter's pointer read.
    const pointers = await f.adapter.readPointers("doc-1");
    expect(pointers.draft).toMatchObject({
      revisionId: "rev-1", sequence: 1, parentApprovalHash: approvalHash,
    });
    // Release via publication.release clears current and disposes the image.
    const [handle] = f.handles;
    expect(f.closed).not.toContain(handle);
    loaded.release();
    expect(f.workspace.current).toBeNull();
    expect(f.closed).toContain(handle);
    // Stale and repeated releases through either path are no-ops.
    loaded.release();
    loaded.workspace.release();
    expect(f.closed).toEqual([handle]);
    expect(f.workspace.current).toBeNull();
  });

  it("swaps atomically on successful replacement and releases the superseded publication", async () => {
    const f = fixture();
    await f.seedDraft("rev-1", 1, hashA, bytesA);
    const loaded = await f.workspace.reload({ documentId: "doc-1" });
    const [loadedHandle] = f.handles;
    await f.seedDraft("rev-2", 2, hashB, bytesB, approvalHash);
    const replaced = await f.workspace.reload({ documentId: "doc-1" });
    expect(replaced.revision).toMatchObject({ revisionId: "rev-2", sequence: 2 });
    expect(f.workspace.current).toBe(replaced);
    // The coordinator released the superseded publication's own resources.
    expect(f.closed).toEqual([loadedHandle]);
    expect(f.handles).toEqual([loadedHandle, replaced.workspace.images[0]!.handle]);
    // A stale release of the superseded publication never disturbs the new current.
    loaded.release();
    expect(f.workspace.current).toBe(replaced);
    expect(f.closed).toEqual([loadedHandle]);
  });

  it("preserves the previous live publication when a read fails and recovers later", async () => {
    const f = fixture();
    await f.seedDraft("rev-1", 1, hashA, bytesA, approvalHash);
    const loaded = await f.workspace.reload({ documentId: "doc-1" });
    const [loadedHandle] = f.handles;
    // Draft rev-2 references an asset that was never written to the adapter.
    await f.seedDraft("rev-2", 2, hashB, null, approvalHash);
    await expect(f.workspace.reload({ documentId: "doc-1" }))
      .rejects.toThrow("EDITOR_CANONICAL_DRAFT_RELOAD_FAILED");
    // The failed attempt releases only its own resources; the previous stays live.
    expect(f.workspace.current).toBe(loaded);
    expect(f.closed).not.toContain(loadedHandle);
    expect(loaded.workspace.images[0]!.handle).toBe(loadedHandle);
    // Recovery: once the asset exists, the next reload swaps and releases its prior.
    await f.adapter.writeAsset({ mimeType: "image/png", bytes: bytesB });
    const recovered = await f.workspace.reload({ documentId: "doc-1" });
    expect(recovered.revision.revisionId).toBe("rev-2");
    expect(f.workspace.current).toBe(recovered);
    expect(f.closed).toContain(loadedHandle);
  });

  it("preserves the previous live publication when hydration fails, recovering later", async () => {
    const f = fixture();
    await f.seedDraft("rev-1", 1, hashA, bytesA);
    const loaded = await f.workspace.reload({ documentId: "doc-1" });
    const [loadedHandle] = f.handles;
    await f.seedDraft("rev-2", 2, hashB, bytesB);
    f.failDecode(hashB);
    await expect(f.workspace.reload({ documentId: "doc-1" }))
      .rejects.toThrow("EDITOR_CANONICAL_DRAFT_RELOAD_FAILED");
    f.failDecode(null);
    // The previous publication and its image lease are untouched; only the failed
    // attempt's staged resources were rolled back.
    expect(f.workspace.current).toBe(loaded);
    expect(f.closed).not.toContain(loadedHandle);
    expect(f.closed).toEqual(f.handles.slice(1));
    // Recovery: the same draft reloads once the controlled decode works.
    const recovered = await f.workspace.reload({ documentId: "doc-1" });
    expect(recovered.revision.revisionId).toBe("rev-2");
    expect(f.workspace.current).toBe(recovered);
    expect(f.closed).toContain(loadedHandle);
    recovered.release();
    expect(f.closed).toContain(recovered.workspace.images[0]!.handle);
  });

  it("serializes attempts through one queue and honors pre-queue snapshots", async () => {
    const f = fixture();
    await f.seedDraft("rev-1", 1, hashA, bytesA);
    const initial = await f.workspace.reload({ documentId: "doc-1" });
    expect(initial.revision.revisionId).toBe("rev-1");
    let releaseGate!: () => void;
    f.gate(new Promise<void>((resolve) => { releaseGate = resolve; }));
    const first = f.workspace.reload({ documentId: "doc-1" });
    // The first attempt is blocked in its controlled reread (rev-1 pointers read);
    // seed rev-2 and queue a second attempt behind it.
    await f.seedDraft("rev-2", 2, hashA, bytesA);
    const secondOptions = { documentId: "doc-1" };
    const second = f.workspace.reload(secondOptions);
    // Snapshot before queueing: mutating the input afterwards cannot change the attempt.
    secondOptions.documentId = "doc-2";
    // While the queue is blocked, nothing else decodes.
    expect(f.log.filter((entry) => entry.startsWith("decode:"))).toHaveLength(1);
    releaseGate();
    const loadedFirst = await first;
    expect(loadedFirst.revision.revisionId).toBe("rev-1");
    const loadedSecond = await second;
    expect(loadedSecond.revision.revisionId).toBe("rev-2");
    expect(loadedSecond.revision.documentId).toBe("doc-1");
    expect(f.workspace.current).toBe(loadedSecond);
    // One decode each — initial, first, second — strictly in queue order.
    expect(f.log.filter((entry) => entry.startsWith("decode:")))
      .toEqual([`decode:${hashA}`, `decode:${hashA}`, `decode:${hashA}`]);
  });

  it("snapshots dependency ports and bound methods before queueing", async () => {
    const f = fixture();
    await f.seedDraft("rev-1", 1, hashA, bytesA, approvalHash);
    let releaseGate!: () => void;
    f.gate(new Promise<void>((resolve) => { releaseGate = resolve; }));
    const blocked = f.workspace.reload({ documentId: "doc-1" });
    const pending = f.workspace.reload({ documentId: "doc-1" });
    // Mutating a dependency port after the attempt queued cannot change the attempt.
    const originalReread = f.deps.prehydration.rereadVerifiedPng;
    f.deps.prehydration.rereadVerifiedPng = async () => {
      throw new Error("mutated dep used");
    };
    // Same-object method replacement on the persistence port and the cache: the
    // queued attempts keep the receivers and method values captured pre-queue.
    const genuineReadPointers = f.deps.persistence.readPointers.bind(f.deps.persistence);
    f.deps.persistence.readPointers = async () => {
      throw new Error("mutated persistence used");
    };
    const genuineAdoptStaged = f.deps.cache.adoptStaged;
    f.deps.cache.adoptStaged = () => {
      throw new Error("mutated cache used");
    };
    releaseGate();
    await blocked;
    const loaded = await pending;
    expect(loaded.revision).toMatchObject({ revisionId: "rev-1", sequence: 1 });
    expect(loaded.workspace.images).toHaveLength(1);
    // Later invocations capture their then-current methods (no forever binding):
    // wrapping the genuine adopt reveals which value the next attempt uses.
    f.deps.prehydration.rereadVerifiedPng = originalReread;
    f.deps.persistence.readPointers = genuineReadPointers;
    let adopted = 0;
    f.deps.cache.adoptStaged = (candidate: unknown) => {
      adopted += 1;
      return genuineAdoptStaged.call(f.deps.cache, candidate);
    };
    const again = await f.workspace.reload({ documentId: "doc-1" });
    expect(again.revision.revisionId).toBe("rev-1");
    expect(adopted).toBe(1);
  });

  it("keeps tail coordination with external prehydration sharing the original cache", async () => {
    const f = fixture();
    await f.seedDraft("rev-1", 1, hashA, bytesA, approvalHash);
    const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    // An external prehydration holds the only tail for hashA on the ORIGINAL
    // cache object while its decode is gated; the coordinator must wait on it.
    const externalLog: string[] = [];
    const external = prehydrateCanonicalReferences(
      {
        document: imageDocument(hashA),
        canonicalEditableJson: "unused-by-prehydration",
        references: [{ elementId: "external", sha256: hashA, mimeType: "image/png" as const,
          byteLength: 3, intrinsicWidth: 20, intrinsicHeight: 10 }],
      },
      {
        rereadVerifiedPng: async (sha256: string) => {
          externalLog.push(`reread:${sha256}`);
          return f.adapter.readAsset(sha256);
        },
        decodeVerifiedPng: async (verified) => {
          externalLog.push(`decode:${verified.sha256}`);
          await new Promise<void>((resolve) => { releaseExternal = resolve; });
          const handle: Handle = { close: () => {} };
          return { sha256: verified.sha256, mimeType: "image/png", byteLength: verified.byteLength,
            width: 20, height: 10, handle, bytes: verified.bytes };
        },
      },
      f.deps.cache,
    );
    let releaseExternal!: () => void;
    // The coordinator's revision read is observable, so the wait below proves the
    // attempt reached prehydration before the coordination assertion.
    const genuineReadRevision = f.deps.persistence.readRevision.bind(f.deps.persistence);
    let revisionRead = false;
    f.deps.persistence.readRevision = async (documentId: string, revisionId: string) => {
      revisionRead = true;
      return genuineReadRevision(documentId, revisionId);
    };
    const reloaded = f.workspace.reload({ documentId: "doc-1" });
    while (!revisionRead || externalLog.length < 2) await tick();
    // Everything after the revision read is microtask-only, so a short drain
    // deterministically parks the attempt at its suspension point.
    for (let i = 0; i < 10; i++) await tick();
    // Coordination via the original cache: the attempt waits on the external
    // predecessor's tail and has not started its own reread or decode.
    expect(externalLog).toEqual([`reread:${hashA}`, `decode:${hashA}`]);
    expect(f.log).toEqual([]);
    releaseExternal();
    const loaded = await reloaded;
    await external;
    // Strict order proves shared tails: external decoded first, coordinator after.
    expect(f.log).toEqual([`reread:${hashA}`, `decode:${hashA}`]);
    expect(loaded.workspace.images[0]!.sha256).toBe(hashA);
    expect(f.workspace.current).toBe(loaded);
  });

  it("releases through the workspace facade as the primary live path exactly once", async () => {
    const f = fixture();
    await f.seedDraft("rev-1", 1, hashA, bytesA);
    const loaded = await f.workspace.reload({ documentId: "doc-1" });
    const [handle] = f.handles;
    expect(f.workspace.current).toBe(loaded);
    // Primary live release through the facade clears current and disposes once.
    loaded.workspace.release();
    expect(f.workspace.current).toBeNull();
    expect(f.closed).toEqual([handle]);
    // Both paths afterwards are stale no-ops; current stays cleared.
    loaded.release();
    loaded.workspace.release();
    expect(f.closed).toEqual([handle]);
    expect(f.workspace.current).toBeNull();
  });

  it("treats release of the current publication during pending attempts as non-cancellation", async () => {
    const f = fixture();
    await f.seedDraft("rev-1", 1, hashA, bytesA);
    const initial = await f.workspace.reload({ documentId: "doc-1" });
    await f.seedDraft("rev-2", 2, hashA, bytesA);
    let releaseGate!: () => void;
    f.gate(new Promise<void>((resolve) => { releaseGate = resolve; }));
    const reloading = f.workspace.reload({ documentId: "doc-1" });
    // Releasing while an attempt is pending is honest now but never cancellation:
    // the queued attempt still runs and publishes.
    initial.release();
    expect(f.workspace.current).toBeNull();
    expect(f.closed).toEqual([f.handles[0]]);
    releaseGate();
    const loaded = await reloading;
    expect(loaded.revision.revisionId).toBe("rev-2");
    expect(f.workspace.current).toBe(loaded);
    // The released prior stays released; the new current owns its own image lease.
    expect(f.closed).toEqual([f.handles[0]]);
    loaded.release();
    expect(f.workspace.current).toBeNull();
    expect(f.closed).toEqual([f.handles[0], f.handles[1]]);
  });

  it("publishes, reloads, and republishes through real adapter state, sharing handle lifetime", async () => {
    const f = fixture();
    await f.adapter.writeAsset({ mimeType: "image/png", bytes: bytesA });
    const published = await f.workspace.publish(publishInput("draft-1", 1, hashA));
    expect(f.workspace.current).toBe(published);
    expect(published.revision).toMatchObject({ documentId: "doc-1", revisionId: "draft-1", sequence: 1 });
    expect(published.workspace.images[0]!.sha256).toBe(hashA);
    expect((await f.adapter.readPointers("doc-1")).draft)
      .toMatchObject({ revisionId: "draft-1", sequence: 1 });
    // A later reload replaces the published prior and releases its lease.
    await f.seedDraft("rev-2", 2, hashB, bytesB, approvalHash);
    const reloaded = await f.workspace.reload({ documentId: "doc-1" });
    expect(reloaded.revision.revisionId).toBe("rev-2");
    expect(f.workspace.current).toBe(reloaded);
    expect(f.closed).toEqual([f.handles[0]]);
    // Republishing through the same workspace replaces the reload prior: the
    // seeded approval linkage carries forward and the duplicate decode of the
    // established image is discarded while the shared handle stays open.
    await f.adapter.writeAsset({ mimeType: "image/png", bytes: bytesB });
    const republished = await f.workspace.publish(publishInput("draft-3", 3, hashB));
    expect(f.workspace.current).toBe(republished);
    expect(republished.revision.revisionId).toBe("draft-3");
    expect((await f.adapter.readPointers("doc-1")).draft)
      .toMatchObject({ revisionId: "draft-3", sequence: 3, parentApprovalHash: approvalHash });
    expect(f.closed).toEqual([f.handles[0], f.handles[2]]);
    expect(republished.workspace.images[0]!.handle).toBe(reloaded.workspace.images[0]!.handle);
  });

  it("carries approval linkage through multiple publish replacements", async () => {
    const f = fixture();
    await f.seedDraft("rev-1", 1, hashA, bytesA, approvalHash);
    await f.workspace.reload({ documentId: "doc-1" });
    const first = await f.workspace.publish(publishInput("draft-2", 2, hashA));
    expect((await f.adapter.readPointers("doc-1")).draft)
      .toMatchObject({ revisionId: "draft-2", parentApprovalHash: approvalHash });
    const second = await f.workspace.publish(publishInput("draft-3", 3, hashA));
    expect(f.workspace.current).toBe(second);
    expect((await f.adapter.readPointers("doc-1")).draft)
      .toMatchObject({ revisionId: "draft-3", parentApprovalHash: approvalHash });
    // Each replacement discarded its duplicate decode; the superseded releases
    // decrement shared lease counts, so the established handle stays open.
    expect(f.closed).toEqual([f.handles[1], f.handles[2]]);
    second.release();
    expect(f.closed).toHaveLength(f.handles.length);
    expect(f.handles.every((closedHandle) => f.closed.includes(closedHandle))).toBe(true);
    first.release();
    expect(f.closed).toHaveLength(f.handles.length);
  });

  it("returns the same facade for an exact retry without decoding or writing", async () => {
    const f = fixture();
    await f.adapter.writeAsset({ mimeType: "image/png", bytes: bytesA });
    let writes = 0;
    const genuineWrite = f.deps.persistence.writeCompleteRevisionIfPointersMatch
      .bind(f.deps.persistence);
    f.deps.persistence.writeCompleteRevisionIfPointersMatch =
      async (...args: Parameters<typeof genuineWrite>) => {
        writes += 1;
        return genuineWrite(...args);
      };
    const published = await f.workspace.publish(publishInput("draft-1", 1, hashA));
    expect(writes).toBe(1);
    const retry = await f.workspace.publish(publishInput("draft-1", 1, hashA));
    expect(retry).toBe(published);
    expect(f.workspace.current).toBe(published);
    expect(writes).toBe(1);
    expect(f.log.filter((entry) => entry.startsWith("decode:"))).toHaveLength(1);
    published.release();
    expect(f.workspace.current).toBeNull();
  });

  it("preserves the previous publication when decoding or CAS fails, closing only new resources", async () => {
    const f = fixture();
    await f.adapter.writeAsset({ mimeType: "image/png", bytes: bytesA });
    const published = await f.workspace.publish(publishInput("draft-1", 1, hashA));
    const [publishedHandle] = f.handles;
    // A controlled decode failure leaves the previous publication and its lease intact.
    await f.adapter.writeAsset({ mimeType: "image/png", bytes: bytesB });
    f.failDecode(hashB);
    await expect(f.workspace.publish(publishInput("draft-2", 2, hashB)))
      .rejects.toThrow("EDITOR_CANONICAL_PREHYDRATION_FAILED");
    expect(f.workspace.current).toBe(published);
    expect(f.closed).toEqual([]);
    f.failDecode(null);
    // A CAS race fails the conditional write: only the new attempt's handle closes.
    let releaseGate!: () => void;
    f.gate(new Promise<void>((resolve) => { releaseGate = resolve; }));
    const pending = f.workspace.publish(publishInput("draft-2", 2, hashB));
    await f.seedDraft("rival", 9, hashA, bytesA);
    releaseGate();
    await expect(pending).rejects.toThrow("EDITOR_CANONICAL_DRAFT_WRITE_FAILED");
    expect(f.workspace.current).toBe(published);
    expect(f.closed).toEqual([f.handles[1]]);
    expect(f.closed).not.toContain(publishedHandle);
    published.release();
    expect(f.closed).toHaveLength(f.handles.length);
    expect(f.handles.every((closedHandle) => f.closed.includes(closedHandle))).toBe(true);
  });

  it("serializes reloads and publishes through one queue and recovers from a failed attempt", async () => {
    const f = fixture();
    await f.adapter.writeAsset({ mimeType: "image/png", bytes: bytesA });
    await f.workspace.publish(publishInput("draft-1", 1, hashA));
    let releaseGate!: () => void;
    f.gate(new Promise<void>((resolve) => { releaseGate = resolve; }));
    const reloading = f.workspace.reload({ documentId: "doc-1" });
    const publishing = f.workspace.publish(publishInput("draft-2", 2, hashA));
    // The blocked reload parks the whole queue: no publish work has started.
    expect(f.log.filter((entry) => entry.startsWith("decode:"))).toHaveLength(1);
    releaseGate();
    const reloaded = await reloading;
    const republished = await publishing;
    expect(reloaded.revision.revisionId).toBe("draft-1");
    expect(republished.revision.revisionId).toBe("draft-2");
    // Strict order proves one shared queue: initial, reload, then publish.
    expect(f.log.slice(0, 6)).toEqual([
      `reread:${hashA}`, `decode:${hashA}`,
      `reread:${hashA}`, `decode:${hashA}`,
      `reread:${hashA}`, `decode:${hashA}`,
    ]);
    expect(f.workspace.current).toBe(republished);
    // A failed attempt does not poison the queue: the next attempt still runs.
    await expect(f.workspace.publish({ ...publishInput("draft-3", 3, hashA), editableJson: "{" }))
      .rejects.toThrow("SCENE_DOCUMENT_IMPORT_INVALID_JSON");
    const recovered = await f.workspace.reload({ documentId: "doc-1" });
    expect(recovered.revision.revisionId).toBe("draft-2");
    expect(f.workspace.current).toBe(recovered);
    expect(f.log).toHaveLength(8);
  });

  it("publishes a committed replacement when current is released during a pending write", async () => {
    const f = fixture();
    await f.adapter.writeAsset({ mimeType: "image/png", bytes: bytesA });
    const initial = await f.workspace.publish(publishInput("draft-1", 1, hashA));
    await f.adapter.writeAsset({ mimeType: "image/png", bytes: bytesB });
    let finishWrite!: () => void;
    const genuineWrite = f.deps.persistence.writeCompleteRevisionIfPointersMatch
      .bind(f.deps.persistence);
    f.deps.persistence.writeCompleteRevisionIfPointersMatch =
      async (...args: Parameters<typeof genuineWrite>) => {
        await new Promise<void>((resolve) => { finishWrite = resolve; });
        return genuineWrite(...args);
      };
    const publishing = f.workspace.publish(publishInput("draft-2", 2, hashB));
    await vi.waitFor(() => expect(finishWrite).toBeDefined());
    // Releasing current during the pending write is never cancellation: the
    // committed replacement still publishes and becomes current.
    initial.release();
    expect(f.workspace.current).toBeNull();
    expect(f.closed).toEqual([f.handles[0]]);
    finishWrite();
    const published = await publishing;
    expect(published.revision.revisionId).toBe("draft-2");
    expect(f.workspace.current).toBe(published);
    expect(f.closed).toEqual([f.handles[0]]);
    published.release();
    expect(f.closed).toEqual(f.handles);
  });

  it("keeps pre-queued snapshots of publish inputs and methods, recapturing for later calls", async () => {
    const f = fixture();
    await f.adapter.writeAsset({ mimeType: "image/png", bytes: bytesA });
    let releaseGate!: () => void;
    f.gate(new Promise<void>((resolve) => { releaseGate = resolve; }));
    const input = { ...publishInput("draft-1", 1, hashA) };
    const genuineReread = f.deps.prehydration.rereadVerifiedPng;
    const pending = f.workspace.publish(input);
    // Same-object mutations after queueing cannot reach the pending attempt.
    input.documentId = "doc-2";
    input.editableJson = JSON.stringify(imageDocument(hashB));
    input.revisionId = () => "redirected";
    input.sequence = 99;
    input.createdAt = () => 999;
    f.deps.prehydration.rereadVerifiedPng = async () => { throw new Error("mutated reread used"); };
    const genuineReadPointers = f.deps.persistence.readPointers;
    f.deps.persistence.readPointers = async () => { throw new Error("mutated read used"); };
    const genuineAdopt = f.deps.cache.adoptStaged;
    f.deps.cache.adoptStaged = () => { throw new Error("mutated cache used"); };
    releaseGate();
    const published = await pending;
    expect(published.revision).toMatchObject({ documentId: "doc-1", revisionId: "draft-1", sequence: 1 });
    expect(published.workspace.images[0]!.sha256).toBe(hashA);
    // Later invocations capture their then-current methods (no forever binding).
    f.deps.prehydration.rereadVerifiedPng = genuineReread;
    f.deps.persistence.readPointers = genuineReadPointers;
    f.deps.cache.adoptStaged = genuineAdopt;
    let rereads = 0;
    const restoredReread = f.deps.prehydration.rereadVerifiedPng;
    f.deps.prehydration.rereadVerifiedPng = async (sha256: string) => {
      rereads += 1;
      return restoredReread(sha256);
    };
    const again = await f.workspace.publish({ ...publishInput("draft-2", 2, hashA) });
    expect(again.revision.revisionId).toBe("draft-2");
    expect(rereads).toBe(1);
  });

  it("keeps read-only dependency consumers and readonly publish input types compatible", () => {
    const f = fixture();
    const readOnly: DurableDraftWorkspaceDependencies = {
      persistence: f.deps.persistence,
      prehydration: f.deps.prehydration,
      cache: f.deps.cache,
    };
    const readWorkspace = createDurableDraftWorkspace(readOnly);
    expect(readWorkspace.current).toBeNull();
    const writeDeps: DurableDraftWriteWorkspaceDependencies = f.deps;
    expect(writeDeps.persistence.readPointers).toBeTypeOf("function");
    const input: Readonly<DurableDraftPublishInput> = {
      documentId: "doc-1", editableJson: "{}", revisionId: () => "draft-x",
      sequence: 1, createdAt: () => 0,
    };
    expect(input.documentId).toBe("doc-1");
    const publish: (options: DurableDraftPublishInput) => Promise<DurableDraftPublication> =
      f.workspace.publish;
    expect(typeof publish).toBe("function");
  });

  it.each(["prototype", "non-enumerable"] as const)(
    "publishes %s-declared input fields that a spread would drop", async (kind) => {
      const f = fixture();
      await f.adapter.writeAsset({ mimeType: "image/png", bytes: bytesA });
      const values = publishInput("draft-1", 1, hashA) as Record<string, unknown>;
      const input = {} as DurableDraftPublishInput;
      if (kind === "prototype") Object.setPrototypeOf(input, values);
      else {
        for (const [key, value] of Object.entries(values)) {
          Object.defineProperty(input, key, { value, configurable: true });
        }
      }
      const published = await f.workspace.publish(input);
      expect(published.revision).toMatchObject({
        documentId: "doc-1", revisionId: "draft-1", sequence: 1 });
      expect(published.workspace.images[0]!.sha256).toBe(hashA);
    },
  );

  it("sanitizes a throwing prototype getter before the publish attempt queues", async () => {
    const f = fixture();
    const throwing = { get documentId() { throw new Error("getter failed"); } };
    const input = Object.create(throwing) as DurableDraftPublishInput;
    await expect(f.workspace.publish(input)).rejects.toThrow("EDITOR_DURABLE_DRAFT_WORKSPACE_FAILED");
  });
});
