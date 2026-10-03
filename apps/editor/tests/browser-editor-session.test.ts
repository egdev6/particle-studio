import { expect, it, vi } from "vitest";
import { createBrowserEditorSession } from "../src/browser-editor-session.js";

const mocks = vi.hoisted(() => ({ session: vi.fn(), persistence: vi.fn() }));
vi.mock("../src/editor-session.js", () => ({ createEditorSession: mocks.session }));
vi.mock("@particle-studio/persistence-indexeddb", () => ({
  createIndexedDbPersistenceAdapter: mocks.persistence,
}));

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
  expect(deps.jsonImportSequenceFloor()).toBe(41);
  await browser.importJson("user JSON");
  expect(readPointers).toHaveBeenCalledTimes(1);
  await browser.dispose();
  readPointers.mockRejectedValue(new Error("corrupt"));
  const failed = createBrowserEditorSession();
  await expect(failed.start()).rejects.toThrow("corrupt");
  await expect(failed.importJson("blocked")).rejects.toThrow();
  expect(importWorkflow).toHaveBeenCalledTimes(1);
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
