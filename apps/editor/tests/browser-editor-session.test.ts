import { afterEach, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { FIRST_SLICE_DOCUMENT } from "@particle-studio/scene-document";
import { createBrowserEditorSession, type BrowserCurrent } from "../src/browser-editor-session.js";
import type { EditorSession, ShapeDimensionsRequest, ShapeOpacityRequest } from "../src/editor-session.js";
import { renderEditorFrame, type EditorFrameContext } from "../src/editor-frame.js";

const mocks = vi.hoisted(() => ({ session: vi.fn(), persistence: vi.fn() }));
vi.mock("../src/editor-session.js", () => ({ createEditorSession: mocks.session }));
vi.mock("@particle-studio/persistence-indexeddb", () => ({
  createIndexedDbPersistenceAdapter: mocks.persistence,
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it.each([false, true])("waits for owned reload settlement before idempotent cleanup (reject=%s)", async (reject) => {
  const pending = deferred<unknown>();
  const release = vi.fn();
  const clear = vi.fn();
  const workspace: { current: null | { release: typeof release } } = { current: null };
  const readPointers = vi.fn(async () => ({ draft: {}, saved: null }));
  const reload = vi.fn(async () => {
    await pending.promise;
    workspace.current = { release };
    return workspace.current;
  });
  mocks.persistence.mockReturnValue({ readPointers });
  mocks.session.mockReturnValue({ workspace, cache: { clear }, reload });
  const browser = createBrowserEditorSession();
  const flight = browser.start();
  expect(browser.start()).toBe(flight);
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  const disposal = browser.dispose();
  expect(browser.disposed).toBe(true);
  expect(browser.dispose()).toBe(disposal);
  expect(release).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
  if (reject) pending.reject(new Error("read failed"));
  else pending.resolve(undefined);
  await expect(flight).resolves.toEqual({ kind: "disposed" });
  await disposal;
  expect(release).toHaveBeenCalledTimes(reject ? 0 : 1);
  expect(clear).toHaveBeenCalledTimes(1);
  expect(readPointers).toHaveBeenCalledTimes(1);
});

it.each([false, true])("owns actual workflow flight through disposal (reject=%s)", async (reject) => {
  const pending = deferred<unknown>();
  const release = vi.fn();
  const clear = vi.fn();
  const revision = { documentId: "browser-document", revisionId: "source", sequence: 7 };
  const previous = { revision, workspace: { images: [] }, release };
  const workspace = { current: previous };
  const importWorkflow = vi.fn(async () => {
    await pending.promise;
    workspace.current = { ...previous, revision: { ...revision, revisionId: "replacement" } };
  });
  mocks.persistence.mockReturnValue({ readPointers: async () => ({ draft: revision, saved: null }) });
  mocks.session.mockReturnValue({ workspace, cache: { clear }, reload: async () => previous, importWorkflow });
  const browser = createBrowserEditorSession();
  await expect(browser.importJson("early")).rejects.toThrow();
  await browser.start();
  const view = browser.current;
  expect(view).toEqual({ revision, images: [] });
  expect(Object.isFrozen(view)).toBe(true);
  const flight = browser.importJson("captured");
  await expect(browser.importJson("duplicate")).rejects.toThrow();
  expect(importWorkflow).toHaveBeenCalledExactlyOnceWith({ kind: "editable-json-import", editableJson: "captured" });
  expect(browser.current).toBe(view);
  const disposal = browser.dispose();
  expect(browser.dispose()).toBe(disposal);
  expect(browser.current).toBeNull();
  expect(clear).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  if (reject) pending.reject(new Error("publish failed"));
  else pending.resolve(undefined);
  if (reject) await expect(flight).rejects.toThrow("publish failed");
  else await expect(flight).resolves.toBeNull();
  await disposal;
  expect(clear).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
  await expect(browser.importJson("late")).rejects.toThrow();
  expect(importWorkflow).toHaveBeenCalledTimes(1);
});

it("captures the validated startup floor and blocks import after startup failure", async () => {
  const readPointers = vi.fn(async () => ({ saved: { sequence: 41 }, draft: null }));
  const importWorkflow = vi.fn(async () => undefined);
  mocks.persistence.mockReturnValue({ readPointers });
  mocks.session.mockReturnValue({ workspace: { current: null }, cache: { clear: vi.fn() }, importWorkflow });
  const browser = createBrowserEditorSession();
  const deps = mocks.session.mock.calls.at(-1)![0];
  expect(deps.jsonImportSequenceFloor()).toBe(0);
  await browser.start();
  const file = new File(["png"], "sample.png", { type: "image/png" });
  await expect(browser.importPng(file, { x: 0, y: 0, width: 64, height: 64 })).rejects.toThrow();
  expect(importWorkflow).not.toHaveBeenCalled();
  expect(deps.jsonImportSequenceFloor()).toBe(41);
  await browser.importJson("user JSON");
  expect(readPointers).toHaveBeenCalledTimes(1);
  await browser.dispose();
  readPointers.mockRejectedValue(new Error("corrupt"));
  const failed = createBrowserEditorSession();
  await expect(failed.start()).rejects.toThrow("corrupt");
  await expect(failed.importJson("blocked")).rejects.toThrow();
  await expect(failed.importPng(file, { x: 0, y: 0, width: 64, height: 64 })).rejects.toThrow();
  expect(importWorkflow).toHaveBeenCalledTimes(1);
  await failed.dispose();
});

// The test declares the forthcoming API without implementing it; runtime assertions must go RED.
type DimensionsBrowser = ReturnType<typeof createBrowserEditorSession> & {
  setShapeDimensions(request: ShapeDimensionsRequest): Promise<BrowserCurrent | null>;
};

// Real session/workflow/IDB below: only the platform bitmap boundary is substituted.
async function pngFixture() {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const adapter = await vi.importActual<typeof import("@particle-studio/persistence-indexeddb")>("@particle-studio/persistence-indexeddb");
  const real = await vi.importActual<typeof import("../src/editor-session.js")>("../src/editor-session.js");
  const persistence = adapter.createIndexedDbPersistenceAdapter({ databaseName: `browser-png-${crypto.randomUUID()}` });
  const readPointers = vi.spyOn(persistence, "readPointers");
  const writeAsset = vi.spyOn(persistence, "writeAsset");
  const readAsset = vi.spyOn(persistence, "readAsset");
  const writeRevision = vi.spyOn(persistence, "writeCompleteRevisionIfPointersMatch");
  const handles: { width: number; height: number; close: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal("createImageBitmap", vi.fn(async () => {
    const handle = { width: 2, height: 3, close: vi.fn() };
    handles.push(handle);
    return handle;
  }));
  mocks.persistence.mockReturnValue(persistence);
  mocks.session.mockImplementation(real.createEditorSession);
  const browser = createBrowserEditorSession() as DimensionsBrowser;
  const gate = deferred<ArrayBuffer>();
  const file = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
  const read = vi.spyOn(file, "arrayBuffer").mockReturnValue(gate.promise);
  const rectangle = { x: 12, y: 18, width: 64, height: 32 };
  const json = JSON.stringify(FIRST_SLICE_DOCUMENT);
  return { browser, persistence, readPointers, readAsset, writeAsset, writeRevision, handles, gate, file, read, rectangle, json };
}

it("guards PNG before file/asset work and captures geometry in the real shared workflow", async () => {
  const f = await pngFixture();
  await expect(f.browser.importPng(f.file, f.rectangle)).rejects.toThrow();
  await f.browser.start(); // No draft: the sample is never an image source.
  await expect(f.browser.importPng(f.file, f.rectangle)).rejects.toThrow("JSON");
  expect(f.read).not.toHaveBeenCalled();
  expect(f.writeAsset).not.toHaveBeenCalled();
  const jsonFlight = f.browser.importJson(f.json);
  await expect(f.browser.importPng(f.file, f.rectangle)).rejects.toThrow();
  await jsonFlight;
  const previous = f.browser.current;
  for (const rectangle of [{ ...f.rectangle, x: NaN }, { ...f.rectangle, y: Infinity },
    { ...f.rectangle, width: 0 }, { ...f.rectangle, height: -1 }]) {
    await expect(f.browser.importPng(f.file, rectangle)).rejects.toThrow("PLACEMENT");
  }
  expect(f.read).not.toHaveBeenCalled();
  const flight = f.browser.importPng(f.file, f.rectangle);
  f.rectangle.x = 200; f.rectangle.width = 1;
  await expect(f.browser.importJson("changed")).rejects.toThrow();
  await expect(f.browser.importPng(f.file, f.rectangle)).rejects.toThrow();
  expect(f.browser.current).toBe(previous);
  f.gate.resolve(new Uint8Array([1, 2, 3]).buffer);
  const current = await flight;
  expect(current).toBe(f.browser.current);
  expect(current?.revision.sequence).toBe(2);
  expect(current?.revision.document.elements.at(-1)).toMatchObject({ type: "image",
    x: 12, y: 18, width: 64, height: 32, opacity: 1,
    asset: { mimeType: "image/png", byteLength: 3, intrinsicWidth: 2, intrinsicHeight: 3 } });
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.writeAsset).toHaveBeenCalledTimes(1);
  expect(f.writeRevision).toHaveBeenCalledTimes(2);
  // Import stages one handle; publication verifies/decodes a distinct candidate.
  expect(f.handles).toHaveLength(2);
  expect(new Set(f.handles).size).toBe(2);
  expect(current?.images).toHaveLength(1);
  expect(current?.images[0]!.handle).toBe(f.handles[0]);
  expect(f.handles[0]!.close).not.toHaveBeenCalled();
  expect(f.handles[1]!.close).toHaveBeenCalledTimes(1); // Unowned duplicate.
  await f.browser.dispose();
  for (const handle of f.handles) expect(handle.close).toHaveBeenCalledTimes(1);
});

it.each([false, true])("waits for real PNG settlement, with no late borrowed view (reject=%s)", async (reject) => {
  const f = await pngFixture();
  await f.browser.start();
  await f.browser.importJson(f.json);
  const flight = f.browser.importPng(f.file, f.rectangle);
  const disposal = f.browser.dispose();
  expect(f.browser.dispose()).toBe(disposal);
  expect(f.browser.current).toBeNull();
  expect(f.writeAsset).not.toHaveBeenCalled();
  if (reject) f.gate.reject(new Error("file read fault"));
  else f.gate.resolve(new Uint8Array([1, 2, 3]).buffer);
  if (reject) await expect(flight).rejects.toThrow("FILE_READ_FAILED");
  else await expect(flight).resolves.toBeNull();
  await disposal;
  expect(f.writeRevision).toHaveBeenCalledTimes(reject ? 1 : 2);
  expect(f.handles).toHaveLength(reject ? 0 : 2);
  expect(new Set(f.handles).size).toBe(f.handles.length);
  for (const handle of f.handles) expect(handle.close).toHaveBeenCalledTimes(1);
  await expect(f.browser.importPng(f.file, f.rectangle)).rejects.toThrow();
  expect(f.read).toHaveBeenCalledTimes(1);
});

const blankDocument = { schemaVersion: 1, durationUs: 1_000_000,
  playbackRange: { startUs: 0, endUs: 1_000_000 }, loop: true, seed: 42,
  tracks: [], rootIds: ["root"], elements: [{ id: "root", type: "group", childrenIds: [] }] };

it.each([false, true])("creates an exact canonical blank through the real workflow (saved-only=%s)", async (saved) => {
  const f = await pngFixture();
  if (saved) {
    const { createCompleteRevision, createSavedRevisionPointer } = await import("@particle-studio/persistence");
    const row = createCompleteRevision({ documentId: "browser-document", revisionId: "saved-41",
      sequence: 41, document: FIRST_SLICE_DOCUMENT });
    await f.persistence.writeCompleteRevision(row, { saved: createSavedRevisionPointer(row), draft: null });
  }
  await expect(f.browser.createScene()).rejects.toThrow();
  expect(f.readPointers).not.toHaveBeenCalled(); expect(f.writeRevision).not.toHaveBeenCalled();
  await f.browser.start();
  const before = await f.persistence.readPointers("browser-document");
  expect(f.browser.current).toBeNull();
  const flight = f.browser.createScene();
  await expect(f.browser.createScene()).rejects.toThrow();
  await expect(f.browser.importJson(f.json)).rejects.toThrow();
  await expect(f.browser.importPng(f.file, f.rectangle)).rejects.toThrow();
  const current = await flight;
  expect(current).toBe(f.browser.current);
  expect(current?.revision.document).toEqual(blankDocument);
  expect(current?.revision.sequence).toBe(saved ? 42 : 1);
  expect(current?.images).toEqual([]);
  const pointers = await f.persistence.readPointers("browser-document");
  expect(pointers.saved).toEqual(before.saved);
  expect(pointers.draft).toMatchObject({ revisionId: current!.revision.revisionId, sequence: saved ? 42 : 1 });
  expect(await f.persistence.readRevision("browser-document", current!.revision.revisionId)).toEqual(current!.revision);
  if (saved) expect(await f.persistence.readRevision("browser-document", "saved-41")).toMatchObject({ sequence: 41, document: FIRST_SLICE_DOCUMENT });
  const reads = f.readPointers.mock.calls.length;
  const ids = vi.spyOn(crypto, "randomUUID");
  await expect(f.browser.createScene()).rejects.toThrow();
  expect(ids).not.toHaveBeenCalled(); expect(f.readPointers).toHaveBeenCalledTimes(reads);
  expect(f.browser.current).toBe(current);
  expect(f.writeRevision).toHaveBeenCalledTimes(1);
  expect(f.writeAsset).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.handles).toEqual([]);
  await f.browser.dispose();
  await expect(f.browser.createScene()).rejects.toThrow();
});

it.each([false, true])("creation owns shared workflow settlement, not cancellation (reject=%s)", async (reject) => {
  const pending = deferred<unknown>();
  const release = vi.fn(); const clear = vi.fn();
  const workspace: { current: unknown } = { current: null };
  const importWorkflow = vi.fn(async (_request: { kind: string; editableJson: string }) => {
    await pending.promise;
    workspace.current = { revision: { document: blankDocument }, workspace: { images: [] }, release };
  });
  const readPointers = vi.fn(async () => ({ saved: null, draft: null }));
  mocks.persistence.mockReturnValue({ readPointers });
  mocks.session.mockReturnValue({ workspace, cache: { clear }, importWorkflow });
  const browser = createBrowserEditorSession(); await browser.start();
  const flight = browser.createScene();
  expect(importWorkflow).toHaveBeenCalledTimes(1);
  expect(JSON.parse(importWorkflow.mock.calls[0]![0].editableJson)).toEqual(blankDocument);
  await expect(browser.importJson("retarget")).rejects.toThrow();
  const disposal = browser.dispose();
  expect(browser.dispose()).toBe(disposal);
  expect(clear).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
  if (reject) pending.reject(new Error("preparation failed")); else pending.resolve(undefined);
  if (reject) await expect(flight).rejects.toThrow("preparation failed");
  else await expect(flight).resolves.toBeNull();
  await disposal;
  expect(browser.current).toBeNull();
  expect(clear).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(reject ? 0 : 1);
  expect(readPointers).toHaveBeenCalledTimes(1);
});

it("rejects creation after failed startup and during a JSON flight before entering workflow", async () => {
  const f = await pngFixture(); await f.browser.start();
  const flight = f.browser.importJson(f.json);
  await expect(f.browser.createScene()).rejects.toThrow(); await flight;
  await f.browser.dispose();
  f.readPointers.mockRejectedValueOnce(new Error("corrupt"));
  const failed = createBrowserEditorSession();
  await expect(failed.start()).rejects.toThrow("corrupt");
  await expect(failed.createScene()).rejects.toThrow();
  expect(f.writeRevision).toHaveBeenCalledTimes(1);
  await failed.dispose();
});

it("does not start a reload after disposal during the initial pointer read", async () => {
  const pending = deferred<{ draft: object; saved: null }>();
  const reload = vi.fn();
  const clear = vi.fn();
  mocks.persistence.mockReturnValue({ readPointers: () => pending.promise });
  mocks.session.mockReturnValue({ workspace: { current: null }, cache: { clear }, reload });
  const browser = createBrowserEditorSession();
  const flight = browser.start();
  const disposal = browser.dispose();
  expect(clear).not.toHaveBeenCalled();
  pending.resolve({ draft: {}, saved: null });
  await expect(flight).resolves.toEqual({ kind: "disposed" });
  await disposal;
  expect(reload).not.toHaveBeenCalled();
  expect(clear).toHaveBeenCalledTimes(1);
});

it("real rectangle facade guards all four lanes and captures placement before native preparation", async () => {
  const f = await pngFixture();
  const ids = vi.spyOn(crypto, "randomUUID"); ids.mockClear();
  await expect(f.browser.addRectangle(f.rectangle)).rejects.toThrow();
  expect(ids).not.toHaveBeenCalled();
  await f.browser.start();
  await expect(f.browser.addRectangle(f.rectangle)).rejects.toThrow();
  expect(f.writeRevision).not.toHaveBeenCalled();
  const creation = f.browser.createScene();
  await expect(f.browser.addRectangle(f.rectangle)).rejects.toThrow();
  await creation;
  const previous = f.browser.current;
  for (const invalid of [{ x: NaN }, { y: Infinity }, { width: 0 }, { height: -1 }]) {
    ids.mockClear();
    await expect(f.browser.addRectangle({ ...f.rectangle, ...invalid })).rejects.toThrow();
    expect(ids).not.toHaveBeenCalled();
  }
  const realRead = f.persistence.readPointers.bind(f.persistence);
  const gate = deferred<Awaited<ReturnType<typeof realRead>>>();
  f.readPointers.mockImplementationOnce(() => gate.promise);
  const captured = { ...f.rectangle };
  const flight = f.browser.addRectangle(f.rectangle);
  f.rectangle.x = 200; f.rectangle.width = 1;
  await expect(f.browser.addRectangle(f.rectangle)).rejects.toThrow();
  await expect(f.browser.importJson(f.json)).rejects.toThrow();
  await expect(f.browser.importPng(f.file, f.rectangle)).rejects.toThrow();
  await expect(f.browser.createScene()).rejects.toThrow();
  expect(f.browser.current).toBe(previous);
  gate.resolve(await realRead("browser-document"));
  const current = await flight;
  expect(current).toBe(f.browser.current);
  expect(current?.revision.sequence).toBe(2);
  const id = current!.revision.document.elements.at(-1)!.id;
  expect(current?.revision.document).toEqual({ ...blankDocument,
    rootIds: ["root", id], elements: [...blankDocument.elements, { id, type: "shape", ...captured, opacity: 1 }] });
  expect(f.writeRevision).toHaveBeenCalledTimes(2);
  expect(f.writeAsset).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  const json = f.browser.importJson(f.json);
  await expect(f.browser.addRectangle(captured)).rejects.toThrow(); await json;
  const png = f.browser.importPng(f.file, captured);
  await expect(f.browser.addRectangle(captured)).rejects.toThrow();
  f.gate.resolve(new Uint8Array([1, 2, 3]).buffer); await png;
  expect(f.browser.current?.revision.sequence).toBe(4);
  await f.browser.dispose();
  ids.mockClear(); await expect(f.browser.addRectangle(captured)).rejects.toThrow();
  expect(ids).not.toHaveBeenCalled();
  for (const handle of f.handles) expect(handle.close).toHaveBeenCalledTimes(1);
});

it.each([false, true])("real rectangle owns image preparation until disposal settles (reject=%s)", async (reject) => {
  const f = await pngFixture(); await f.browser.start(); await f.browser.importJson(f.json);
  f.gate.resolve(new Uint8Array([1, 2, 3]).buffer);
  await f.browser.importPng(f.file, f.rectangle);
  const image = f.browser.current!.images[0]!;
  const retained = image.handle as { close: ReturnType<typeof vi.fn> };
  const asset = await f.persistence.readAsset(image.sha256);
  const gate = deferred<typeof asset>();
  const read = f.readAsset.mockClear().mockImplementationOnce(() => gate.promise);
  const flight = f.browser.addRectangle(f.rectangle);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  const disposal = f.browser.dispose();
  expect(f.browser.dispose()).toBe(disposal);
  expect(f.browser.current).toBeNull(); expect(retained.close).not.toHaveBeenCalled();
  if (reject) gate.reject(new Error("image preparation failed"));
  else gate.resolve(asset);
  if (reject) await expect(flight).rejects.toThrow();
  else await expect(flight).resolves.toBeNull();
  await disposal;
  expect(f.browser.current).toBeNull();
  expect(f.writeRevision).toHaveBeenCalledTimes(reject ? 2 : 3);
  expect(f.writeAsset).toHaveBeenCalledTimes(1);
  for (const handle of f.handles) expect(handle.close).toHaveBeenCalledTimes(1);
});

it.each([false, true])("real position captures source once and owns all five lanes through disposal (reject=%s)", async (reject) => {
  const f = await pngFixture(); expect(typeof f.browser.setShapePosition).toBe("function");
  const input = { documentId: "browser-document", revisionId: "early", elementId: "shape-1", x: -2.5, y: 7.25 };
  await expect(f.browser.setShapePosition(input)).rejects.toThrow();
  await f.browser.start(); await expect(f.browser.setShapePosition(input)).rejects.toThrow();
  await f.browser.importJson(f.json); f.gate.resolve(new Uint8Array([1, 2, 3]).buffer);
  await f.browser.importPng(f.file, f.rectangle);
  const source = f.browser.current!; input.revisionId = source.revision.revisionId;
  const retained = source.images[0]!.handle as { close: ReturnType<typeof vi.fn> };
  const asset = await f.persistence.readAsset(source.images[0]!.sha256);
  const gate = deferred<typeof asset>(); f.readAsset.mockClear().mockImplementationOnce(() => gate.promise);
  const reads: string[] = []; const capturedRequest = { ...input };
  for (const key of Object.keys(input) as (keyof typeof input)[]) {
    Object.defineProperty(capturedRequest, key, { get() { reads.push(key); return input[key]; } });
  }
  const flight = f.browser.setShapePosition(capturedRequest);
  input.x = 999; input.y = 999; input.documentId = "foreign";
  input.revisionId = "late"; input.elementId = source.revision.document.elements.at(-1)!.id;
  await vi.waitFor(() => expect(f.readAsset).toHaveBeenCalledTimes(1));
  for (const action of [() => f.browser.setShapePosition(input), () => f.browser.addRectangle(f.rectangle),
    () => f.browser.importJson(f.json), () => f.browser.importPng(f.file, f.rectangle), () => f.browser.createScene()]) {
    await expect(action()).rejects.toThrow();
  }
  expect(f.browser.current).toBe(source);
  const disposal = f.browser.dispose(); expect(f.browser.dispose()).toBe(disposal);
  expect(f.browser.current).toBeNull(); expect(retained.close).not.toHaveBeenCalled();
  if (reject) gate.reject(new Error("position image fault")); else gate.resolve(asset);
  if (reject) await expect(flight).rejects.toThrow(); else await expect(flight).resolves.toBeNull();
  await disposal;
  const pointers = await f.persistence.readPointers("browser-document");
  const row = await f.persistence.readRevision("browser-document", pointers.draft!.revisionId);
  const expected = structuredClone(source.revision.document);
  if (!reject) Object.assign(expected.elements.find((element) => element.id === "shape-1")!, { x: -2.5, y: 7.25 });
  expect(row?.document).toEqual(expected); expect(row?.sequence).toBe(reject ? 2 : 3);
  expect(reads.sort()).toEqual(Object.keys(input).sort());
  expect(f.writeAsset).toHaveBeenCalledTimes(1); expect(f.writeRevision).toHaveBeenCalledTimes(reject ? 2 : 3);
  expect(new Set(f.handles).size).toBe(f.handles.length);
  for (const handle of f.handles) expect(handle.close).toHaveBeenCalledTimes(1);
  await expect(f.browser.setShapePosition(input)).rejects.toThrow();
});

it("position metadata gates reject stale sources before UUID/I/O and recover the real shared lane", async () => {
  const f = await pngFixture(); await f.browser.start(); await f.browser.importJson(f.json);
  expect(typeof f.browser.setShapePosition).toBe("function");
  const source = f.browser.current!;
  const input = { documentId: source.revision.documentId, revisionId: source.revision.revisionId,
    elementId: "shape-1", x: -2.5, y: 7.25 };
  const ids = vi.spyOn(crypto, "randomUUID"); ids.mockClear(); f.readPointers.mockClear();
  for (const invalid of [{ documentId: "foreign" }, { revisionId: "old" }, { elementId: "absent" }, { x: NaN }, { y: Infinity }]) {
    await expect(f.browser.setShapePosition({ ...input, ...invalid })).rejects.toThrow();
  }
  expect(ids).not.toHaveBeenCalled(); expect(f.readPointers).not.toHaveBeenCalled();
  expect(f.browser.current).toBe(source);
  const json = f.browser.importJson(f.json);
  await expect(f.browser.setShapePosition(input)).rejects.toThrow(); await json;
  await expect(f.browser.setShapePosition(input)).rejects.toThrow();
  const current = f.browser.current!;
  const next = await f.browser.setShapePosition({ ...input, revisionId: current.revision.revisionId });
  expect(next).toBe(f.browser.current); expect(next?.revision.sequence).toBe(3);
  expect(next?.revision.document.elements.find((element) => element.id === "shape-1")).toMatchObject({ x: -2.5, y: 7.25 });
  expect(Object.isFrozen(next)).toBe(true); expect(next).not.toHaveProperty("release");
  await f.browser.dispose();
});

it("position rejects corrupt startup before caller getters, UUIDs or additional I/O", async () => {
  const f = await pngFixture(); f.readPointers.mockRejectedValueOnce(new Error("corrupt"));
  await expect(f.browser.start()).rejects.toThrow("corrupt");
  const read = vi.fn(() => { throw new Error("caller input read"); });
  const input = Object.defineProperty({ documentId: "browser-document", revisionId: "source", elementId: "shape-1", x: 1, y: 2 },
    "x", { get: read });
  const ids = vi.spyOn(crypto, "randomUUID"); ids.mockClear(); f.readPointers.mockClear();
  await expect(f.browser.setShapePosition(input)).rejects.toThrow(/EDITOR_SHAPE_POSITION_/);
  expect(read).not.toHaveBeenCalled(); expect(ids).not.toHaveBeenCalled();
  for (const spy of [f.readPointers, f.readAsset, f.writeAsset, f.writeRevision]) expect(spy).not.toHaveBeenCalled();
  expect(f.browser.current).toBeNull(); await f.browser.dispose();
});

it("rectangle fails closed after corrupt startup before reading geometry", async () => {
  const f = await pngFixture();
  f.readPointers.mockRejectedValueOnce(new Error("corrupt"));
  await expect(f.browser.start()).rejects.toThrow("corrupt");
  const readGeometry = vi.fn(() => { throw new Error("read geometry"); });
  const geometry = Object.defineProperty({}, "x", { get: readGeometry });
  await expect(f.browser.addRectangle(geometry as typeof f.rectangle)).rejects.toThrow();
  expect(readGeometry).not.toHaveBeenCalled();
  expect(f.writeRevision).not.toHaveBeenCalled(); expect(f.writeAsset).not.toHaveBeenCalled();
  await f.browser.dispose();
});

it("dimensions freezes five read-once scalars before the owned action callback and returns actual current", async () => {
  const pending = deferred<void>(); const release = vi.fn(); const clear = vi.fn();
  const revision = { documentId: "browser-document", revisionId: "source", sequence: 1, document: FIRST_SLICE_DOCUMENT };
  const previous = { revision, workspace: { images: [] }, release }; const workspace = { current: previous };
  const input = { documentId: revision.documentId, revisionId: revision.revisionId, elementId: "shape-1", width: 9, height: 13 };
  const expected = { ...input }; const reads: string[] = [];
  const request = { ...input };
  for (const key of Object.keys(input) as (keyof typeof input)[]) {
    Object.defineProperty(request, key, { get() { reads.push(key); return input[key]; } });
  }
  const setShapeDimensions = vi.fn(async (captured: typeof input) => {
    expect(captured).toEqual(expected); expect(Object.isFrozen(captured)).toBe(true);
    expect(reads).toEqual(Object.keys(input)); // Before any callback mutation or await.
    Object.assign(input, { documentId: "foreign", revisionId: "late", elementId: "reused", width: 999, height: 999 });
    await expect(browser.setShapeDimensions(input)).rejects.toThrow(); // SDK callback cannot reenter the owned lane.
    await pending.promise;
    expect(captured).toEqual(expected);
    workspace.current = { ...previous, revision: { ...revision, revisionId: "actual", sequence: 2 } };
  });
  mocks.persistence.mockReturnValue({ readPointers: async () => ({ draft: revision, saved: null }) });
  mocks.session.mockReturnValue({ workspace, cache: { clear }, reload: async () => previous, setShapeDimensions });
  const browser = createBrowserEditorSession() as DimensionsBrowser; await browser.start();
  expect(typeof browser.setShapeDimensions).toBe("function");
  const flight = browser.setShapeDimensions(request); expect(browser.current?.revision).toBe(revision);
  pending.resolve(); const next = await flight;
  expect(next).toBe(browser.current); expect(next?.revision).toBe(workspace.current.revision);
  expect(next?.revision.revisionId).toBe("actual"); expect(next).not.toHaveProperty("release");
  expect(reads).toEqual(Object.keys(input)); expect(setShapeDimensions).toHaveBeenCalledTimes(1);
  await browser.dispose(); expect(release).toHaveBeenCalledTimes(1); expect(clear).toHaveBeenCalledTimes(1);
});

it.each([false, true])("real dimensions owns all six lanes and bitmap settlement (reject=%s)", async (reject) => {
  const f = await pngFixture(); await f.browser.start(); await f.browser.importJson(f.json);
  f.gate.resolve(new Uint8Array([1, 2, 3]).buffer); await f.browser.importPng(f.file, f.rectangle);
  expect(typeof f.browser.setShapeDimensions).toBe("function");
  const source = f.browser.current!;
  const input = { documentId: source.revision.documentId, revisionId: source.revision.revisionId,
    elementId: "shape-1", width: 9.5, height: 13.25 };
  const asset = await f.persistence.readAsset(source.images[0]!.sha256);
  const gate = deferred<typeof asset>(); f.readAsset.mockClear().mockImplementationOnce(() => gate.promise);
  const flight = f.browser.setShapeDimensions(input);
  Object.assign(input, { documentId: "foreign", revisionId: "late", elementId: source.revision.document.elements.at(-1)!.id, width: 999, height: 999 });
  await vi.waitFor(() => expect(f.readAsset).toHaveBeenCalledTimes(1));
  for (const action of [() => f.browser.setShapeDimensions(input), () => f.browser.setShapePosition({ ...input, x: 1, y: 2 }),
    () => f.browser.addRectangle(f.rectangle), () => f.browser.importJson(f.json),
    () => f.browser.importPng(f.file, f.rectangle), () => f.browser.createScene()]) await expect(action()).rejects.toThrow();
  expect(f.browser.current).toBe(source);
  const disposal = f.browser.dispose(); expect(f.browser.dispose()).toBe(disposal); expect(f.browser.current).toBeNull();
  const retained = source.images[0]!.handle as { close: ReturnType<typeof vi.fn> };
  expect(retained.close).not.toHaveBeenCalled();
  if (reject) gate.reject(new Error("dimensions image fault")); else gate.resolve(asset);
  if (reject) await expect(flight).rejects.toThrow(); else await expect(flight).resolves.toBeNull();
  await disposal;
  const pointers = await f.persistence.readPointers("browser-document");
  const row = await f.persistence.readRevision("browser-document", pointers.draft!.revisionId);
  const expected = structuredClone(source.revision.document);
  if (!reject) Object.assign(expected.elements.find((element) => element.id === "shape-1")!, { width: 9.5, height: 13.25 });
  expect(row?.document).toEqual(expected); expect(row?.sequence).toBe(reject ? 2 : 3);
  expect(f.writeAsset).toHaveBeenCalledTimes(1); expect(f.writeRevision).toHaveBeenCalledTimes(reject ? 2 : 3);
  expect(new Set(f.handles).size).toBe(f.handles.length);
  for (const handle of f.handles) expect(handle.close).toHaveBeenCalledTimes(1);
  await expect(f.browser.setShapeDimensions(input)).rejects.toThrow();
});

it("dimensions guards reject before effects, preserve current, and recover after same-source failure", async () => {
  const f = await pngFixture(); await f.browser.start();
  const scene = { ...FIRST_SLICE_DOCUMENT, rootIds: [...FIRST_SLICE_DOCUMENT.rootIds, "group-1"],
    elements: [...FIRST_SLICE_DOCUMENT.elements, { id: "group-1", type: "group" as const, childrenIds: [] }] };
  await f.browser.importJson(JSON.stringify(scene));
  expect(typeof f.browser.setShapeDimensions).toBe("function"); const source = f.browser.current!;
  const input = { documentId: source.revision.documentId, revisionId: source.revision.revisionId, elementId: "shape-1", width: 9, height: 13 };
  const ids = vi.spyOn(crypto, "randomUUID"); ids.mockClear(); f.readPointers.mockClear();
  for (const invalid of [{ documentId: "foreign" }, { revisionId: "old" }, { elementId: "absent" },
    { elementId: source.revision.document.elements.find((element) => element.type !== "shape")!.id },
    { width: NaN }, { height: Infinity }, { width: 0 }, { height: -1 }]) {
    await expect(f.browser.setShapeDimensions({ ...input, ...invalid })).rejects.toThrow();
  }
  expect(ids).not.toHaveBeenCalled(); expect(f.readPointers).not.toHaveBeenCalled(); expect(f.browser.current).toBe(source);
  f.readPointers.mockRejectedValueOnce(new Error("preparation failed"));
  await expect(f.browser.setShapeDimensions(input)).rejects.toThrow(); expect(f.browser.current).toBe(source);
  const next = await f.browser.setShapeDimensions(input); expect(next).toBe(f.browser.current); expect(next?.revision.sequence).toBe(2);
  await expect(f.browser.setShapeDimensions(input)).rejects.toThrow(); await f.browser.dispose();
});

it("dimensions publishes actual current before a real frame failure; rendering cannot roll it back", async () => {
  const f = await pngFixture(); await f.browser.start(); await f.browser.importJson(f.json);
  const source = f.browser.current!; expect(typeof f.browser.setShapeDimensions).toBe("function");
  const next = await f.browser.setShapeDimensions({ documentId: source.revision.documentId, revisionId: source.revision.revisionId,
    elementId: "shape-1", width: 9, height: 13 });
  const clearRect = vi.fn(() => { throw new Error("render fault after commit"); });
  expect(() => renderEditorFrame({ clearRect } as unknown as EditorFrameContext,
    next!.revision.document, next!.images, 0, { width: 320, height: 160 })).toThrow("render fault after commit");
  expect(clearRect).toHaveBeenCalledTimes(1); expect(f.browser.current).toBe(next);
  expect(next?.revision.document.elements.find((element) => element.id === "shape-1")).toMatchObject({ width: 9, height: 13 });
  const pointers = await f.persistence.readPointers("browser-document");
  expect(await f.persistence.readRevision("browser-document", pointers.draft!.revisionId)).toEqual(next!.revision);
  await f.browser.dispose();
});

it.each([false, true])("dimensions rejects unavailable startup before reading caller getters (corrupt=%s)", async (corrupt) => {
  const f = await pngFixture();
  if (corrupt) { f.readPointers.mockRejectedValueOnce(new Error("corrupt")); await expect(f.browser.start()).rejects.toThrow("corrupt"); }
  expect(typeof f.browser.setShapeDimensions).toBe("function");
  const get = vi.fn(() => { throw new Error("caller getter"); });
  const input = Object.defineProperty({ documentId: "browser-document", revisionId: "source", elementId: "shape-1", width: 1, height: 2 }, "width", { get });
  const ids = vi.spyOn(crypto, "randomUUID"); ids.mockClear(); f.readPointers.mockClear();
  await expect(f.browser.setShapeDimensions(input)).rejects.toThrow(/EDITOR_SHAPE_DIMENSIONS_/);
  expect(get).not.toHaveBeenCalled(); expect(ids).not.toHaveBeenCalled(); expect(f.readPointers).not.toHaveBeenCalled();
  expect(f.writeRevision).not.toHaveBeenCalled(); await f.browser.dispose();
});

// Only the anticipated public type is supplied; the missing runtime API is the RED.
type OpacityBrowser = ReturnType<typeof createBrowserEditorSession> & {
  setShapeOpacity(request: ShapeOpacityRequest): Promise<BrowserCurrent | null>;
};
const opacityOrigins = ["json", "blank", "png", "rectangle", "position", "dimensions", "opacity"] as const;

it("opacity captures four getters once, frozen before SDK callbacks and owned-lane reentry", async () => {
  const pending = deferred<void>(); const release = vi.fn(); const clear = vi.fn();
  const revision = { documentId: "browser-document", revisionId: "source", sequence: 1, document: FIRST_SLICE_DOCUMENT };
  const previous = { revision, workspace: { images: [] }, release }; const workspace = { current: previous };
  const input = { documentId: revision.documentId, revisionId: revision.revisionId, elementId: "shape-1", opacity: 0.25 };
  const expected = { ...input }; const reads: string[] = []; const request = { ...input };
  for (const key of Object.keys(input) as (keyof typeof input)[]) {
    Object.defineProperty(request, key, { get() { reads.push(key); return input[key]; } });
  }
  const setShapeOpacity = vi.fn(async (captured: ShapeOpacityRequest) => {
    expect(captured).toEqual(expected); expect(Object.isFrozen(captured)).toBe(true); expect(reads).toEqual(Object.keys(input));
    Object.assign(input, { documentId: "foreign", revisionId: "late", elementId: "root", opacity: 1 });
    await expect(browser.setShapeOpacity(input)).rejects.toThrow("UNAVAILABLE");
    await pending.promise; expect(captured).toEqual(expected);
    workspace.current = { ...previous, revision: { ...revision, revisionId: "actual", sequence: 2 } };
  });
  mocks.persistence.mockReturnValue({ readPointers: async () => ({ draft: revision, saved: null }) });
  mocks.session.mockReturnValue({ workspace, cache: { clear }, reload: async () => previous, setShapeOpacity });
  const browser = createBrowserEditorSession() as OpacityBrowser; await browser.start();
  expect(typeof browser.setShapeOpacity).toBe("function"); const flight = browser.setShapeOpacity(request);
  pending.resolve(); const next = await flight;
  expect(next).toBe(browser.current); expect(next?.revision).toBe(workspace.current.revision);
  expect(Object.isFrozen(next)).toBe(true); expect(next).not.toHaveProperty("release"); expect(next).not.toHaveProperty("cache");
  expect(reads).toEqual(Object.keys(input)); expect(setShapeOpacity).toHaveBeenCalledTimes(1);
  await browser.dispose(); expect(release).toHaveBeenCalledTimes(1); expect(clear).toHaveBeenCalledTimes(1);
});

it.each(opacityOrigins)("real held %s owns the lane against all seven direct actions", async (origin) => {
  const f = await pngFixture(); const browser = f.browser as OpacityBrowser; await browser.start();
  if (origin !== "blank") {
    await browser.importJson(f.json); f.gate.resolve(new Uint8Array([1, 2, 3]).buffer);
    await browser.importPng(f.file, f.rectangle);
  }
  expect(typeof browser.setShapeOpacity).toBe("function"); const source = browser.current;
  const input = { documentId: "browser-document", revisionId: source?.revision.revisionId ?? "absent", elementId: "shape-1", opacity: 0.25 };
  const actions = {
    json: () => browser.importJson(f.json), blank: () => browser.createScene(),
    png: () => browser.importPng(f.file, f.rectangle), rectangle: () => browser.addRectangle(f.rectangle),
    position: () => browser.setShapePosition({ ...input, x: 1, y: 2 }),
    dimensions: () => browser.setShapeDimensions({ ...input, width: 9, height: 13 }), opacity: () => browser.setShapeOpacity(input),
  };
  const realRead = f.persistence.readPointers.bind(f.persistence);
  const prior = await realRead("browser-document"); const gate = deferred<typeof prior>();
  f.readPointers.mockClear().mockImplementationOnce(() => gate.promise);
  const flight = actions[origin]();
  if (origin === "opacity") Object.assign(input, { documentId: "foreign", revisionId: "late", elementId: "root", opacity: 1 });
  await vi.waitFor(() => expect(f.readPointers).toHaveBeenCalledTimes(1));
  for (const name of opacityOrigins) await expect(actions[name]()).rejects.toThrow();
  const get = vi.fn(() => { throw new Error("busy getter"); });
  await expect(browser.setShapeOpacity(Object.defineProperty({ ...input }, "opacity", { get }))).rejects.toThrow("UNAVAILABLE");
  expect(get).not.toHaveBeenCalled(); expect(browser.current).toBe(source); expect(await realRead("browser-document")).toEqual(prior);
  gate.resolve(prior); const next = await flight; expect(next).toBe(browser.current);
  expect(next?.revision.sequence).toBe((source?.revision.sequence ?? 0) + 1);
  if (origin === "opacity") expect(next?.revision.document.elements.find((element) => element.id === "shape-1")).toMatchObject({ opacity: 0.25 });
  await browser.dispose(); for (const handle of f.handles) expect(handle.close).toHaveBeenCalledTimes(1);
});

it.each(["early", "absent", "corrupt", "disposed"])("opacity unavailable %s rejects before caller getters or effects", async (state) => {
  const f = await pngFixture(); const browser = f.browser as OpacityBrowser;
  if (state === "corrupt") { f.readPointers.mockRejectedValueOnce(new Error("corrupt")); await expect(browser.start()).rejects.toThrow("corrupt"); }
  if (state === "absent" || state === "disposed") await browser.start();
  if (state === "disposed") await browser.dispose();
  expect(typeof browser.setShapeOpacity).toBe("function"); const get = vi.fn(() => { throw new Error("caller getter"); });
  const input = Object.defineProperty({ documentId: "browser-document", revisionId: "source", elementId: "shape-1", opacity: 1 }, "opacity", { get });
  const ids = vi.spyOn(crypto, "randomUUID"); ids.mockClear(); f.readPointers.mockClear();
  await expect(browser.setShapeOpacity(input)).rejects.toThrow("EDITOR_SHAPE_OPACITY_UNAVAILABLE");
  expect(get).not.toHaveBeenCalled(); expect(ids).not.toHaveBeenCalled();
  for (const spy of [f.readPointers, f.readAsset, f.writeAsset, f.writeRevision]) expect(spy).not.toHaveBeenCalled();
  expect(browser.current).toBeNull(); await browser.dispose();
});

it("real opacity rejects malformed/source/type/range requests before effects and recovers with 0/-0/fraction/1/equal", async () => {
  const f = await pngFixture(); const browser = f.browser as OpacityBrowser; await browser.start();
  const cloned = structuredClone(FIRST_SLICE_DOCUMENT);
  const group = { id: "opacity-guard-group", type: "group" as const, childrenIds: [], transform: [1, 0, 0, 1, 0, 0] };
  expect(cloned.elements.some((element) => element.id === group.id)).toBe(false);
  const document = { ...cloned, rootIds: [...cloned.rootIds, group.id], elements: [...cloned.elements, group] };
  Object.assign(document.elements.find((element) => element.id === "shape-1")!, { opacity: -0.25 });
  await browser.importJson(JSON.stringify(document)); expect(typeof browser.setShapeOpacity).toBe("function");
  const source = browser.current!; const input = { documentId: source.revision.documentId, revisionId: source.revision.revisionId, elementId: "shape-1", opacity: 0.25 };
  expect(source.revision.document.elements.find((element) => element.type !== "shape")).toEqual(group);
  const get = vi.fn(() => { throw new Error("caller getter"); });
  const malformed: unknown[] = [null, undefined, [], 1, "request", Object.defineProperty({ ...input }, "opacity", { get })];
  const ids = vi.spyOn(crypto, "randomUUID"); ids.mockClear(); f.readPointers.mockClear();
  for (const request of malformed) await expect(browser.setShapeOpacity(request as ShapeOpacityRequest)).rejects.toThrow("EDITOR_SHAPE_OPACITY_INPUT_INVALID");
  expect(get).toHaveBeenCalledTimes(1);
  for (const invalid of [{ documentId: "foreign" }, { revisionId: "old" }, { elementId: "absent" },
    { elementId: source.revision.document.elements.find((element) => element.type !== "shape")!.id },
    { opacity: -0.25 }, { opacity: 2 }, { opacity: NaN }, { opacity: Infinity }]) await expect(browser.setShapeOpacity({ ...input, ...invalid })).rejects.toThrow();
  expect(ids).not.toHaveBeenCalled(); expect(f.readPointers).not.toHaveBeenCalled(); expect(browser.current).toBe(source);
  expect(f.readAsset).not.toHaveBeenCalled(); expect(f.writeAsset).not.toHaveBeenCalled(); expect(f.writeRevision).toHaveBeenCalledTimes(1);
  f.readPointers.mockRejectedValueOnce(new Error("preparation failed"));
  await expect(browser.setShapeOpacity(input)).rejects.toThrow(); expect(browser.current).toBe(source);
  let sequence = source.revision.sequence;
  for (const opacity of [0, -0, 0.25, 1, 1]) {
    const before = browser.current!; const expected = structuredClone(before.revision.document);
    Object.assign(expected.elements.find((element) => element.id === "shape-1")!, { opacity: opacity === 0 ? 0 : opacity });
    const next = await browser.setShapeOpacity({ ...input, revisionId: before.revision.revisionId, opacity });
    expect(next).toBe(browser.current); expect(next?.revision.document).toEqual(expected); expect(next?.revision.sequence).toBe(++sequence);
    expect(next?.revision.revisionId).not.toBe(before.revision.revisionId);
  }
  await expect(browser.setShapeOpacity(input)).rejects.toThrow();
  const session = mocks.session.mock.results.at(-1)!.value as EditorSession;
  const releasedRevisionId = browser.current!.revision.revisionId;
  session.workspace.current!.release(); ids.mockClear(); f.readPointers.mockClear();
  expect(browser.current).toBeNull();
  await expect(browser.setShapeOpacity({ ...input, revisionId: releasedRevisionId })).rejects.toThrow("EDITOR_SHAPE_OPACITY_UNAVAILABLE");
  expect(ids).not.toHaveBeenCalled(); expect(f.readPointers).not.toHaveBeenCalled(); await browser.dispose();
});

it.each([false, true])("real opacity disposal awaits bitmap preparation and closes each identity once (reject=%s)", async (reject) => {
  const f = await pngFixture(); const browser = f.browser as OpacityBrowser; await browser.start(); await browser.importJson(f.json);
  f.gate.resolve(new Uint8Array([1, 2, 3]).buffer); await browser.importPng(f.file, f.rectangle);
  expect(typeof browser.setShapeOpacity).toBe("function"); const source = browser.current!;
  const input = { documentId: source.revision.documentId, revisionId: source.revision.revisionId, elementId: "shape-1", opacity: 0 };
  const asset = await f.persistence.readAsset(source.images[0]!.sha256); const gate = deferred<typeof asset>();
  f.readAsset.mockClear().mockImplementationOnce(() => gate.promise); const flight = browser.setShapeOpacity(input);
  await vi.waitFor(() => expect(f.readAsset).toHaveBeenCalledTimes(1)); let settled = false;
  const disposal = browser.dispose(); void disposal.then(() => { settled = true; });
  expect(browser.dispose()).toBe(disposal); expect(browser.current).toBeNull(); await Promise.resolve(); expect(settled).toBe(false);
  const retained = source.images[0]!.handle as { close: ReturnType<typeof vi.fn> }; expect(retained.close).not.toHaveBeenCalled();
  if (reject) gate.reject(new Error("opacity image fault")); else gate.resolve(asset);
  if (reject) await expect(flight).rejects.toThrow(); else await expect(flight).resolves.toBeNull();
  await disposal; expect(settled).toBe(true); expect(browser.current).toBeNull();
  const pointers = await f.persistence.readPointers("browser-document");
  const row = await f.persistence.readRevision("browser-document", pointers.draft!.revisionId);
  const expected = structuredClone(source.revision.document);
  if (!reject) Object.assign(expected.elements.find((element) => element.id === "shape-1")!, { opacity: 0 });
  expect(row?.document).toEqual(expected); expect(row?.sequence).toBe(reject ? 2 : 3);
  expect(f.writeAsset).toHaveBeenCalledTimes(1); expect(f.writeRevision).toHaveBeenCalledTimes(reject ? 2 : 3);
  expect(new Set(f.handles).size).toBe(f.handles.length);
  for (const handle of f.handles) expect(handle.close).toHaveBeenCalledTimes(1);
  await expect(browser.setShapeOpacity(input)).rejects.toThrow("UNAVAILABLE");
});

import { describe } from "vitest";

describe("browser shape fill color API", () => {
  type FillColorRequest = { readonly documentId: string; readonly revisionId: string; readonly elementId: string; readonly fillColor: string };
  type FillColorBrowser = ReturnType<typeof createBrowserEditorSession>;

  it("fill color captures four getters once, frozen before SDK callbacks and owned-lane reentry", async () => {
    const pending = deferred<void>(); const release = vi.fn(); const clear = vi.fn();
    const revision = { documentId: "browser-document", revisionId: "source", sequence: 1, document: FIRST_SLICE_DOCUMENT };
    const previous = { revision, workspace: { images: [] }, release }; const workspace = { current: previous };
    const input = { documentId: revision.documentId, revisionId: revision.revisionId, elementId: "shape-1", fillColor: "#3fa9f5" };
    const expected = { ...input }; const reads: string[] = []; const request = { ...input };
    for (const key of Object.keys(input) as (keyof typeof input)[]) Object.defineProperty(request, key, { get() { reads.push(key); return input[key]; } });
    const setShapeFillColor = vi.fn(async (captured: FillColorRequest) => {
      expect(captured).toEqual(expected); expect(Object.isFrozen(captured)).toBe(true); expect(reads).toEqual(Object.keys(input));
      Object.assign(input, { documentId: "foreign", revisionId: "late", elementId: "root", fillColor: "#000000" });
      await expect(browser.setShapeFillColor(input)).rejects.toThrow("UNAVAILABLE");
      await pending.promise; expect(captured).toEqual(expected);
      workspace.current = { ...previous, revision: { ...revision, revisionId: "actual", sequence: 2 } };
    });
    mocks.persistence.mockReturnValue({ readPointers: async () => ({ draft: revision, saved: null }) });
    mocks.session.mockReturnValue({ workspace, cache: { clear }, reload: async () => previous, setShapeFillColor });
    const browser = createBrowserEditorSession() as FillColorBrowser; await browser.start();
    expect(typeof browser.setShapeFillColor).toBe("function"); const flight = browser.setShapeFillColor(request);
    pending.resolve(); const next = await flight;
    expect(next).toBe(browser.current); expect(next?.revision).toBe(workspace.current.revision);
    expect(reads).toEqual(Object.keys(input)); expect(setShapeFillColor).toHaveBeenCalledTimes(1);
    await browser.dispose(); expect(release).toHaveBeenCalledTimes(1); expect(clear).toHaveBeenCalledTimes(1);
  });

  it.each(["not-ready", "busy", "disposed"])("fill color unavailable %s rejects before caller getters or effects", async (state) => {
    const f = await pngFixture(); const browser = f.browser as FillColorBrowser; let busy: Promise<unknown> | undefined;
    if (state === "disposed") { await browser.start(); await browser.dispose(); }
    else if (state === "busy") { await browser.start(); await browser.importJson(f.json); busy = browser.importPng(f.file, f.rectangle); }
    expect(typeof browser.setShapeFillColor).toBe("function");
    const get = vi.fn(() => { throw new Error("caller getter"); });
    const input = Object.defineProperty({ documentId: "browser-document", revisionId: "source", elementId: "shape-1", fillColor: "#3fa9f5" }, "fillColor", { get });
    const ids = vi.spyOn(crypto, "randomUUID"); ids.mockClear();
    for (const spy of [f.readPointers, f.readAsset, f.writeAsset, f.writeRevision]) spy.mockClear();
    await expect(browser.setShapeFillColor(input)).rejects.toThrow("EDITOR_SHAPE_FILL_COLOR_UNAVAILABLE");
    expect(get).not.toHaveBeenCalled(); expect(ids).not.toHaveBeenCalled();
    for (const spy of [f.readPointers, f.readAsset, f.writeAsset, f.writeRevision]) expect(spy).not.toHaveBeenCalled();
    if (busy) { f.gate.resolve(new Uint8Array([1, 2, 3]).buffer); await busy; }
    await browser.dispose();
  });

  it("fill color cannot replace an owned PNG flight started by a request getter", async () => {
    const f = await pngFixture(); const browser = f.browser;
    await browser.start(); await browser.importJson(f.json);
    const source = browser.current!; let pngFlight: Promise<BrowserCurrent | null> | undefined;
    const request = { documentId: source.revision.documentId, revisionId: source.revision.revisionId,
      elementId: "shape-1", fillColor: "#3Fa9F5" };
    Object.defineProperty(request, "documentId", { get() {
      pngFlight = browser.importPng(f.file, f.rectangle);
      return source.revision.documentId;
    } });
    try {
      await expect(browser.setShapeFillColor(request)).rejects.toThrow("EDITOR_SHAPE_FILL_COLOR_UNAVAILABLE");
      expect(browser.current).toBe(source);
      let disposed = false; const disposal = browser.dispose().then(() => { disposed = true; });
      await Promise.resolve(); await Promise.resolve();
      expect(disposed).toBe(false);
      f.gate.resolve(new Uint8Array([1, 2, 3]).buffer);
      await pngFlight; await disposal;
      expect(disposed).toBe(true);
    } finally {
      f.gate.resolve(new Uint8Array([1, 2, 3]).buffer);
      await pngFlight?.catch(() => undefined);
      await browser.dispose();
    }
  });

  it("real fill color publishes durably through fake-indexeddb and leaves the owner on preparation failure", async () => {
    const f = await pngFixture(); const browser = f.browser as FillColorBrowser;
    await browser.start(); await browser.importJson(f.json);
    expect(typeof browser.setShapeFillColor).toBe("function"); const source = browser.current!;
    const input = { documentId: source.revision.documentId, revisionId: source.revision.revisionId, elementId: "shape-1", fillColor: "#3Fa9F5" };
    const next = await browser.setShapeFillColor(input);
    expect(next).toBe(browser.current); expect(next?.revision.sequence).toBe(2);
    const expected = structuredClone(source.revision.document);
    Object.assign(expected.elements.find((element) => element.id === "shape-1")!, { fillColor: "#3Fa9F5" });
    expect(next?.revision.document).toEqual(expected);
    const pointers = await f.persistence.readPointers("browser-document");
    expect(await f.persistence.readRevision("browser-document", pointers.draft!.revisionId)).toEqual(next!.revision);
    const held = browser.current!; f.readPointers.mockRejectedValueOnce(new Error("preparation failed"));
    await expect(browser.setShapeFillColor({ ...input, revisionId: held.revision.revisionId })).rejects.toThrow();
    expect(browser.current).toBe(held);
    expect(await f.persistence.readPointers("browser-document")).toEqual(pointers);
    await browser.dispose();
  });
});

type VisibilityRequest = import("../src/editor-session.js").ShapeVisibilityRequest;
type VisibilityBrowser = ReturnType<typeof createBrowserEditorSession>;

it("visibility captures four getters once, frozen before SDK callbacks and owned-lane reentry", async () => {
  const pending = deferred<void>(); const release = vi.fn(); const clear = vi.fn();
  const revision = { documentId: "browser-document", revisionId: "source", sequence: 1, document: FIRST_SLICE_DOCUMENT };
  const previous = { revision, workspace: { images: [] }, release }; const workspace = { current: previous };
  const input = { documentId: revision.documentId, revisionId: revision.revisionId, elementId: "shape-1", visible: false };
  const expected = { ...input }; const reads: string[] = []; const request = { ...input };
  for (const key of Object.keys(input) as (keyof typeof input)[]) Object.defineProperty(request, key, { get() { reads.push(key); return input[key]; } });
  const setShapeVisibility = vi.fn(async (captured: VisibilityRequest) => {
    expect(captured).toEqual(expected); expect(Object.isFrozen(captured)).toBe(true); expect(reads).toEqual(Object.keys(input));
    Object.assign(input, { documentId: "foreign", revisionId: "late", elementId: "root", visible: true });
    await expect(browser.setShapeVisibility(input)).rejects.toThrow("UNAVAILABLE");
    await pending.promise; expect(captured).toEqual(expected);
    workspace.current = { ...previous, revision: { ...revision, revisionId: "actual", sequence: 2 } };
  });
  mocks.persistence.mockReturnValue({ readPointers: async () => ({ draft: revision, saved: null }) });
  mocks.session.mockReturnValue({ workspace, cache: { clear }, reload: async () => previous, setShapeVisibility });
  const browser = createBrowserEditorSession() as VisibilityBrowser; await browser.start();
  expect(typeof browser.setShapeVisibility).toBe("function"); const flight = browser.setShapeVisibility(request);
  pending.resolve(); const next = await flight;
  expect(next).toBe(browser.current); expect(next?.revision).toBe(workspace.current.revision);
  expect(next).not.toHaveProperty("release"); expect(next).not.toHaveProperty("cache");
  expect(reads).toEqual(Object.keys(input)); expect(setShapeVisibility).toHaveBeenCalledTimes(1);
  await browser.dispose(); expect(release).toHaveBeenCalledTimes(1); expect(clear).toHaveBeenCalledTimes(1);
});

it.each(["not-ready", "absent", "busy", "disposed"])("visibility unavailable %s rejects before caller getters or effects", async (state) => {
  const f = await pngFixture(); const browser = f.browser as VisibilityBrowser; let busy: Promise<unknown> | undefined;
  if (state === "absent" || state === "disposed") await browser.start();
  if (state === "busy") { await browser.start(); await browser.importJson(f.json); busy = browser.importPng(f.file, f.rectangle); }
  if (state === "disposed") await browser.dispose();
  expect(typeof browser.setShapeVisibility).toBe("function");
  const get = vi.fn(() => { throw new Error("caller getter"); });
  const input = Object.defineProperty({ documentId: "browser-document", revisionId: "source", elementId: "shape-1", visible: true }, "visible", { get });
  const ids = vi.spyOn(crypto, "randomUUID"); ids.mockClear();
  for (const spy of [f.readPointers, f.readAsset, f.writeAsset, f.writeRevision]) spy.mockClear();
  await expect(browser.setShapeVisibility(input)).rejects.toThrow("EDITOR_SHAPE_VISIBILITY_UNAVAILABLE");
  expect(get).not.toHaveBeenCalled(); expect(ids).not.toHaveBeenCalled();
  for (const spy of [f.readPointers, f.readAsset, f.writeAsset, f.writeRevision]) expect(spy).not.toHaveBeenCalled();
  if (busy) { f.gate.resolve(new Uint8Array([1, 2, 3]).buffer); await busy; }
  await browser.dispose();
});

it("visibility cannot replace an owned PNG flight started by a request getter", async () => {
  const f = await pngFixture(); const browser = f.browser as VisibilityBrowser;
  await browser.start(); await browser.importJson(f.json);
  const source = browser.current!; const prior = await f.persistence.readPointers("browser-document");
  let pngFlight: Promise<BrowserCurrent | null> | undefined;
  const request = { documentId: source.revision.documentId, revisionId: source.revision.revisionId, elementId: "shape-1", visible: false };
  Object.defineProperty(request, "documentId", { get() { pngFlight = browser.importPng(f.file, f.rectangle); return source.revision.documentId; } });
  try {
    await expect(browser.setShapeVisibility(request)).rejects.toThrow("EDITOR_SHAPE_VISIBILITY_UNAVAILABLE");
    expect(browser.current).toBe(source); expect(await f.persistence.readPointers("browser-document")).toEqual(prior);
    let disposed = false; const disposal = browser.dispose().then(() => { disposed = true; });
    await Promise.resolve(); await Promise.resolve(); expect(disposed).toBe(false);
    f.gate.resolve(new Uint8Array([1, 2, 3]).buffer); await pngFlight; await disposal; expect(disposed).toBe(true);
  } finally {
    f.gate.resolve(new Uint8Array([1, 2, 3]).buffer); await pngFlight?.catch(() => undefined); await browser.dispose();
  }
});

it("real visibility publishes false, true and equal values durably through fake-indexeddb", async () => {
  const f = await pngFixture(); const browser = f.browser as VisibilityBrowser;
  await browser.start(); await browser.importJson(f.json);
  const png = browser.importPng(f.file, f.rectangle);
  f.gate.resolve(new Uint8Array([1, 2, 3]).buffer);
  await png;
  expect(typeof browser.setShapeVisibility).toBe("function"); const source = browser.current!;
  const input = { documentId: source.revision.documentId, revisionId: source.revision.revisionId, elementId: "shape-1", visible: false };
  const next = await browser.setShapeVisibility(input);
  expect(next).toBe(browser.current); expect(next?.revision.sequence).toBe(source.revision.sequence + 1);
  const expected = structuredClone(source.revision.document); Object.assign(expected.elements.find((element) => element.id === "shape-1")!, { visible: false }); expect(next?.revision.document).toStrictEqual(expected);
  let pointers = await f.persistence.readPointers("browser-document");
  expect(await f.persistence.readRevision("browser-document", pointers.draft!.revisionId)).toEqual(next!.revision);
  for (const visible of [true, true]) {
    const before = browser.current!;
    const row = await browser.setShapeVisibility({ ...input, revisionId: before.revision.revisionId, visible });
    expect(row).toBe(browser.current); expect(row?.revision.sequence).toBe(before.revision.sequence + 1);
    const document = structuredClone(before.revision.document); Object.assign(document.elements.find((element) => element.id === "shape-1")!, { visible }); expect(row?.revision.document).toStrictEqual(document);
  }
  await expect(browser.setShapeVisibility(null as unknown as VisibilityRequest)).rejects.toThrow("EDITOR_SHAPE_VISIBILITY_INPUT_INVALID");
  const held = browser.current!; pointers = await f.persistence.readPointers("browser-document");
  f.readPointers.mockRejectedValueOnce(new Error("preparation failed"));
  await expect(browser.setShapeVisibility({ ...input, revisionId: held.revision.revisionId })).rejects.toThrow();
  expect(browser.current).toBe(held); expect(await f.persistence.readPointers("browser-document")).toEqual(pointers);
  await browser.dispose();
});
