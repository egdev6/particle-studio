import { afterEach, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { FIRST_SLICE_DOCUMENT } from "@particle-studio/scene-document";
import { createBrowserEditorSession } from "../src/browser-editor-session.js";

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
  const browser = createBrowserEditorSession();
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
