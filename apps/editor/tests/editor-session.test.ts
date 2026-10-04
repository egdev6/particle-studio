import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import {
  canonicalizeSceneDocument, FIRST_SLICE_DOCUMENT, type SceneDocumentV1,
} from "@particle-studio/scene-document";
import {
  createIndexedDbPersistenceAdapter, deleteIndexedDbPersistenceDatabase,
} from "@particle-studio/persistence-indexeddb";
import { createCompleteRevision, createSavedRevisionPointer } from "@particle-studio/persistence";
import { createEditorSession, type EditorSessionDependencies } from "../src/editor-session.js";
import * as durableEditing from "../src/editor-durable-editing.js";

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

function fixture(jsonImportSequenceFloor?: () => number) {
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
    jsonImportSequenceFloor,
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

it("imports above a captured saved-only floor, retaining saved identity and progressing current", async () => {
  const floor = vi.fn(() => 41);
  const f = fixture(floor);
  expect(floor).not.toHaveBeenCalled();
  const saved = createCompleteRevision({ documentId: "document-1", revisionId: "saved-41",
    sequence: 41, document: documentAt(0.2) });
  const savedPointer = createSavedRevisionPointer(saved);
  await f.persistence.writeCompleteRevision(saved, { saved: savedPointer, draft: null });
  const before = await f.persistence.readPointers("document-1");
  await expect(f.session.importWorkflow({ kind: "editable-json-import", editableJson: "{" })).rejects.toThrow();
  expect(f.session.workspace.current).toBeNull();
  expect(f.writeRevision).not.toHaveBeenCalled();
  expect(await f.persistence.readPointers("document-1")).toEqual(before);
  await expect(f.importJson()).resolves.toBeUndefined();
  expect(floor).toHaveBeenCalledTimes(2);
  expect(f.session.workspace.current?.revision).toMatchObject({ revisionId: "revision-1", sequence: 42 });
  expect(await f.persistence.readPointers("document-1")).toEqual({ saved: before.saved,
    draft: { kind: "draft", documentId: "document-1", revisionId: "revision-1", sequence: 42 } });
  expect(await f.persistence.readRevision("document-1", "saved-41")).toEqual(saved);
  f.deps.jsonImportSequenceFloor = () => { throw new Error("retargeted floor"); };
  await f.importJson(documentAt(0.6));
  expect(f.session.workspace.current?.revision.sequence).toBe(43);
  expect(floor).toHaveBeenCalledTimes(3);
  expect(f.reads).toEqual(Object.keys(f.deps));
});

it.each([() => -1, () => 1.5, () => NaN, () => Infinity,
  () => Number.MAX_SAFE_INTEGER, () => { throw new Error("floor failed"); }])(
  "fails closed for an invalid or throwing JSON floor without conditional writes", async (floor) => {
    const f = fixture(floor);
    const before = await f.persistence.readPointers("document-1");
    await expect(f.importJson()).rejects.toThrow();
    expect(f.writeRevision).not.toHaveBeenCalled();
    expect(f.session.workspace.current).toBeNull();
    expect(await f.persistence.readPointers("document-1")).toEqual(before);
  },
);

it("preserves current and pointers on malformed JSON and identity faults with a floor", async () => {
  const floor = vi.fn(() => 41);
  const f = fixture(floor);
  await f.importJson();
  const current = f.session.workspace.current;
  const before = await f.persistence.readPointers("document-1");
  f.writeRevision.mockClear();
  await expect(f.session.importWorkflow({ kind: "editable-json-import", editableJson: "{" })).rejects.toThrow();
  f.deps.revisionId.mockImplementation(() => { throw new Error("identity failed"); });
  await expect(f.importJson()).rejects.toThrow();
  f.deps.revisionId.mockReturnValue("");
  await expect(f.importJson()).rejects.toThrow();
  f.deps.revisionId.mockReturnValue("bad-timestamp");
  f.deps.createdAt.mockReturnValue(-1);
  await expect(f.importJson()).rejects.toThrow();
  expect(floor).toHaveBeenCalledTimes(5);
  expect(f.writeRevision).not.toHaveBeenCalled();
  expect(f.session.workspace.current).toBe(current);
  expect(await f.persistence.readPointers("document-1")).toEqual(before);
});

it("rejects live-current overflow and keeps the floor out of the image route", async () => {
  const floor = vi.fn(() => 41);
  const f = fixture(floor);
  await f.importJson();
  floor.mockImplementation(() => { throw new Error("JSON only"); });
  await expect(f.session.importWorkflow({ kind: "image-import",
    file: new File([bytes], "particles.png", { type: "image/png" }) })).resolves.toBeUndefined();
  expect(floor).toHaveBeenCalledTimes(1);
  expect(f.session.workspace.current?.revision.sequence).toBe(43);
  floor.mockReturnValue(0);
  await f.session.workspace.publish({ documentId: "document-1", editableJson: JSON.stringify(documentAt(0.6)),
    revisionId: () => "maximum", sequence: Number.MAX_SAFE_INTEGER, createdAt: () => 1234 });
  const current = f.session.workspace.current;
  const before = await f.persistence.readPointers("document-1");
  f.writeRevision.mockClear();
  await expect(f.importJson()).rejects.toThrow("EDITOR_JSON_IMPORT_SEQUENCE_INVALID");
  expect(f.writeRevision).not.toHaveBeenCalled();
  expect(f.session.workspace.current).toBe(current);
  expect(await f.persistence.readPointers("document-1")).toEqual(before);
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

type DimensionsRequest = { documentId: string; revisionId: string; elementId: string; width: number; height: number };
function selectedDimensions(f: ReturnType<typeof fixture>, width = 2.5, height = 7.25): DimensionsRequest {
  const source = f.session.workspace.current!.revision;
  return { documentId: source.documentId, revisionId: source.revisionId, elementId: "shape-1", width, height };
}

it.each(["root", "nested", "equal", "initial-zero-negative", "maximum"])(
  "dimensions publishes exact %s content with a fresh human bridge and captured intent", async (kind) => {
    const f = fixture();
    const document = documentAt(0.4);
    document.seed = 99; document.loop = false; document.playbackRange.startUs = 500_000;
    Object.assign(document.elements[0]!, { width: 31, height: 47, opacity: 0.6,
      transform: [1, 0.5, 0, 2, 10, -20], visible: false });
    if (kind === "initial-zero-negative") Object.assign(document.elements[0]!, { width: 0, height: -4 });
    if (kind === "nested") {
      document.rootIds = ["group"];
      document.elements.push({ id: "group", type: "group", childrenIds: ["shape-1"], transform: [1, 0, 0, 1, 30, 40] });
    }
    await f.importJson(document);
    const source = f.session.workspace.current!;
    expect(source.revision.document).toEqual(document);
    expect(typeof f.session.setShapeDimensions).toBe("function");
    const input = selectedDimensions(f, kind === "equal" ? 31 : kind === "maximum" ? Number.MAX_VALUE : 2.5,
      kind === "equal" ? 47 : kind === "maximum" ? Number.MAX_VALUE : 7.25);
    const expected = structuredClone(document);
    Object.assign(expected.elements[0]!, { width: input.width, height: input.height });
    const reads: string[] = [];
    const captured = { ...input };
    for (const key of Object.keys(input) as (keyof DimensionsRequest)[]) {
      Object.defineProperty(captured, key, { get() { reads.push(key); return input[key]; } });
    }
    const real = durableEditing.createEditorDurableEditing;
    const dispatch = vi.fn(); const publish = vi.fn();
    const bridge = vi.spyOn(durableEditing, "createEditorDurableEditing").mockImplementation((options) => {
      const result = real({ ...options, workspace: { get current() { return options.workspace.current; },
        publish: (request) => { publish(request); return options.workspace.publish(request); },
        reload: options.workspace.reload.bind(options.workspace) } });
      if (!result.ok) return result;
      return { ok: true, editing: { snapshot: result.editing.snapshot.bind(result.editing),
        undo: result.editing.undo.bind(result.editing), redo: result.editing.redo.bind(result.editing),
        dispatch: (command) => { dispatch(command); return result.editing.dispatch(command); } } };
    });
    clearPositionEffects(f);
    f.deps.commandId.mockImplementation(() => {
      Object.assign(input, { documentId: "foreign", revisionId: "retargeted", elementId: "group", width: 999, height: 999 });
      return "dimension-command";
    });
    const flight = f.session.setShapeDimensions(captured);
    expect(reads.sort()).toEqual(Object.keys(input).sort());
    input.width = 888; input.height = 888;
    await flight;
    const shape = expected.elements[0]!;
    if (shape.type !== "shape") throw new Error("fixture shape required");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ commandSchemaVersion: 1, commandId: "dimension-command",
      documentId: "document-1", expectedRevision: 0, actorCapability: "human-ui",
      payload: { type: "set-shape-dimensions", elementId: "shape-1", width: shape.width, height: shape.height } });
    expect(publish.mock.calls[0]![0]).toMatchObject({ sequence: 2,
      expectedSource: { documentId: "document-1", revisionId: source.revision.revisionId } });
    await expectDurable(f, "revision-2", 2, expected);
    expect(reads.sort()).toEqual(Object.keys(input).sort());
    expect(await f.persistence.readRevision("document-1", source.revision.revisionId)).toEqual(source.revision);
    expect(f.deps.elementIdSource).not.toHaveBeenCalled();
    expect(f.writeRevision).toHaveBeenCalledTimes(1);
    for (const spy of [f.deps.commandId, f.deps.revisionId, f.deps.createdAt]) expect(spy).toHaveBeenCalledTimes(1);
    await f.session.setShapeDimensions(selectedDimensions(f, shape.width, shape.height));
    expect(bridge).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]![0]).toMatchObject({ expectedRevision: 0 });
    await expectDurable(f, "revision-3", 3, expected);
  },
);

const invalidDimensions = [0, -0, -1, NaN, Infinity, -Infinity, "4", null, undefined] as const;
it.each([
  ...invalidDimensions.map((width) => ["width", { width }] as const),
  ...invalidDimensions.map((height) => ["height", { height }] as const),
  ["missing document", { documentId: "" }], ["foreign document", { documentId: "foreign" }],
  ["nonstring document", { documentId: 3 }], ["missing revision", { revisionId: "" }],
  ["stale revision", { revisionId: "old" }], ["nonstring revision", { revisionId: null }],
  ["missing target", { elementId: "" }], ["unknown target", { elementId: "unknown" }],
  ["nonstring target", { elementId: 3 }], ["group target", { elementId: "group" }],
] as const)("dimensions rejects %s before effects (%j)", async (_name, invalid) => {
  const f = fixture(); const document = documentAt(0.4);
  document.elements.push({ id: "group", type: "group", childrenIds: [] }); document.rootIds.push("group");
  await f.importJson(document);
  const current = f.session.workspace.current!; const pointers = await f.persistence.readPointers("document-1");
  clearPositionEffects(f);
  expect(typeof f.session.setShapeDimensions).toBe("function");
  await expect(f.session.setShapeDimensions({ ...selectedDimensions(f), ...invalid } as DimensionsRequest))
    .rejects.toThrow(/EDITOR_SHAPE_DIMENSIONS_/);
  expectNoPositionEffects(f); expect(f.session.workspace.current).toBe(current);
  expect(await f.persistence.readPointers("document-1")).toEqual(pointers);
  expect(await f.persistence.readRevision("document-1", current.revision.revisionId)).toEqual(current.revision);
});

it.each([null, undefined, {}, [], "request", 3])("dimensions rejects malformed request %j without effects", async (input) => {
  const f = fixture(); await f.importJson(); const current = f.session.workspace.current;
  clearPositionEffects(f);
  expect(typeof f.session.setShapeDimensions).toBe("function");
  await expect(f.session.setShapeDimensions(input as DimensionsRequest)).rejects.toThrow(/EDITOR_SHAPE_DIMENSIONS_/);
  expectNoPositionEffects(f); expect(f.session.workspace.current).toBe(current);
});

it.each(["missing", "foreign", "overflow", "released"])("dimensions rejects %s live current before effects", async (kind) => {
  const f = fixture();
  if (kind !== "missing") await f.session.workspace.publish({ documentId: kind === "foreign" ? "foreign" : "document-1",
    editableJson: JSON.stringify(documentAt(0.4)), revisionId: () => "source",
    sequence: kind === "overflow" ? Number.MAX_SAFE_INTEGER : 1, createdAt: () => 1234 });
  if (kind === "released") f.session.workspace.current!.release();
  const current = f.session.workspace.current; clearPositionEffects(f);
  expect(typeof f.session.setShapeDimensions).toBe("function");
  await expect(f.session.setShapeDimensions({ documentId: "document-1", revisionId: "source", elementId: "shape-1", width: 1, height: 2 }))
    .rejects.toThrow(/EDITOR_SHAPE_DIMENSIONS_/);
  expectNoPositionEffects(f); expect(f.session.workspace.current).toBe(current);
});

it.each(["line", "text", "particle", "image"] as const)("dimensions rejects genuine %s targets before effects", async (type) => {
  const f = fixture(); await f.importJson();
  if (type === "image") await f.session.importWorkflow({ kind: "image-import", file: new File([bytes], "image.png", { type: "image/png" }) });
  else {
    const document = documentAt(0.4);
    const element = type === "line" ? { id: "nonshape", type, x1: 0, y1: 0, x2: 1, y2: 1, opacity: 1 }
      : type === "text" ? { id: "nonshape", type, x: 0, y: 0, text: "authored", fontSize: 12, opacity: 1 }
      : { id: "nonshape", type, count: 1, x: 0, y: 0, velocityX: 1, velocityY: 1, spread: 1, size: 1, opacity: 1, lifetimeSteps: 1 };
    document.elements.push(element); document.rootIds.push("nonshape"); await f.importJson(document);
  }
  const current = f.session.workspace.current!; const pointers = await f.persistence.readPointers("document-1");
  clearPositionEffects(f); expect(typeof f.session.setShapeDimensions).toBe("function");
  await expect(f.session.setShapeDimensions({ ...selectedDimensions(f), elementId: type === "image" ? "image-1" : "nonshape" }))
    .rejects.toThrow(/EDITOR_SHAPE_DIMENSIONS_/);
  expectNoPositionEffects(f); expect(f.session.workspace.current).toBe(current);
  expect(await f.persistence.readPointers("document-1")).toEqual(pointers);
  expect(await f.persistence.readRevision("document-1", current.revision.revisionId)).toEqual(current.revision);
});

it("dimensions refuses reused IDs and a queued newer publication without writing its allocated candidate", async () => {
  const f = fixture(); await f.importJson(); const stale = selectedDimensions(f);
  expect(typeof f.session.setShapeDimensions).toBe("function");
  await f.importJson(documentAt(0.8)); clearPositionEffects(f);
  await expect(f.session.setShapeDimensions(stale)).rejects.toThrow(/EDITOR_SHAPE_DIMENSIONS_/);
  expectNoPositionEffects(f);
  const selected = selectedDimensions(f); const replacement = f.importJson(documentAt(0.6));
  const candidateIndex = f.deps.revisionId.mock.results.length;
  const flight = f.session.setShapeDimensions(selected);
  const candidate = f.deps.revisionId.mock.results[candidateIndex]!;
  expect(candidate.type).toBe("return");
  Object.assign(selected, { revisionId: "retargeted", elementId: "missing", width: 999, height: 999 });
  await replacement; const winner = f.session.workspace.current!;
  await expect(flight).rejects.toThrow(/EDITOR_SHAPE_DIMENSIONS_/);
  expect(f.session.workspace.current).toBe(winner);
  expect(candidate.value).not.toBe(winner.revision.revisionId);
  expect(await f.persistence.readRevision("document-1", candidate.value)).toBeNull();
  await expectDurable(f, winner.revision.revisionId, 3, documentAt(0.6));
});

it.each(["preparation", "conditional-conflict"])("dimensions preserves truthful durable state on %s and recovers", async (fault) => {
  const f = fixture(); await f.importJson(); const source = f.session.workspace.current!;
  expect(typeof f.session.setShapeDimensions).toBe("function");
  const pointers = await f.persistence.readPointers("document-1");
  const winner = createCompleteRevision({ documentId: "document-1", revisionId: "external-winner", sequence: 2, document: documentAt(0.8) });
  if (fault === "preparation") f.readPointers.mockRejectedValueOnce(new Error("prepare failed"));
  else {
    const realWrite = f.writeRevision.getMockImplementation()!;
    f.writeRevision.mockImplementationOnce(async (...args) => {
      await f.persistence.writeCompleteRevision(winner, { saved: null,
        draft: { kind: "draft", documentId: "document-1", revisionId: winner.revisionId, sequence: 2 } });
      return realWrite(...args);
    });
  }
  await expect(f.session.setShapeDimensions(selectedDimensions(f))).rejects.toThrow(/EDITOR_SHAPE_DIMENSIONS_/);
  expect(f.session.workspace.current).toBe(source);
  expect(await f.persistence.readRevision("document-1", "revision-2")).toBeNull();
  expect(await f.persistence.readRevision("document-1", source.revision.revisionId)).toEqual(source.revision);
  if (fault === "preparation") expect(await f.persistence.readPointers("document-1")).toEqual(pointers);
  else {
    expect(await f.persistence.readRevision("document-1", winner.revisionId)).toEqual(winner);
    expect((await f.persistence.readPointers("document-1")).draft?.revisionId).toBe(winner.revisionId);
    await f.session.reload();
  }
  await f.session.setShapeDimensions(selectedDimensions(f));
  expect(f.session.workspace.current?.revision.sequence).toBe(fault === "preparation" ? 2 : 3);
});

it("dimensions retains saved PNG metadata and individual bitmap ownership through failure and later imports", async () => {
  const f = fixture(); await f.importJson();
  await f.session.importWorkflow({ kind: "image-import", file: new File([bytes], "image.png", { type: "image/png" }) });
  const original = f.session.workspace.current!; const saved = createSavedRevisionPointer(original.revision);
  const retained = original.workspace.images[0]!.handle;
  await f.persistence.writeCompleteRevision(original.revision, { saved, draft: (await f.persistence.readPointers("document-1")).draft });
  const source = await f.session.reload(); // Refresh full canonical prior after explicit external fixture write.
  expect(source.workspace.images[0]!.handle).toBe(retained);
  const asset = await f.persistence.readAsset(await sha256(bytes));
  const expected = structuredClone(source.revision.document); Object.assign(expected.elements[0]!, { width: 2.5, height: 7.25 });
  clearPositionEffects(f); expect(typeof f.session.setShapeDimensions).toBe("function");
  await f.session.setShapeDimensions(selectedDimensions(f));
  expect(f.session.workspace.current?.revision).toMatchObject({ sequence: 3, document: expected });
  expect(f.session.workspace.current?.workspace.images[0]!.handle).toBe(retained);
  expect(f.readAsset).toHaveBeenCalled(); expect(f.decodePng).toHaveBeenCalled(); expect(f.writeAsset).not.toHaveBeenCalled();
  for (const handle of f.handles) expect(handle.close).toHaveBeenCalledTimes(handle === retained ? 0 : 1);
  const current = f.session.workspace.current!; const pointers = await f.persistence.readPointers("document-1");
  f.readAsset.mockRejectedValueOnce(new Error("prehydration fault"));
  await expect(f.session.setShapeDimensions(selectedDimensions(f, 9, 10))).rejects.toThrow(/EDITOR_SHAPE_DIMENSIONS_/);
  expect(f.session.workspace.current).toBe(current); expect(await f.persistence.readPointers("document-1")).toEqual(pointers);
  expect(await f.persistence.readRevision("document-1", "revision-4")).toBeNull();
  expect(await f.persistence.readRevision("document-1", source.revision.revisionId)).toEqual(source.revision);
  expect(await f.persistence.readAsset(await sha256(bytes))).toEqual(asset); expect(pointers.saved).toEqual(saved);
  for (const handle of f.handles) expect(handle.close).toHaveBeenCalledTimes(handle === retained ? 0 : 1);
  await f.importJson(documentAt(0.6)); expect(f.session.workspace.current?.revision.sequence).toBe(4);
  f.deps.elementIdSource.mockReturnValue({ kind: "id", id: "later-image" });
  await f.session.importWorkflow({ kind: "image-import", file: new File([bytes], "later.png", { type: "image/png" }) });
  expect(f.session.workspace.current?.revision.sequence).toBe(5);
  f.deps.elementIdSource.mockReturnValue({ kind: "id", id: "later-rectangle" });
  await f.session.addRectangle(rectangleGeometry); expect(f.session.workspace.current?.revision.sequence).toBe(6);
  f.session.workspace.current!.release(); f.session.cache.clear();
  for (const handle of f.handles) expect(handle.close).toHaveBeenCalledTimes(1);
});

type PositionRequest = { documentId: string; revisionId: string; elementId: string; x: number; y: number };
function selectedPosition(f: ReturnType<typeof fixture>, x = -2.5, y = 7.25): PositionRequest {
  const source = f.session.workspace.current!.revision;
  return { documentId: source.documentId, revisionId: source.revisionId, elementId: "shape-1", x, y };
}
function clearPositionEffects(f: ReturnType<typeof fixture>) {
  for (const spy of [f.readPointers, f.readRevision, f.writeRevision, f.readAsset, f.writeAsset,
    f.deps.sha256, f.decodePng, f.deps.commandId, f.deps.elementIdSource, f.deps.revisionId,
    f.deps.createdAt]) spy.mockClear();
}
function expectNoPositionEffects(f: ReturnType<typeof fixture>) {
  for (const spy of [f.readPointers, f.readRevision, f.writeRevision, f.readAsset, f.writeAsset,
    f.deps.sha256, f.decodePng, f.deps.commandId, f.deps.elementIdSource, f.deps.revisionId,
    f.deps.createdAt]) expect(spy).not.toHaveBeenCalled();
}

it.each(["root", "nested", "equal"])("position publishes exact %s content using a fresh human bridge", async (kind) => {
  const f = fixture(); const document = documentAt(0.4);
  document.seed = 99; document.loop = false; document.playbackRange.startUs = 500_000;
  Object.assign(document.elements[0]!, { width: 31, height: 47, opacity: 0.6,
    transform: [1, 0.5, 0, 2, 10, -20], visible: false });
  if (kind === "nested") {
    document.rootIds = ["group"];
    document.elements.push({ id: "group", type: "group", childrenIds: ["shape-1"], transform: [1, 0, 0, 1, 30, 40] });
  }
  await f.importJson(document); const source = f.session.workspace.current!;
  expect(typeof f.session.setShapePosition).toBe("function");
  const shape = document.elements[0]!; if (shape.type !== "shape") throw new Error("fixture shape required");
  const input = selectedPosition(f, kind === "equal" ? shape.x : -2.5, kind === "equal" ? shape.y : 7.25);
  const reads: string[] = [];
  const request = { ...input };
  for (const key of Object.keys(input) as (keyof PositionRequest)[]) {
    Object.defineProperty(request, key, { get() { reads.push(key); return input[key]; } });
  }
  const real = durableEditing.createEditorDurableEditing;
  const dispatch = vi.fn(); const publish = vi.fn();
  const bridge = vi.spyOn(durableEditing, "createEditorDurableEditing").mockImplementation((options) => {
    const result = real({ ...options, workspace: { get current() { return options.workspace.current; },
      publish: (request) => { publish(request); return options.workspace.publish(request); },
      reload: options.workspace.reload.bind(options.workspace) } });
    if (!result.ok) return result;
    return { ok: true, editing: { snapshot: result.editing.snapshot.bind(result.editing),
      undo: result.editing.undo.bind(result.editing), redo: result.editing.redo.bind(result.editing),
      dispatch: (command) => { dispatch(command); return result.editing.dispatch(command); } } };
  });
  clearPositionEffects(f); const flight = f.session.setShapePosition(request);
  expect(reads.sort()).toEqual(Object.keys(input).sort());
  input.x = 999; input.y = 999; input.documentId = "foreign";
  input.elementId = "group"; input.revisionId = "retargeted";
  await flight;
  const x = kind === "equal" ? shape.x : -2.5; const y = kind === "equal" ? shape.y : 7.25;
  const expected = structuredClone(document); Object.assign(expected.elements[0]!, { x, y });
  expect(dispatch).toHaveBeenCalledExactlyOnceWith({ commandSchemaVersion: 1, commandId: "image-command",
    documentId: "document-1", expectedRevision: 0, actorCapability: "human-ui",
    payload: { type: "set-shape-position", elementId: "shape-1", x, y } });
  expect(publish.mock.calls[0]![0]).toMatchObject({ sequence: 2,
    expectedSource: { documentId: "document-1", revisionId: source.revision.revisionId } });
  await expectDurable(f, "revision-2", 2, expected);
  expect(reads.sort()).toEqual(Object.keys(input).sort());
  expect(await f.persistence.readRevision("document-1", "revision-1")).toEqual(source.revision);
  expect(f.deps.elementIdSource).not.toHaveBeenCalled(); expect(f.deps.commandId).toHaveBeenCalledTimes(1);
  expect(f.deps.revisionId).toHaveBeenCalledTimes(1); expect(f.deps.createdAt).toHaveBeenCalledTimes(1);
  await f.session.setShapePosition(selectedPosition(f, x, y));
  expect(bridge).toHaveBeenCalledTimes(2); expect(dispatch.mock.calls[1]![0]).toMatchObject({ expectedRevision: 0 });
  await expectDurable(f, "revision-3", 3, expected);
});

it.each([
  ["missing document", { documentId: "" }], ["foreign document", { documentId: "foreign" }],
  ["missing revision", { revisionId: "" }], ["stale revision", { revisionId: "old" }],
  ["nonstring document", { documentId: 3 }], ["nonstring revision", { revisionId: null }],
  ["missing target", { elementId: "" }], ["unknown target", { elementId: "unknown" }],
  ["nonstring target", { elementId: 3 }], ["group target", { elementId: "group" }],
  ["NaN X", { x: NaN }], ["infinite Y", { y: Infinity }], ["negative infinite X", { x: -Infinity }],
  ["string X", { x: "4" }], ["null Y", { y: null }],
] as const)("position rejects %s before IDs, time, assets or persistence", async (_name, invalid) => {
  const f = fixture(); const document = documentAt(0.4);
  document.elements.push({ id: "group", type: "group", childrenIds: [] }); document.rootIds.push("group");
  await f.importJson(document); const current = f.session.workspace.current;
  const pointers = await f.persistence.readPointers("document-1"); clearPositionEffects(f);
  expect(typeof f.session.setShapePosition).toBe("function");
  await expect(f.session.setShapePosition({ ...selectedPosition(f), ...invalid } as PositionRequest)).rejects.toThrow();
  expectNoPositionEffects(f); expect(f.session.workspace.current).toBe(current);
  expect(await f.persistence.readPointers("document-1")).toEqual(pointers);
});

it.each([null, undefined, {}])("position rejects malformed requests with bounded errors and no effects (%j)", async (input) => {
  const f = fixture(); await f.importJson(); const current = f.session.workspace.current;
  clearPositionEffects(f);
  await expect(f.session.setShapePosition(input as PositionRequest)).rejects.toThrow(/EDITOR_SHAPE_POSITION_/);
  expectNoPositionEffects(f); expect(f.session.workspace.current).toBe(current);
});

it.each(["missing", "foreign", "overflow", "released"])("position rejects %s live current without effects", async (kind) => {
  const f = fixture();
  if (kind !== "missing") await f.session.workspace.publish({ documentId: kind === "foreign" ? "foreign" : "document-1",
    editableJson: JSON.stringify(documentAt(0.4)), revisionId: () => "source",
    sequence: kind === "overflow" ? Number.MAX_SAFE_INTEGER : 1, createdAt: () => 1234 });
  if (kind === "released") f.session.workspace.current!.release();
  const current = f.session.workspace.current; clearPositionEffects(f);
  expect(typeof f.session.setShapePosition).toBe("function");
  await expect(f.session.setShapePosition({ documentId: "document-1", revisionId: "source", elementId: "shape-1", x: 1, y: 2 })).rejects.toThrow();
  expectNoPositionEffects(f); expect(f.session.workspace.current).toBe(current);
});

it.each(["line", "text", "particle", "image"] as const)("position rejects a genuine %s target without effects", async (type) => {
  const f = fixture(); await f.importJson();
  if (type === "image") await f.session.importWorkflow({ kind: "image-import", file: new File([bytes], "image.png", { type: "image/png" }) });
  else {
    const document = documentAt(0.4);
    const element = type === "line" ? { id: "nonshape", type, x1: 0, y1: 0, x2: 1, y2: 1, opacity: 1 }
      : type === "text" ? { id: "nonshape", type, x: 0, y: 0, text: "authored", fontSize: 12, opacity: 1 }
      : { id: "nonshape", type, count: 1, x: 0, y: 0, velocityX: 1, velocityY: 1, spread: 1, size: 1, opacity: 1, lifetimeSteps: 1 };
    document.elements.push(element); document.rootIds.push("nonshape"); await f.importJson(document);
  }
  const current = f.session.workspace.current; const pointers = await f.persistence.readPointers("document-1");
  clearPositionEffects(f); expect(typeof f.session.setShapePosition).toBe("function");
  await expect(f.session.setShapePosition({ ...selectedPosition(f), elementId: type === "image" ? "image-1" : "nonshape" })).rejects.toThrow();
  expectNoPositionEffects(f); expect(f.session.workspace.current).toBe(current);
  expect(await f.persistence.readPointers("document-1")).toEqual(pointers);
});

it("position refuses a reused ID after JSON replacement and a queued newer local publication", async () => {
  const f = fixture(); await f.importJson(); const stale = selectedPosition(f);
  await f.importJson(documentAt(0.8)); clearPositionEffects(f);
  expect(typeof f.session.setShapePosition).toBe("function");
  await expect(f.session.setShapePosition(stale)).rejects.toThrow(); expectNoPositionEffects(f);
  const selected = selectedPosition(f);
  const replacement = f.importJson(documentAt(0.6));
  const candidateIndex = f.deps.revisionId.mock.results.length;
  const position = f.session.setShapePosition(selected);
  const candidateResult = f.deps.revisionId.mock.results[candidateIndex]!;
  expect(candidateResult.type).toBe("return");
  const candidateRevisionId = candidateResult.value;
  await replacement; const current = f.session.workspace.current!;
  await expect(position).rejects.toThrow(); expect(f.session.workspace.current).toBe(current);
  expect(candidateRevisionId).not.toBe(current.revision.revisionId);
  expect(await f.persistence.readRevision("document-1", candidateRevisionId)).toBeNull();
  const winner = createCompleteRevision({ documentId: "document-1", revisionId: current.revision.revisionId,
    sequence: 3, document: documentAt(0.6) });
  expect(current.revision).toEqual(winner);
  expect(await f.persistence.readRevision("document-1", winner.revisionId)).toEqual(winner);
  expect(await f.persistence.readPointers("document-1")).toEqual({ saved: null,
    draft: { kind: "draft", documentId: "document-1", revisionId: winner.revisionId, sequence: 3 } });
});

it("position retains saved PNG history and each useful decoded handle through preparation and later imports", async () => {
  const f = fixture(); await f.importJson();
  await f.session.importWorkflow({ kind: "image-import", file: new File([bytes], "image.png", { type: "image/png" }) });
  const original = f.session.workspace.current!; const saved = createSavedRevisionPointer(original.revision);
  const retained = original.workspace.images[0]!.handle;
  await f.persistence.writeCompleteRevision(original.revision, { saved, draft: (await f.persistence.readPointers("document-1")).draft });
  // This fixture changed the full durable pointer snapshot externally. Explicit
  // public reload refreshes its live authority; production editing never rebases.
  const allocated = f.deps.revisionId.mock.calls.length;
  const source = await f.session.reload();
  expect(f.session.workspace.current).toBe(source);
  expect(source.revision).toEqual(original.revision);
  expect(source.workspace.images[0]!.handle).toBe(retained);
  expect(f.deps.revisionId).toHaveBeenCalledTimes(allocated);
  const asset = await f.persistence.readAsset(await sha256(bytes));
  const expected = structuredClone(source.revision.document); Object.assign(expected.elements[0]!, { x: -2.5, y: 7.25 });
  clearPositionEffects(f); expect(typeof f.session.setShapePosition).toBe("function");
  await f.session.setShapePosition(selectedPosition(f));
  expect(f.session.workspace.current?.revision).toMatchObject({ sequence: 3, document: expected });
  expect(f.session.workspace.current?.workspace.images[0]!.handle).toBe(retained);
  expect(f.readAsset).toHaveBeenCalled(); expect(f.decodePng).toHaveBeenCalled(); expect(f.writeAsset).not.toHaveBeenCalled();
  for (const handle of f.handles) expect(handle.close).toHaveBeenCalledTimes(handle === retained ? 0 : 1);
  expect(await f.persistence.readAsset(await sha256(bytes))).toEqual(asset);
  expect((await f.persistence.readPointers("document-1")).saved).toEqual(saved);
  expect(await f.persistence.readRevision("document-1", source.revision.revisionId)).toEqual(source.revision);
  f.readAsset.mockRejectedValueOnce(new Error("prehydration fault")); const current = f.session.workspace.current;
  const pointers = await f.persistence.readPointers("document-1");
  await expect(f.session.setShapePosition(selectedPosition(f, 9, 10))).rejects.toThrow();
  expect(f.session.workspace.current).toBe(current);
  expect(await f.persistence.readPointers("document-1")).toEqual(pointers);
  expect(await f.persistence.readRevision("document-1", "revision-4")).toBeNull();
  expect(f.session.workspace.current?.workspace.images[0]!.handle).toBe(retained);
  for (const handle of f.handles) expect(handle.close).toHaveBeenCalledTimes(handle === retained ? 0 : 1);
  await f.importJson(documentAt(0.6)); expect(f.session.workspace.current?.revision.sequence).toBe(4);
  expect(f.handles.find((handle) => handle === retained)!.close).toHaveBeenCalledTimes(1);
  f.deps.elementIdSource.mockReturnValue({ kind: "id", id: "later-image" });
  await f.session.importWorkflow({ kind: "image-import", file: new File([bytes], "later.png", { type: "image/png" }) });
  expect(f.session.workspace.current?.revision.sequence).toBe(5);
  f.deps.elementIdSource.mockReturnValue({ kind: "id", id: "later-rectangle" });
  await f.session.addRectangle(rectangleGeometry); expect(f.session.workspace.current?.revision.sequence).toBe(6);
  f.session.workspace.current!.release(); f.session.cache.clear();
  for (const handle of f.handles) expect(handle.close).toHaveBeenCalledTimes(1);
});

const rectangleGeometry = { x: 16, y: 24, width: 120, height: 80 };
function appendedRectangle(document: SceneDocumentV1, id = "image-1") {
  const expected = structuredClone(document);
  expected.rootIds.push(id);
  expected.elements.push({ id, type: "shape", ...rectangleGeometry, opacity: 1 });
  return expected;
}

it("rectangle uses a fresh real human command and captures source, geometry and metadata before await", async () => {
  const f = fixture();
  await f.importJson();
  const source = f.session.workspace.current!;
  const real = durableEditing.createEditorDurableEditing;
  const dispatches: ReturnType<typeof vi.fn>[] = [];
  const publications: ReturnType<typeof vi.fn>[] = [];
  const bridges = vi.spyOn(durableEditing, "createEditorDurableEditing").mockImplementation((options) => {
    // The workspace facade is frozen; observe its real publish through a
    // call-through view instead of trying to replace its owned method.
    const publish = vi.fn(options.workspace.publish.bind(options.workspace));
    publications.push(publish);
    const workspace = { get current() { return options.workspace.current; },
      publish, reload: options.workspace.reload.bind(options.workspace) };
    const result = real({ ...options, workspace });
    if (result.ok) {
      const dispatch = vi.fn(result.editing.dispatch.bind(result.editing));
      dispatches.push(dispatch);
      return { ok: true, editing: { dispatch, snapshot: result.editing.snapshot.bind(result.editing),
        undo: result.editing.undo.bind(result.editing), redo: result.editing.redo.bind(result.editing) } };
    }
    return result;
  });
  const geometry = { ...rectangleGeometry, opacity: 0.1, ignored: "not a command field" };
  const identity = { kind: "id" as const, id: "rectangle-captured" };
  f.deps.elementIdSource.mockReturnValue(identity);
  f.deps.revisionId.mockReturnValue("rectangle-revision");
  const flight = f.session.addRectangle(geometry);
  expect(f.deps.commandId).toHaveBeenCalledTimes(1);
  expect(f.deps.elementIdSource).toHaveBeenCalledTimes(1);
  expect(f.deps.revisionId).toHaveBeenCalledTimes(2);
  expect(f.deps.createdAt).toHaveBeenCalledTimes(2);
  geometry.x = 999; identity.id = "retargeted";
  f.deps.revisionId.mockReturnValue("retargeted");
  f.deps.createdAt.mockReturnValue(9999);
  await expect(flight).resolves.toBeUndefined();
  expect(bridges).toHaveBeenCalledTimes(1);
  expect(dispatches[0]).toHaveBeenCalledExactlyOnceWith({ commandSchemaVersion: 1,
    commandId: "image-command", documentId: "document-1", expectedRevision: 0,
    actorCapability: "human-ui", payload: { type: "create-element",
      element: { type: "shape", ...rectangleGeometry, opacity: 1 } } });
  const options = publications[0]!.mock.calls[0]![0];
  expect(options).toMatchObject({ documentId: "document-1", sequence: 2,
    expectedSource: { documentId: "document-1", revisionId: source.revision.revisionId } });
  expect(options.revisionId()).toBe("rectangle-revision");
  expect(options.createdAt()).toBe(1234);
  await expectDurable(f, "rectangle-revision", 2, appendedRectangle(documentAt(0.4), "rectangle-captured"));
  f.deps.elementIdSource.mockReturnValue({ kind: "id", id: "second-rectangle" });
  f.deps.revisionId.mockReturnValue("second-revision");
  f.deps.createdAt.mockReturnValue(1234);
  await f.session.addRectangle(rectangleGeometry);
  expect(bridges).toHaveBeenCalledTimes(2);
  expect(dispatches[1]!.mock.calls[0]![0]).toMatchObject({ expectedRevision: 0 });
  expect(f.session.workspace.current?.revision.sequence).toBe(3);
  expect(f.writeAsset).not.toHaveBeenCalled();
});

it.each(["missing", "foreign", "overflow", "released"])(
  "rectangle rejects %s current before geometry, IDs, time or persistence", async (kind) => {
    const f = fixture();
    if (kind !== "missing") {
      await f.session.workspace.publish({ documentId: kind === "foreign" ? "foreign" : "document-1",
        editableJson: JSON.stringify(documentAt(0.4)), revisionId: () => "source",
        sequence: kind === "overflow" ? Number.MAX_SAFE_INTEGER : 7, createdAt: () => 1234 });
      if (kind === "released") f.session.workspace.current!.release();
    }
    const before = f.session.workspace.current;
    const readGeometry = vi.fn(() => { throw new Error("geometry read"); });
    const geometry = Object.defineProperty({}, "x", { get: readGeometry });
    f.readPointers.mockClear(); f.writeRevision.mockClear();
    await expect(f.session.addRectangle(geometry as typeof rectangleGeometry)).rejects.toThrow();
    expect(f.session.workspace.current).toBe(before);
    expect(readGeometry).not.toHaveBeenCalled();
    for (const spy of [f.readPointers, f.writeRevision, f.deps.commandId, f.deps.elementIdSource,
      f.deps.revisionId, f.deps.createdAt]) expect(spy).not.toHaveBeenCalled();
  },
);

it.each([{ x: NaN }, { y: Infinity }, { width: 0 }, { width: Infinity }, { height: -1 }])(
  "rectangle rejects invalid geometry %j without metadata or writes", async (invalid) => {
    const f = fixture(); await f.importJson();
    const before = f.session.workspace.current;
    const pointers = await f.persistence.readPointers("document-1");
    f.writeRevision.mockClear(); f.deps.revisionId.mockClear(); f.deps.createdAt.mockClear();
    await expect(f.session.addRectangle({ ...rectangleGeometry, ...invalid })).rejects.toThrow();
    expect(f.session.workspace.current).toBe(before);
    expect(await f.persistence.readPointers("document-1")).toEqual(pointers);
    for (const spy of [f.writeRevision, f.deps.commandId, f.deps.elementIdSource,
      f.deps.revisionId, f.deps.createdAt]) expect(spy).not.toHaveBeenCalled();
  },
);

it("rectangle converts a real rejected command into failure, not unchanged-current success", async () => {
  const f = fixture(); await f.importJson();
  f.deps.elementIdSource.mockReturnValue({ kind: "id", id: "shape-1" });
  const before = f.session.workspace.current;
  const pointers = await f.persistence.readPointers("document-1");
  f.writeRevision.mockClear();
  await expect(f.session.addRectangle(rectangleGeometry)).rejects.toThrow();
  expect(f.writeRevision).not.toHaveBeenCalled();
  expect(f.session.workspace.current).toBe(before);
  expect(await f.persistence.readPointers("document-1")).toEqual(pointers);
});

it.each(["preparation", "conditional-write"])("rectangle preserves publication on %s failure", async (fault) => {
  const f = fixture(); await f.importJson();
  const before = f.session.workspace.current;
  const pointers = await f.persistence.readPointers("document-1");
  if (fault === "preparation") f.readPointers.mockRejectedValueOnce(new Error("prepare failed"));
  else f.writeRevision.mockRejectedValueOnce(new Error("write failed"));
  await expect(f.session.addRectangle(rectangleGeometry)).rejects.toThrow();
  expect(f.session.workspace.current).toBe(before);
  expect(await f.persistence.readPointers("document-1")).toEqual(pointers);
  expect(await f.persistence.readRevision("document-1", "revision-2")).toBeNull();
});

it("rectangle preserves a rich PNG current, bitmap leases and saved history; later imports use live sequence", async () => {
  const f = fixture();
  const document = documentAt(0.4);
  document.seed = 99; document.loop = false;
  document.playbackRange.startUs = 500_000;
  document.rootIds = ["group"];
  document.elements.push({ id: "group", type: "group", childrenIds: ["shape-1"] });
  const saved = createCompleteRevision({ documentId: "document-1", revisionId: "saved",
    sequence: 0, document });
  await f.persistence.writeCompleteRevision(saved, { saved: createSavedRevisionPointer(saved), draft: null });
  await f.importJson(document);
  await f.session.importWorkflow({ kind: "image-import",
    file: new File([bytes], "image.png", { type: "image/png" }) });
  const source = f.session.workspace.current!;
  const retained = source.workspace.images[0]!.handle as { close: ReturnType<typeof vi.fn> };
  const expected = appendedRectangle(source.revision.document, "rectangle-1");
  const assetBefore = await f.persistence.readAsset(await sha256(bytes));
  const decodes = f.decodePng.mock.calls.length;
  f.deps.elementIdSource.mockReturnValue({ kind: "id", id: "rectangle-1" });
  f.writeAsset.mockClear();
  await f.session.addRectangle(rectangleGeometry);
  const current = f.session.workspace.current!;
  expect(current.revision).toMatchObject({ sequence: 3, document: expected });
  expect(current.workspace.images[0]!.handle).toBe(retained);
  expect(f.decodePng.mock.calls.length).toBeGreaterThan(decodes);
  expect(retained.close).not.toHaveBeenCalled();
  for (const handle of f.handles) if (handle !== retained) expect(handle.close).toHaveBeenCalledTimes(1);
  expect(f.writeAsset).not.toHaveBeenCalled();
  expect(await f.persistence.readAsset(await sha256(bytes))).toEqual(assetBefore);
  expect(await f.persistence.readRevision("document-1", "saved")).toEqual(saved);
  expect((await f.persistence.readPointers("document-1")).saved).toEqual(createSavedRevisionPointer(saved));
  await f.importJson(documentAt(0.6));
  expect(f.session.workspace.current?.revision.sequence).toBe(4);
  expect(f.session.workspace.current?.workspace.images).toEqual([]);
  expect(retained.close).toHaveBeenCalledTimes(1); // Last image lease ended at JSON replacement.
  f.deps.elementIdSource.mockReturnValue({ kind: "id", id: "later-image" });
  await f.session.importWorkflow({ kind: "image-import",
    file: new File([bytes], "later.png", { type: "image/png" }) });
  expect(f.session.workspace.current?.revision.sequence).toBe(5);
  const laterRetained = f.session.workspace.current!.workspace.images[0]!.handle as { close: ReturnType<typeof vi.fn> };
  expect(laterRetained).not.toBe(retained);
  expect(laterRetained.close).not.toHaveBeenCalled();
  f.deps.elementIdSource.mockReturnValue({ kind: "id", id: "later-rectangle" });
  await f.session.addRectangle(rectangleGeometry);
  expect(f.session.workspace.current?.revision.sequence).toBe(6);
  expect(f.session.workspace.current?.workspace.images[0]!.handle).toBe(laterRetained);
  expect(laterRetained.close).not.toHaveBeenCalled();
  const beforeFailure = f.session.workspace.current;
  const pointers = await f.persistence.readPointers("document-1");
  f.deps.elementIdSource.mockReturnValue({ kind: "id", id: "failed-rectangle" });
  f.readAsset.mockRejectedValueOnce(new Error("referenced image fault"));
  await expect(f.session.addRectangle(rectangleGeometry)).rejects.toThrow();
  expect(f.session.workspace.current).toBe(beforeFailure);
  expect(await f.persistence.readPointers("document-1")).toEqual(pointers);
  expect(await f.persistence.readAsset(await sha256(bytes))).toEqual(assetBefore);
  expect(f.session.workspace.current?.workspace.images[0]!.handle).toBe(laterRetained);
  expect(laterRetained.close).not.toHaveBeenCalled();
  expect(retained.close).toHaveBeenCalledTimes(1);
  f.session.workspace.current!.release(); f.session.cache.clear();
  expect(new Set(f.handles).size).toBe(f.handles.length);
  for (const handle of f.handles) expect(handle.close).toHaveBeenCalledTimes(1);
});
