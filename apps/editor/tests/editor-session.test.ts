import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import {
  canonicalizeSceneDocument, FIRST_SLICE_DOCUMENT, type SceneDocumentV1,
} from "@particle-studio/scene-document";
import {
  createIndexedDbPersistenceAdapter, deleteIndexedDbPersistenceDatabase,
} from "@particle-studio/persistence-indexeddb";
import { createEditorSession, type EditorSessionDependencies } from "../src/editor-session.js";

const bytes = new Uint8Array([1, 2, 3]);
const sha256 = async (input: Uint8Array): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input.slice().buffer));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};
const documentAt = (value: number): SceneDocumentV1 => {
  const document = structuredClone(FIRST_SLICE_DOCUMENT) as SceneDocumentV1;
  document.tracks[0]!.keyframes[0]!.value = value;
  return document;
};
const request = (tool: string, input: unknown = {}) => ({
  schemaVersion: 1, requestId: "request-1", tool: `particle_studio.${tool}`, input,
});
const response = (result: unknown) => ({ schemaVersion: 1, requestId: "request-1", result });
const command = (value: number, expectedRevision = 0) => ({
  commandSchemaVersion: 1, commandId: `edit-${expectedRevision}-${value}`,
  documentId: "document-1", expectedRevision,
  payload: {
    type: "set-keyframe-value", trackId: "shape-1:opacity",
    keyframeId: "shape-1:opacity:0", value,
  },
});
const initFailure = { ok: false, error: { code: "EDITOR_DURABLE_EDITING_INIT_FAILED" } };
const cleanups: (() => Promise<void>)[] = [];

function fixture() {
  const databaseName = `editor-session-${Date.now()}-${Math.random()}`;
  const persistence = createIndexedDbPersistenceAdapter({ databaseName });
  const readPointers = vi.spyOn(persistence, "readPointers");
  const readRevision = vi.spyOn(persistence, "readRevision");
  const writeRevision = vi.spyOn(persistence, "writeCompleteRevisionIfPointersMatch");
  const readAsset = vi.spyOn(persistence, "readAsset");
  const writeAsset = vi.spyOn(persistence, "writeAsset");
  const handles: { close: ReturnType<typeof vi.fn> }[] = [];
  const decodePng = vi.fn((input: Uint8Array) => {
    expect(input).toEqual(bytes);
    const handle = { close: vi.fn() };
    handles.push(handle);
    return { width: 20, height: 10, handle };
  });
  let identity = 0;
  const deps = {
    persistence, documentId: "document-1", sha256: vi.fn(sha256), decodePng,
    revisionId: vi.fn(() => `revision-${++identity}`), createdAt: vi.fn(() => 1234),
    commandId: vi.fn(() => "image-command"),
    elementIdSource: vi.fn(() => ({ kind: "id" as const, id: "image-1" })),
    geometry: vi.fn(() => ({ x: 5, y: 6, width: 30, height: 20, opacity: 1 })),
  };
  const reads: string[] = [];
  const options = Object.create(null) as EditorSessionDependencies;
  for (const key of Object.keys(deps) as (keyof typeof deps)[]) {
    Object.defineProperty(options, key, { get() { reads.push(key); return deps[key]; } });
  }
  const session = createEditorSession(options);
  const start = () => {
    const result = session.createAgent();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    return result.adapter;
  };
  const importJson = (document = documentAt(0.4)) => session.importWorkflow({
    kind: "editable-json-import", editableJson: JSON.stringify(document),
  });
  cleanups.push(async () => {
    session.workspace.current?.release();
    session.cache.clear();
    await deleteIndexedDbPersistenceDatabase(databaseName);
  });
  return {
    session, persistence, deps, reads, handles, decodePng, start, importJson,
    readPointers, readRevision, writeRevision, readAsset, writeAsset,
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

async function expectDurable(
  f: ReturnType<typeof fixture>, revisionId: string, sequence: number, document: SceneDocumentV1,
) {
  const expected = { documentId: "document-1", revisionId, sequence, document };
  expect(f.session.workspace.current?.revision).toMatchObject(expected);
  expect(f.session.workspace.current?.workspace.plan.canonicalEditableJson).toBe(
    new TextDecoder().decode(canonicalizeSceneDocument.exportEditableJson(document)),
  );
  expect(await f.persistence.readRevision("document-1", revisionId)).toMatchObject(expected);
  expect(await f.persistence.readPointers("document-1")).toEqual({
    saved: null, draft: { kind: "draft", documentId: "document-1", revisionId, sequence },
  });
}

async function expectSummary(
  adapter: ReturnType<ReturnType<typeof fixture>["start"]>, revision: number, elementCount = 1,
) {
  await expect(adapter.execute(request("get_draft_summary"))).resolves.toEqual(response({
    ok: true, summary: {
      documentId: "document-1", revision, schemaVersion: 1, durationUs: 1_000_000,
      playbackRange: { startUs: 0, endUs: 1_000_000 }, loop: true, elementCount, trackCount: 1,
    },
  }));
}

it("captures declared dependencies once without I/O or implicit initialization", async () => {
  const f = fixture();
  expect(f.reads).toEqual(Object.keys(f.deps));
  expect(Object.isFrozen(f.session)).toBe(true);
  expect(f.session.workspace.current).toBeNull();
  expect(f.session.createAgent()).toEqual(initFailure);
  await expect(f.session.importWorkflow({
    kind: "image-import", file: new File([bytes], "particles.png", { type: "image/png" }),
  })).rejects.toThrow("EDITOR_IMAGE_IMPORT_SOURCE_UNAVAILABLE");
  for (const spy of [f.readPointers, f.readRevision, f.writeRevision, f.readAsset, f.writeAsset,
    ...Object.values(f.deps).filter((value) => typeof value === "function")]) {
    expect(spy).not.toHaveBeenCalled();
  }
  expect(f.reads).toEqual(Object.keys(f.deps));
});

it("rejects an actually reloaded foreign current without adopting or modifying it", async () => {
  const f = fixture();
  await f.importJson();
  f.session.workspace.current!.release();
  await f.session.workspace.publish({
    documentId: "foreign", editableJson: JSON.stringify(documentAt(0.8)),
    revisionId: () => "foreign-revision", sequence: 1, createdAt: () => 1234,
  });
  f.session.workspace.current!.release();
  const foreign = await f.session.workspace.reload({ documentId: "foreign" });
  const reads = f.readPointers.mock.calls.length;
  const writes = f.writeRevision.mock.calls.length;
  expect(f.session.createAgent()).toEqual(initFailure);
  expect(f.session.workspace.current).toBe(foreign);
  expect(f.readPointers).toHaveBeenCalledTimes(reads);
  expect(f.writeRevision).toHaveBeenCalledTimes(writes);
  expect(foreign.revision.document).toEqual(documentAt(0.8));
  expect(await f.persistence.readPointers("foreign")).toEqual({
    saved: null, draft: {
      kind: "draft", documentId: "foreign", revisionId: "foreign-revision", sequence: 1,
    },
  });
});

it("imports directly through the real durable cache producer and owns its decoded handle", async () => {
  const f = fixture();
  const hash = await sha256(bytes);
  const image = await f.session.cache.importPng({ mimeType: "image/png", bytes });
  const reference = { sha256: hash, mimeType: "image/png" as const, byteLength: 3, width: 20, height: 10 };
  expect(image).toEqual({ ...reference, handle: f.handles[0] });
  expect(f.writeAsset).toHaveBeenCalledTimes(1);
  expect(f.readAsset).toHaveBeenCalledWith(hash);
  expect(f.deps.sha256).toHaveBeenCalledWith(bytes);
  expect(f.decodePng).toHaveBeenCalledExactlyOnceWith(bytes);
  const asset = (await f.persistence.readAsset(hash))!;
  expect({ ...asset, bytes: asset.bytes }).toEqual({
    sha256: hash, mimeType: "image/png", byteLength: 3, bytes,
  });
  expect(f.session.cache.resolveImage(reference)).toEqual(image);
  expect(f.session.cache.resolveImage(reference)?.handle).toBe(image.handle);
  expect(f.handles[0]!.close).not.toHaveBeenCalled();
  f.session.cache.clear();
  f.session.cache.clear();
  expect(f.session.cache.resolveImage(reference)).toBeNull();
  expect(f.handles[0]!.close).toHaveBeenCalledTimes(1);
});

it("composes JSON, editing, PNG, stale rejection, explicit new agents and warm reload", async () => {
  const f = fixture();
  // Changing caller-owned options after construction must not retarget any route.
  for (const key of Object.keys(f.deps)) {
    Object.defineProperty(f.deps, key, { value: () => { throw new Error("retargeted"); } });
  }
  await expect(f.importJson()).resolves.toBeUndefined();
  await expectDurable(f, "revision-1", 1, documentAt(0.4));
  const old = f.start();
  await expectSummary(old, 0);
  await expect(old.execute(request("dispatch_draft_command", { command: command(0.6) })))
    .resolves.toEqual(response({ ok: true, revision: 1, document: documentAt(0.6) }));
  await expectDurable(f, "revision-2", 2, documentAt(0.6));
  const hash = await sha256(bytes);
  const expected = documentAt(0.6);
  expected.rootIds.push("image-1");
  expected.elements.push({
    id: "image-1", type: "image", x: 5, y: 6, width: 30, height: 20, opacity: 1,
    asset: {
      sha256: hash, mimeType: "image/png", byteLength: 3, intrinsicWidth: 20, intrinsicHeight: 10,
    },
  });
  await expect(f.session.importWorkflow({
    kind: "image-import", file: new File([bytes], "particles.png", { type: "image/png" }),
  })).resolves.toBeUndefined();
  await expectDurable(f, "revision-3", 3, expected);
  const asset = (await f.persistence.readAsset(hash))!;
  expect({ ...asset, bytes: asset.bytes }).toEqual({
    sha256: hash, mimeType: "image/png", byteLength: 3, bytes,
  });
  const current = f.session.workspace.current!;
  const active = current.workspace.images[0]!;
  expect(active).toMatchObject({ sha256: hash, byteLength: 3, width: 20, height: 10 });
  const owned = f.handles.find((handle) => handle === active.handle)!;
  expect(owned).toBeDefined();
  expect(owned.close).not.toHaveBeenCalled();
  const writes = f.writeRevision.mock.calls.length;
  await expect(old.execute(request("dispatch_draft_command", { command: command(0.9, 1) })))
    .resolves.toEqual(response({ ok: false, error: { code: "DURABLE_PUBLISH_FAILED" } }));
  expect(f.writeRevision).toHaveBeenCalledTimes(writes);
  expect(await f.persistence.readRevision("document-1", "revision-4")).toBeNull();
  expect(f.session.workspace.current).toBe(current);
  await expectDurable(f, "revision-3", 3, expected);
  await expectSummary(old, 1);
  const fresh = f.start();
  await expectSummary(fresh, 0, 2);
  const editedImageDocument = structuredClone(expected);
  editedImageDocument.tracks[0]!.keyframes[0]!.value = 0.7;
  await expect(fresh.execute(request("dispatch_draft_command", { command: command(0.7) })))
    .resolves.toEqual(response({ ok: true, revision: 1, document: editedImageDocument }));
  await expectDurable(f, "revision-4", 4, editedImageDocument);
  expect(f.session.workspace.current!.workspace.images[0]!.handle).toBe(active.handle);
  expect(owned.close).not.toHaveBeenCalled();
  const publishedWrites = f.writeRevision.mock.calls.length;
  const reloaded = await f.session.reload();
  expect(f.writeRevision).toHaveBeenCalledTimes(publishedWrites);
  expect(reloaded).toBe(f.session.workspace.current);
  await expectDurable(f, "revision-4", 4, editedImageDocument);
  await expectSummary(f.start(), 0, 2);
  await expect(f.start().execute(request("validate_draft", { document: editedImageDocument })))
    .resolves.toEqual(response({ ok: true, value: editedImageDocument }));
  const recoveredAsset = (await f.persistence.readAsset(hash))!;
  expect({ ...recoveredAsset, bytes: recoveredAsset.bytes }).toEqual({
    sha256: hash, mimeType: "image/png", byteLength: 3, bytes,
  });
  expect(reloaded.workspace.images[0]!.handle).toBe(active.handle);
  expect(owned.close).not.toHaveBeenCalled();
  expect(f.session.cache.resolveImage(active)?.handle).toBe(active.handle);
  expect(f.reads).toHaveLength(Object.keys(f.deps).length);
  reloaded.release();
  reloaded.release();
  expect(f.session.workspace.current).toBeNull();
  expect(f.session.createAgent()).toEqual(initFailure);
  f.session.cache.clear();
  f.session.cache.clear();
  for (const handle of f.handles) expect(handle.close).toHaveBeenCalledTimes(1);
});
