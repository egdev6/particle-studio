import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { FIRST_SLICE_DOCUMENT, type SceneDocumentV1 } from "@particle-studio/scene-document";
import {
  createIndexedDbPersistenceAdapter, deleteIndexedDbPersistenceDatabase,
} from "@particle-studio/persistence-indexeddb";
import { createDurableDraftWorkspace } from "../src/durable-draft-workspace.js";
import { createPngImageCache } from "../src/png-image-cache.js";
import {
  createEditorBrowserAgentWorkspace,
} from "../src/editor-browser-agent-workspace.js";
import type { EditorDurableEditingOptions } from "../src/editor-durable-editing.js";

const documentAt = (value: number): SceneDocumentV1 => {
  const document = structuredClone(FIRST_SLICE_DOCUMENT) as SceneDocumentV1;
  document.tracks[0]!.keyframes[0]!.value = value;
  return document;
};
const command = (value: number, expectedRevision = 0) => ({
  commandSchemaVersion: 1, commandId: `change-${expectedRevision}-${value}`,
  documentId: "document-1", expectedRevision,
  payload: {
    type: "set-keyframe-value", trackId: "shape-1:opacity",
    keyframeId: "shape-1:opacity:0", value,
  },
});
const request = (tool: string, input: unknown = {}) => ({
  schemaVersion: 1, requestId: "request-1", tool: `particle_studio.${tool}`, input,
});
const response = (result: unknown) => ({ schemaVersion: 1, requestId: "request-1", result });
const domainError = (code: string) => response({ ok: false, error: { code } });
const initFailure = { ok: false, error: { code: "EDITOR_DURABLE_EDITING_INIT_FAILED" } };
const cleanups: (() => Promise<void>)[] = [];

function fixture() {
  const databaseName = `editor-browser-agent-${Date.now()}-${Math.random()}`;
  const persistence = createIndexedDbPersistenceAdapter({ databaseName });
  const unexpectedImage = async (): Promise<never> => { throw new Error("unexpected image work"); };
  const cache = createPngImageCache({
    importVerifiedPng: unexpectedImage, decodeVerifiedPng: unexpectedImage,
  });
  const workspace = createDurableDraftWorkspace({
    persistence, cache,
    prehydration: { rereadVerifiedPng: unexpectedImage, decodeVerifiedPng: unexpectedImage },
  });
  const publish = (revisionId: string, sequence: number, value: number, document = documentAt(value)) => workspace.publish({
    documentId: "document-1", editableJson: JSON.stringify(document),
    revisionId: () => revisionId, sequence, createdAt: () => 1234,
  });
  let identity = 0;
  const revisionId = vi.fn(() => `editing-${++identity}`);
  const createdAt = vi.fn(() => 5678);
  const options = { workspace, revisionId, createdAt };
  const start = (input: EditorDurableEditingOptions = options) => {
    const result = createEditorBrowserAgentWorkspace(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    return result.adapter;
  };
  cleanups.push(async () => {
    workspace.current?.release();
    cache.clear();
    await deleteIndexedDbPersistenceDatabase(databaseName);
  });
  return { persistence, workspace, publish, options, start, revisionId, createdAt };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function expectDurable(
  f: ReturnType<typeof fixture>, revisionId: string, sequence: number, value: number,
  document = documentAt(value),
) {
  const expected = { documentId: "document-1", revisionId, sequence, document };
  expect(await f.persistence.readRevision("document-1", revisionId)).toMatchObject(expected);
  expect(await f.persistence.readPointers("document-1")).toEqual({
    saved: null, draft: { kind: "draft", documentId: "document-1", revisionId, sequence },
  });
  expect(f.workspace.current?.revision).toMatchObject(expected);
}

async function expectSummary(adapter: ReturnType<ReturnType<typeof fixture>["start"]>, revision: number) {
  await expect(adapter.execute(request("get_draft_summary"))).resolves.toEqual(response({
    ok: true,
    summary: {
      documentId: "document-1", revision, schemaVersion: 1, durationUs: 1_000_000,
      playbackRange: { startUs: 0, endUs: 1_000_000 }, loop: true,
      elementCount: 1, trackCount: 1,
    },
  }));
}

it("bounds missing and unsuitable initialization without reload or release", async () => {
  const f = fixture();
  const reload = vi.fn(f.workspace.reload);
  const options = { ...f.options, workspace: {
    get current() { return f.workspace.current; }, publish: f.workspace.publish, reload,
  } };
  expect(createEditorBrowserAgentWorkspace(options)).toEqual(initFailure);
  const initial = await f.publish("initial", 40, 0.4);
  expect(createEditorBrowserAgentWorkspace({ ...f.options, createdAt: undefined as never }))
    .toEqual(initFailure);
  expect(createEditorBrowserAgentWorkspace(null as never)).toEqual(initFailure);
  expect(createEditorBrowserAgentWorkspace({
    ...f.options, get revisionId(): never { throw new Error("private detail"); },
  })).toEqual(initFailure);
  expect(f.workspace.current).toBe(initial);
  initial.release();
  const read = vi.spyOn(f.persistence, "readPointers");
  expect(createEditorBrowserAgentWorkspace(options)).toEqual(initFailure);
  expect(read).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
  expect(f.workspace.current).toBeNull();
  expect((await f.persistence.readPointers("document-1")).draft?.revisionId).toBe("initial");
  expect(f.revisionId).not.toHaveBeenCalled();
  expect(f.createdAt).not.toHaveBeenCalled();
});

it("captures declared getters once before current and fails closed on incoherent current", async () => {
  const f = fixture();
  const initial = await f.publish("initial", 40, 0.4);
  const reads: string[] = [];
  const options = Object.create(null) as EditorDurableEditingOptions;
  const idSource = () => ({ kind: "id" as const, id: "added-group" });
  const current = vi.fn(() => {
    expect(reads).toEqual(["workspace", "revisionId", "createdAt", "commandElementIdSource"]);
    return f.workspace.current;
  });
  const workspace = { ...f.workspace, get current() { return current(); } };
  for (const [key, value] of Object.entries({ ...f.options, workspace, commandElementIdSource: idSource })) {
    Object.defineProperty(options, key, { get() { reads.push(key); return value; } });
  }
  current.mockImplementation(() => {
    expect(reads).toEqual(["workspace", "revisionId", "createdAt", "commandElementIdSource"]);
    return initial;
  });
  const adapter = f.start(options);
  expect(current).toHaveBeenCalledTimes(3);
  current.mockImplementation(() => f.workspace.current);
  const expected = documentAt(0.4);
  expected.rootIds.push("added-group");
  expected.elements.push({ id: "added-group", type: "group", childrenIds: [] });
  await expect(adapter.execute(request("dispatch_draft_command", { command: {
    ...command(0.6), payload: { type: "create-element", element: { type: "group", childrenIds: [] } },
  } }))).resolves.toEqual(response({ ok: true, revision: 1, document: expected }));
  expect(reads).toHaveLength(4);
  expect(await f.persistence.readRevision("document-1", "editing-1"))
    .toMatchObject({ document: expected });
  const live = f.workspace.current;
  current.mockReturnValueOnce(live).mockReturnValueOnce(live).mockReturnValueOnce(null);
  expect(createEditorBrowserAgentWorkspace({ ...f.options, workspace })).toEqual(initFailure);
  expect(f.workspace.current).toBe(live);
});

it("exposes exactly five tools and publishes isolated dispatch, undo, redo states in order", async () => {
  const f = fixture();
  const initial = await f.publish("initial", 40, 0.4);
  const read = vi.spyOn(f.persistence, "readPointers");
  const adapter = f.start();
  expect(read).not.toHaveBeenCalled();
  expect(f.workspace.current).toBe(initial);
  expect(adapter.tools.map(({ name }: { readonly name: string }) => name)).toEqual([
    "particle_studio.get_draft_summary", "particle_studio.validate_draft",
    "particle_studio.dispatch_draft_command", "particle_studio.undo", "particle_studio.redo",
  ]);
  await expectSummary(adapter, 0);
  const supplied = command(0.6);
  const pending = adapter.execute(request("dispatch_draft_command", { command: supplied }));
  supplied.payload.value = 0.9;
  const dispatched = await pending;
  expect(dispatched).toEqual(response({ ok: true, revision: 1, document: documentAt(0.6) }));
  expect(Object.isFrozen(dispatched)).toBe(true);
  if (!("result" in dispatched)) throw new Error("expected domain result");
  const result = dispatched.result as { document: SceneDocumentV1 };
  expect(() => { result.document.tracks[0]!.keyframes[0]!.value = 0.1; }).toThrow(TypeError);
  await expectDurable(f, "editing-1", 41, 0.6);
  await expectSummary(adapter, 1);
  await expect(adapter.execute(request("undo"))).resolves.toEqual(
    response({ ok: true, revision: 2, document: documentAt(0.4) }),
  );
  await expectDurable(f, "editing-2", 42, 0.4);
  await expectSummary(adapter, 2);
  await expect(adapter.execute(request("redo"))).resolves.toEqual(
    response({ ok: true, revision: 3, document: documentAt(0.6) }),
  );
  await expectDurable(f, "editing-3", 43, 0.6);
  await expectSummary(adapter, 3);
  expect(f.revisionId).toHaveBeenCalledTimes(3);
  expect(f.createdAt).toHaveBeenCalledTimes(3);
});

it("keeps validation, domain rejection, malformed and unknown envelopes read-only", async () => {
  const f = fixture();
  const initial = await f.publish("initial", 40, 0.4);
  const publish = vi.fn(f.workspace.publish);
  const adapter = f.start({ ...f.options, workspace: {
    get current() { return f.workspace.current; }, reload: f.workspace.reload, publish,
  } });
  const write = vi.spyOn(f.persistence, "writeCompleteRevisionIfPointersMatch");
  await expect(adapter.execute(request("validate_draft", { document: documentAt(0.8) })))
    .resolves.toEqual(response({ ok: true, value: documentAt(0.8) }));
  await expect(adapter.execute(request("validate_draft", { document: {} })))
    .resolves.toEqual(domainError("SCENE_DOCUMENT_SCHEMA_VERSION_MISSING"));
  await expect(adapter.execute(request("dispatch_draft_command", { command: command(0.6, 9) })))
    .resolves.toEqual(domainError("REVISION_CONFLICT"));
  await expect(adapter.execute(request("dispatch_draft_command", {
    command: { ...command(0.6), documentId: "foreign" },
  }))).resolves.toEqual(domainError("DOCUMENT_MISMATCH"));
  for (const malformed of [
    { ...request("undo"), extra: true },
    request("dispatch_draft_command", { command: { ...command(0.6), actorCapability: "human-ui" } }),
  ]) {
    await expect(adapter.execute(malformed)).resolves.toEqual({
      schemaVersion: 1, requestId: null, error: { code: "WEBMCP_MALFORMED_REQUEST" },
    });
  }
  await expect(adapter.execute(request("approve_draft"))).resolves.toEqual({
    schemaVersion: 1, requestId: "request-1", error: { code: "WEBMCP_TOOL_NOT_FOUND" },
  });
  for (const tool of ["undo", "redo"]) {
    await expect(adapter.execute(request(tool))).resolves.toEqual(domainError(`NOTHING_TO_${tool.toUpperCase()}`));
  }
  expect(publish).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(f.revisionId).not.toHaveBeenCalled();
  expect(f.createdAt).not.toHaveBeenCalled();
  expect(f.workspace.current).toBe(initial);
  await expectDurable(f, "initial", 40, 0.4);
  await expectSummary(adapter, 0);
});

it("rejects stale valid candidates with both histories retained and external content preserved", async () => {
  const f = fixture();
  await f.publish("initial", 40, 0.4);
  const adapter = f.start();
  await adapter.execute(request("dispatch_draft_command", { command: command(0.6) }));
  await adapter.execute(request("dispatch_draft_command", { command: command(0.7, 1) }));
  await adapter.execute(request("undo"));
  await expectDurable(f, "editing-3", 43, 0.6);
  await expectSummary(adapter, 3);
  const externalDocument = documentAt(0.8);
  externalDocument.durationUs = 2_000_000;
  externalDocument.loop = false;
  const external = await f.publish("external", 70, 0.8, externalDocument);
  const write = vi.spyOn(f.persistence, "writeCompleteRevisionIfPointersMatch");
  f.revisionId.mockClear();
  f.createdAt.mockClear();
  for (const operation of [
    request("undo"), request("redo"),
    request("dispatch_draft_command", { command: command(0.9, 3) }),
    request("undo"), request("redo"),
  ]) {
    await expect(adapter.execute(operation)).resolves.toEqual(domainError("DURABLE_PUBLISH_FAILED"));
    await expectSummary(adapter, 3);
    expect(f.workspace.current).toBe(external);
    await expectDurable(f, "external", 70, 0.8, externalDocument);
  }
  await expect(adapter.execute(request("dispatch_draft_command", { command: command(0.9, 9) })))
    .resolves.toEqual(domainError("REVISION_CONFLICT"));
  await expect(adapter.execute(request("dispatch_draft_command", {
    command: { ...command(0.9, 3), documentId: "foreign" },
  }))).resolves.toEqual(domainError("DOCUMENT_MISMATCH"));
  expect(write).not.toHaveBeenCalled();
  expect(f.revisionId).not.toHaveBeenCalled();
  expect(f.createdAt).not.toHaveBeenCalled();
  for (let candidate = 4; candidate <= 8; candidate += 1) {
    expect(await f.persistence.readRevision("document-1", `editing-${candidate}`)).toBeNull();
  }
});

it("preserves empty-history errors before any stale publisher attempt", async () => {
  const f = fixture();
  await f.publish("initial", 40, 0.4);
  const publish = vi.fn(f.workspace.publish);
  const adapter = f.start({ ...f.options, workspace: {
    get current() { return f.workspace.current; }, reload: f.workspace.reload, publish,
  } });
  const external = await f.publish("external", 70, 0.8);
  const write = vi.spyOn(f.persistence, "writeCompleteRevisionIfPointersMatch");
  await expect(adapter.execute(request("undo"))).resolves.toEqual(domainError("NOTHING_TO_UNDO"));
  await expect(adapter.execute(request("redo"))).resolves.toEqual(domainError("NOTHING_TO_REDO"));
  expect(publish).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(f.revisionId).not.toHaveBeenCalled();
  expect(f.createdAt).not.toHaveBeenCalled();
  await expectSummary(adapter, 0);
  expect(f.workspace.current).toBe(external);
  await expectDurable(f, "external", 70, 0.8);
});
