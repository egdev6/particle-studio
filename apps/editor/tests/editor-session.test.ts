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
