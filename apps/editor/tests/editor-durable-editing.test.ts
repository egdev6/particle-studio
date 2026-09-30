import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { FIRST_SLICE_DOCUMENT, type SceneDocumentV1 } from "@particle-studio/scene-document";
import {
  createIndexedDbPersistenceAdapter, deleteIndexedDbPersistenceDatabase,
} from "@particle-studio/persistence-indexeddb";
import { createDurableDraftWorkspace } from "../src/durable-draft-workspace.js";
import { createPngImageCache } from "../src/png-image-cache.js";
import { createEditorDurableEditing } from "../src/editor-durable-editing.js";

const documentAt = (value: number): SceneDocumentV1 => {
  const document = structuredClone(FIRST_SLICE_DOCUMENT) as SceneDocumentV1;
  document.tracks[0]!.keyframes[0]!.value = value;
  return document;
};
const command = (value: number, expectedRevision = 0) => ({
  commandSchemaVersion: 1,
  commandId: `change-${expectedRevision}-${value}`,
  documentId: "document-1",
  expectedRevision,
  actorCapability: "human-ui",
  payload: {
    type: "set-keyframe-value", trackId: "shape-1:opacity",
    keyframeId: "shape-1:opacity:0", value,
  },
});
const publishFailure = { ok: false, error: { code: "DURABLE_PUBLISH_FAILED" } };
const cleanups: (() => Promise<void>)[] = [];

function fixture() {
  const databaseName = `editor-durable-editing-${Date.now()}-${Math.random()}`;
  const adapter = createIndexedDbPersistenceAdapter({ databaseName });
  const unexpectedImage = async (): Promise<never> => { throw new Error("unexpected image work"); };
  const cache = createPngImageCache({
    importVerifiedPng: unexpectedImage, decodeVerifiedPng: unexpectedImage,
  });
  const workspace = createDurableDraftWorkspace({
    persistence: adapter, cache,
    prehydration: { rereadVerifiedPng: unexpectedImage, decodeVerifiedPng: unexpectedImage },
  });
  const publish = (revisionId: string, sequence: number, value: number) => workspace.publish({
    documentId: "document-1", editableJson: JSON.stringify(documentAt(value)),
    revisionId: () => revisionId, sequence, createdAt: () => 1234,
  });
  let identity = 0;
  const revisionId = vi.fn(() => `editing-${++identity}`);
  const createdAt = vi.fn(() => 5678);
  const options = { workspace, revisionId, createdAt };
  const start = () => {
    const result = createEditorDurableEditing(options);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    return result.editing;
  };
  const f = { databaseName, adapter, cache, workspace, publish, start, options, revisionId, createdAt };
  cleanups.push(async () => {
    workspace.current?.release();
    cache.clear();
    await deleteIndexedDbPersistenceDatabase(databaseName);
  });
  return f;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function expectDurable(
  f: ReturnType<typeof fixture>, revisionId: string, sequence: number, value: number,
) {
  const expected = { documentId: "document-1", revisionId, sequence, document: documentAt(value) };
  expect(await f.adapter.readRevision("document-1", revisionId)).toMatchObject(expected);
  expect(await f.adapter.readPointers("document-1")).toEqual({
    saved: null, draft: { kind: "draft", documentId: "document-1", revisionId, sequence },
  });
  expect(f.workspace.current?.revision).toMatchObject(expected);
}

it("bounds missing initialization without implicitly reloading a persisted draft", async () => {
  const f = fixture();
  await f.publish("initial", 40, 0.4);
  f.workspace.current!.release();
  const read = vi.spyOn(f.adapter, "readPointers");
  expect(createEditorDurableEditing(f.options)).toEqual({
    ok: false, error: { code: "EDITOR_DURABLE_EDITING_INIT_FAILED" },
  });
  expect(read).not.toHaveBeenCalled();
  expect(f.workspace.current).toBeNull();
  expect((await f.adapter.readPointers("document-1")).draft?.revisionId).toBe("initial");
  expect(f.revisionId).not.toHaveBeenCalled();
});

it("initializes synchronously from live content and persists dispatch, undo and redo in order", async () => {
  const f = fixture();
  const initial = await f.publish("initial", 40, 0.4);
  const read = vi.spyOn(f.adapter, "readPointers");
  const editing = f.start();
  expect(read).not.toHaveBeenCalled();
  expect(f.workspace.current).toBe(initial);
  expect(editing.snapshot()).toEqual({ revision: 0, document: documentAt(0.4) });

  await expect(editing.dispatch(command(0.6))).resolves.toMatchObject({ ok: true, revision: 1 });
  await expectDurable(f, "editing-1", 41, 0.6);
  expect(editing.snapshot()).toEqual({ revision: 1, document: documentAt(0.6) });
  await expect(editing.undo()).resolves.toMatchObject({ ok: true, revision: 2 });
  await expectDurable(f, "editing-2", 42, 0.4);
  expect(editing.snapshot()).toEqual({ revision: 2, document: documentAt(0.4) });
  await expect(editing.redo()).resolves.toMatchObject({ ok: true, revision: 3 });
  await expectDurable(f, "editing-3", 43, 0.6);
  expect(editing.snapshot()).toEqual({ revision: 3, document: documentAt(0.6) });
  expect(f.revisionId).toHaveBeenCalledTimes(3);
  expect(f.createdAt).toHaveBeenCalledTimes(3);
});

it("rejects stale editing without candidate writes or rebasing history onto external current", async () => {
  const f = fixture();
  await f.publish("initial", 40, 0.4);
  const editing = f.start();
  await editing.dispatch(command(0.6));
  await editing.undo();
  const before = editing.snapshot();
  const newer = await f.publish("external", 70, 0.8);
  const write = vi.spyOn(f.adapter, "writeCompleteRevisionIfPointersMatch");
  await expect(editing.redo()).resolves.toEqual(publishFailure);
  await expect(editing.dispatch(command(0.9, 2))).resolves.toEqual(publishFailure);
  expect(editing.snapshot()).toEqual(before);
  expect(f.workspace.current).toBe(newer);
  await expectDurable(f, "external", 70, 0.8);
  expect(write).not.toHaveBeenCalled();
  expect(await f.adapter.readRevision("document-1", "editing-3")).toBeNull();
  expect(await f.adapter.readRevision("document-1", "editing-4")).toBeNull();
});

it("preserves redo history and source after a precommit failure, then permits new work", async () => {
  const f = fixture();
  await f.publish("initial", 40, 0.4);
  const editing = f.start();
  await editing.dispatch(command(0.6));
  await editing.undo();
  const before = editing.snapshot();
  const current = f.workspace.current;
  const write = vi.spyOn(f.adapter, "writeCompleteRevisionIfPointersMatch")
    .mockRejectedValueOnce(new Error("controlled precommit failure"));
  await expect(editing.redo()).resolves.toEqual(publishFailure);
  expect(write).toHaveBeenCalledTimes(1);
  expect(editing.snapshot()).toEqual(before);
  expect(f.workspace.current).toBe(current);
  await expectDurable(f, "editing-2", 42, 0.4);
  expect(await f.adapter.readRevision("document-1", "editing-3")).toBeNull();
  await expect(editing.redo()).resolves.toMatchObject({ ok: true, revision: 3 });
  await expectDurable(f, "editing-4", 43, 0.6);
  await expect(editing.dispatch(command(0.7, 3))).resolves.toMatchObject({ ok: true, revision: 4 });
  await expectDurable(f, "editing-5", 44, 0.7);
  expect(editing.snapshot()).toEqual({ revision: 4, document: documentAt(0.7) });
});

it("bounds unsuitable initialization without touching the live publication", async () => {
  const f = fixture();
  const initial = await f.publish("initial", 40, 0.4);
  const result = createEditorDurableEditing({ ...f.options, createdAt: undefined as never });
  expect(result).toEqual({ ok: false, error: { code: "EDITOR_DURABLE_EDITING_INIT_FAILED" } });
  expect(f.workspace.current).toBe(initial);
  await expectDurable(f, "initial", 40, 0.4);
});

it("captures callbacks and the command ID source at initialization", async () => {
  const f = fixture();
  await f.publish("initial", 40, 0.4);
  const options = {
    ...f.options, commandElementIdSource: () => ({ kind: "id" as const, id: "added-group" }),
  };
  const result = createEditorDurableEditing(options);
  if (!result.ok) throw new Error(result.error.code);
  options.revisionId = vi.fn(() => "mutated");
  options.createdAt = vi.fn(() => { throw new Error("mutated callback"); });
  options.commandElementIdSource = () => ({ kind: "id", id: "mutated-group" });
  await expect(result.editing.dispatch({
    ...command(0.6), payload: { type: "create-element", element: { type: "group", childrenIds: [] } },
  })).resolves.toMatchObject({ ok: true, revision: 1 });
  const expected = documentAt(0.4);
  expected.rootIds.push("added-group");
  expected.elements.push({ id: "added-group", type: "group", childrenIds: [] });
  expect(result.editing.snapshot()).toEqual({ revision: 1, document: expected });
  expect(await f.adapter.readRevision("document-1", "editing-1"))
    .toMatchObject({ sequence: 41, document: expected });
  expect((await f.adapter.readPointers("document-1")).draft)
    .toMatchObject({ revisionId: "editing-1", sequence: 41 });
  expect(f.workspace.current?.revision).toMatchObject({ revisionId: "editing-1", document: expected });
  expect(f.createdAt).toHaveBeenCalledTimes(1);
});

it("rejects an invalid command without calling persistence or identity callbacks", async () => {
  const f = fixture();
  const initial = await f.publish("initial", 40, 0.4);
  const editing = f.start();
  const before = editing.snapshot();
  const write = vi.spyOn(f.adapter, "writeCompleteRevisionIfPointersMatch");
  await expect(editing.dispatch(command(0.6, 9))).resolves.toEqual({
    ok: false, error: { code: "REVISION_CONFLICT" },
  });
  expect(write).not.toHaveBeenCalled();
  expect(f.revisionId).not.toHaveBeenCalled();
  expect(f.createdAt).not.toHaveBeenCalled();
  expect(editing.snapshot()).toEqual(before);
  expect(f.workspace.current).toBe(initial);
  await expectDurable(f, "initial", 40, 0.4);
});
