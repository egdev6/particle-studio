import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { FIRST_SLICE_DOCUMENT } from "@particle-studio/scene-document";
import {
  createCompleteRevision, createDraftRevisionPointer, createRevisionPointersSnapshot,
} from "@particle-studio/persistence";
import {
  createIndexedDbPersistenceAdapter, deleteIndexedDbPersistenceDatabase,
} from "@particle-studio/persistence-indexeddb";
import { createPngImageCache } from "../src/png-image-cache.js";
import { createDurableDraftWorkspace } from "../src/durable-draft-workspace.js";
import { createEditorImageImportWorkflow } from "../src/editor-image-import-workflow.js";
import type {
  EditorImageImportWorkflowDependencies,
} from "../src/editor-image-import-workflow.js";

const bytesA = new Uint8Array([1, 2, 3]);

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer),
  );
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

const pngFile = (bytes: Uint8Array = bytesA, type = "image/png"): File =>
  new File([new Uint8Array(bytes)], "particles.png", { type });

type Handle = { close(): void };
const mutable = <T,>(value: T): { -readonly [K in keyof T]: T[K] } =>
  value as never;

const databases: string[] = [];
afterEach(async () => {
  while (databases.length > 0) {
    await deleteIndexedDbPersistenceDatabase(databases.pop()!);
  }
});

async function setup() {
  const databaseName = `editor-image-import-${Date.now()}-${Math.random()}`;
  databases.push(databaseName);
  const adapter = createIndexedDbPersistenceAdapter({ databaseName });
  const handles: Handle[] = [];
  const closed: Handle[] = [];
  let writeGate: Promise<void> | null = null;
  let decodeGate: Promise<void> | null = null;
  let failWrite = false;
  const written: string[] = [];
  const assets = {
    writeAsset: async (input: { readonly mimeType: string; readonly bytes: Uint8Array }) => {
      written.push(input.mimeType);
      if (writeGate) await writeGate;
      return adapter.writeAsset(input);
    },
    readAsset: (sha: string) => adapter.readAsset(sha),
  };
  const decodePng = async (bytes: Uint8Array) => {
    if (decodeGate) await decodeGate;
    const handle: Handle = { close: () => { closed.push(handle); } };
    handles.push(handle);
    return { width: 20, height: 10, handle, bytes };
  };
  const decodeVerifiedPng = async (verified: {
    readonly sha256: string;
    readonly byteLength: number;
    readonly bytes: Uint8Array;
  }) => {
    const handle: Handle = { close: () => { closed.push(handle); } };
    handles.push(handle);
    return {
      sha256: verified.sha256,
      mimeType: "image/png",
      byteLength: verified.byteLength,
      width: 20,
      height: 10,
      handle,
      bytes: verified.bytes,
    };
  };
  const realWrite = adapter.writeCompleteRevisionIfPointersMatch.bind(adapter);
  const persistence = {
    ...adapter,
    writeCompleteRevisionIfPointersMatch: async (
      ...args: Parameters<typeof realWrite>
    ) => {
      if (failWrite) throw new Error("controlled write failure");
      return realWrite(...args);
    },
  };
  const cache = createPngImageCache({
    importVerifiedPng: async (input) => ({
      sha256: await sha256(input.bytes), mimeType: "image/png",
      byteLength: input.bytes.byteLength, bytes: input.bytes.slice(),
    }),
    decodeVerifiedPng: async (verified) => {
      const handle: Handle = { close: () => { closed.push(handle); } };
      handles.push(handle);
      return {
        sha256: verified.sha256,
        mimeType: "image/png" as const,
        byteLength: verified.byteLength,
        width: 20,
        height: 10,
        handle,
        bytes: verified.bytes,
      };
    },
  });
  const workspace = createDurableDraftWorkspace({
    persistence, cache,
    prehydration: {
      rereadVerifiedPng: (sha) => adapter.readAsset(sha),
      decodeVerifiedPng,
    },
  });
  await workspace.publish({
    documentId: "doc-1", editableJson: JSON.stringify(FIRST_SLICE_DOCUMENT),
    revisionId: () => "base-rev", sequence: 1, createdAt: () => 1000,
  });
  // A live mutable geometry source: the workflow must snapshot it pre-await.
  const geometry = { x: 5, y: 6, width: 30, height: 20, opacity: 1 };
  const deps: EditorImageImportWorkflowDependencies = {
    workspace, assets, sha256, decodePng, cache,
    elementIdSource: () => ({ kind: "id", id: "image-1" }),
    commandId: () => "cmd-1",
    geometry: () => geometry,
    revisionId: () => "rev-2",
    sequence: () => 2,
    createdAt: () => 2000,
  };
  const workflow = createEditorImageImportWorkflow(deps);
  return {
    adapter, workspace, deps, workflow, geometry, cache, handles, closed, written,
    setWriteGate: (gate: Promise<void> | null) => { writeGate = gate; },
    setDecodeGate: (gate: Promise<void> | null) => { decodeGate = gate; },
    failWriteNow: () => { failWrite = true; },
    seedDoc2: async () => {
      const revision = createCompleteRevision({
        documentId: "doc-2", revisionId: "doc2-rev", sequence: 1,
        document: FIRST_SLICE_DOCUMENT,
      });
      await adapter.writeCompleteRevision(revision, createRevisionPointersSnapshot({
        saved: null, draft: createDraftRevisionPointer(revision),
      }));
    },
  };
}

const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

describe("editor image import workflow (real cache, workspace, and persistence)", () => {
  it("rejects a missing current before any import work", async () => {
    const f = await setup();
    f.workspace.current!.release();
    let geometryReads = 0;
    mutable(f.deps).geometry = () => {
      geometryReads += 1;
      return { x: 0, y: 0, width: 1, height: 1, opacity: 1 };
    };
    await expect(f.workflow({ kind: "image-import", file: pngFile() }))
      .rejects.toThrow("EDITOR_IMAGE_IMPORT_SOURCE_UNAVAILABLE");
    expect(geometryReads).toBe(0);
    expect(f.handles).toEqual([]);
    expect(f.written).toEqual([]);
    expect(f.workspace.current).toBeNull();
  });

  it("publishes a bound replacement preserving source settings, hierarchy, and tracks", async () => {
    const f = await setup();
    const hash = await sha256(bytesA);
    const result = await f.workflow({ kind: "image-import", file: pngFile() });
    expect(result).toBeUndefined();
    const current = f.workspace.current!;
    expect(current.revision).toMatchObject({
      documentId: "doc-1", revisionId: "rev-2", sequence: 2,
    });
    const document = current.revision.document;
    expect(document.durationUs).toBe(1_000_000);
    expect(document.loop).toBe(true);
    expect(document.seed).toBe(42);
    expect(document.playbackRange).toEqual({ startUs: 0, endUs: 1_000_000 });
    expect(document.rootIds).toEqual(["shape-1", "image-1"]);
    expect(document.elements[0]).toMatchObject({
      id: "shape-1", type: "shape", x: 16, y: 24, width: 120, height: 80,
    });
    expect(document.tracks).toHaveLength(1);
    expect(document.tracks[0]).toMatchObject({ elementId: "shape-1", property: "opacity" });
    expect(document.tracks[0]!.keyframes).toHaveLength(2);
    expect(document.elements[1]).toEqual({
      id: "image-1", type: "image", x: 5, y: 6, width: 30, height: 20, opacity: 1,
      asset: {
        sha256: hash, mimeType: "image/png", byteLength: 3,
        intrinsicWidth: 20, intrinsicHeight: 10,
      },
    });
    const pointers = await f.adapter.readPointers("doc-1");
    expect(pointers.draft).toMatchObject({ revisionId: "rev-2", sequence: 2 });
  });

  it("keeps the owned handle alive for the publication and closes it on release", async () => {
    const f = await setup();
    await f.workflow({ kind: "image-import", file: pngFile() });
    const ownHandle = f.handles[0]!;
    const image = f.workspace.current!.workspace.images[0]!;
    expect(image).toMatchObject({
      mimeType: "image/png", byteLength: 3, width: 20, height: 10,
    });
    expect(image.handle).toBe(ownHandle);
    expect(f.closed).not.toContain(ownHandle);
    f.workspace.current!.release();
    expect(f.workspace.current).toBeNull();
    expect(f.closed).toContain(ownHandle);
  });

  it("propagates the real integrity failure for a non-PNG file without staging", async () => {
    const f = await setup();
    await expect(f.workflow({ kind: "image-import", file: pngFile(bytesA, "image/jpeg") }))
      .rejects.toThrow("EDITOR_PNG_MIME_TYPE_INVALID");
    expect(f.handles).toEqual([]);
    expect(f.workspace.current!.revision.revisionId).toBe("base-rev");
  });

  it("propagates an actual command-session rejection and cleans up staging", async () => {
    const f = await setup();
    mutable(f.deps).elementIdSource = () => ({ kind: "unavailable" });
    await expect(f.workflow({ kind: "image-import", file: pngFile() }))
      .rejects.toThrow("ID_SOURCE_UNAVAILABLE");
    expect(f.workspace.current!.revision.revisionId).toBe("base-rev");
    expect(f.closed).toContain(f.handles[0]!);
    const pointers = await f.adapter.readPointers("doc-1");
    expect(pointers.draft).toMatchObject({ revisionId: "base-rev", sequence: 1 });
  });

  it("fails a throwing id source before any import work", async () => {
    const f = await setup();
    mutable(f.deps).elementIdSource = () => { throw new Error("threw"); };
    await expect(f.workflow({ kind: "image-import", file: pngFile() }))
      .rejects.toThrow("threw");
    expect(f.handles).toEqual([]);
    expect(f.written).toEqual([]);
    expect(f.workspace.current!.revision.revisionId).toBe("base-rev");
  });

  it("rejects a source released during the gated async without rebasing", async () => {
    const f = await setup();
    let releaseGate!: () => void;
    f.setWriteGate(new Promise<void>((resolve) => { releaseGate = resolve; }));
    const pending = f.workflow({ kind: "image-import", file: pngFile() });
    await tick();
    f.workspace.current!.release();
    releaseGate();
    await expect(pending).rejects.toThrow("EDITOR_DURABLE_DRAFT_SOURCE_MISMATCH");
    expect(f.workspace.current).toBeNull();
    const pointers = await f.adapter.readPointers("doc-1");
    expect(pointers.draft).toMatchObject({ revisionId: "base-rev", sequence: 1 });
    expect(f.closed).toEqual([f.handles[0]!]);
  });

  it("rejects a cross-document current change during the gated async without rebasing", async () => {
    const f = await setup();
    await f.seedDoc2();
    let releaseGate!: () => void;
    f.setWriteGate(new Promise<void>((resolve) => { releaseGate = resolve; }));
    const pending = f.workflow({ kind: "image-import", file: pngFile() });
    await tick();
    await f.workspace.reload({ documentId: "doc-2" });
    releaseGate();
    await expect(pending).rejects.toThrow("EDITOR_DURABLE_DRAFT_SOURCE_MISMATCH");
    expect(f.workspace.current!.revision.documentId).toBe("doc-2");
    const pointers = await f.adapter.readPointers("doc-1");
    expect(pointers.draft).toMatchObject({ revisionId: "base-rev", sequence: 1 });
  });

  it("cleans up staging when the durable write fails and keeps the live publication", async () => {
    const f = await setup();
    f.failWriteNow();
    await expect(f.workflow({ kind: "image-import", file: pngFile() }))
      .rejects.toThrow("EDITOR_CANONICAL_DRAFT_WRITE_FAILED");
    expect(f.workspace.current!.revision.revisionId).toBe("base-rev");
    expect(f.closed).toHaveLength(2);
    expect(f.closed).toContain(f.handles[0]!);
    expect(f.closed).toContain(f.handles[1]!);
    const pointers = await f.adapter.readPointers("doc-1");
    expect(pointers.draft).toMatchObject({ revisionId: "base-rev", sequence: 1 });
  });

  it("pins geometry, command id, sequence, and revision captured before the gated async", async () => {
    const f = await setup();
    let releaseGate!: () => void;
    f.setDecodeGate(new Promise<void>((resolve) => { releaseGate = resolve; }));
    const pending = f.workflow({ kind: "image-import", file: pngFile() });
    await tick();
    f.geometry.x = 999;
    f.geometry.y = 999;
    mutable(f.deps).commandId = () => "cmd-hijack";
    mutable(f.deps).revisionId = () => "hijack";
    mutable(f.deps).sequence = () => 99;
    releaseGate();
    await pending;
    const document = f.workspace.current!.revision.document;
    expect(document.elements[1]).toMatchObject({
      id: "image-1", x: 5, y: 6, width: 30, height: 20, opacity: 1,
    });
    const pointers = await f.adapter.readPointers("doc-1");
    expect(pointers.draft).toMatchObject({ revisionId: "rev-2", sequence: 2 });
  });

  it("pins element id, publication revision, and creation time captured before the gated async", async () => {
    const f = await setup();
    // Mutable closure-backed sources: mid-async mutation must not retarget.
    const idResult = { kind: "id" as const, id: "image-1" };
    const revision = { value: "rev-2" };
    const created = { value: 2000 };
    mutable(f.deps).elementIdSource = () => idResult;
    mutable(f.deps).revisionId = () => revision.value;
    mutable(f.deps).createdAt = () => created.value;
    const publish = f.workspace.publish.bind(f.workspace);
    const observedCreationTimes: number[] = [];
    mutable(f.deps).workspace = {
      get current() { return f.workspace.current; },
      reload: f.workspace.reload.bind(f.workspace),
      publish: async (input) => {
        observedCreationTimes.push(input.createdAt());
        return publish(input);
      },
    };
    let releaseGate!: () => void;
    f.setDecodeGate(new Promise<void>((resolve) => { releaseGate = resolve; }));
    const pending = f.workflow({ kind: "image-import", file: pngFile() });
    await tick();
    idResult.id = "image-hijack";
    revision.value = "hijack-rev";
    created.value = 9999;
    releaseGate();
    await pending;
    expect(f.workspace.current!.revision.document.elements[1])
      .toMatchObject({ id: "image-1" });
    expect(f.workspace.current!.revision.revisionId).toBe("rev-2");
    expect(observedCreationTimes).toEqual([2000]);
    const pointers = await f.adapter.readPointers("doc-1");
    expect(pointers.draft).toMatchObject({ revisionId: "rev-2", sequence: 2 });
  });

  it("disposes a refused candidate without closing a foreign cache's winning handle", async () => {
    const f = await setup();
    let winnerClosed = false;
    const foreign = createPngImageCache({
      importVerifiedPng: async (input) => ({
        sha256: await sha256(input.bytes), mimeType: "image/png",
        byteLength: input.bytes.byteLength, bytes: input.bytes.slice(),
      }),
      decodeVerifiedPng: async (verified) => {
        const handle = { close: () => { winnerClosed = true; } };
        return { sha256: verified.sha256, mimeType: "image/png" as const,
          byteLength: verified.byteLength, width: 20, height: 10, handle,
          bytes: verified.bytes };
      },
    });
    const winner = await foreign.importPng({ mimeType: "image/png", bytes: bytesA.slice() });
    mutable(f.deps).decodePng = async (bytes: Uint8Array) => ({
      width: 20, height: 10, handle: winner.handle, bytes,
    });
    await expect(f.workflow({ kind: "image-import", file: pngFile() }))
      .rejects.toThrow("EDITOR_IMAGE_IMPORT_CACHE_ADOPTION_FAILED");
    expect(winnerClosed).toBe(false);
    expect(foreign.resolveImage(winner)).not.toBeNull();
  });

  it("reuses a persistent prior entry for the same hash without eviction", async () => {
    const f = await setup();
    const prior = await f.cache.importPng({ mimeType: "image/png", bytes: bytesA.slice() });
    await f.workflow({ kind: "image-import", file: pngFile() });
    const image = f.workspace.current!.workspace.images[0]!;
    expect(image.handle).toBe(prior.handle);
    expect(f.cache.resolveImage(prior)).not.toBeNull();
    expect(f.closed).not.toContain(prior.handle);
    // The import's own decoded handle and prehydration's handle are disposed;
    // the persistent winner is neither evicted nor closed.
    expect(f.closed).toContain(f.handles[1]!);
    expect(f.closed).toContain(f.handles[2]!);
  });

  it("resolves concurrent same-hash imports with one success and one stale rejection", async () => {
    const f = await setup();
    let started = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const baseDecode = f.deps.decodePng;
    mutable(f.deps).decodePng = async (bytes: Uint8Array) => {
      started += 1;
      if (started < 2) await gate;
      return baseDecode(bytes);
    };
    const first = f.workflow({ kind: "image-import", file: pngFile() });
    const second = f.workflow({ kind: "image-import", file: pngFile() });
    for (let i = 0; i < 100 && started < 2; i += 1) await tick();
    expect(started).toBe(2);
    releaseGate();
    const results = await Promise.allSettled([first, second]);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason))
      .toContain("EDITOR_DURABLE_DRAFT_SOURCE_MISMATCH");
    const winnerHandle = f.workspace.current!.workspace.images[0]!.handle;
    expect(f.workspace.current!.revision.revisionId).toBe("rev-2");
    expect(f.closed).not.toContain(winnerHandle);
    expect(f.closed).toContain(f.handles[1]!);
  });
});
