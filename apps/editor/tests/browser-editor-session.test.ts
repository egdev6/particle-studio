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
