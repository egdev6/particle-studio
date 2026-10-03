import { afterEach, expect, it, vi } from "vitest";
import { mountEditorJsonImportControls } from "../src/editor-json-import-controls.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  document.body.innerHTML = `<form><label for="json">Editable JSON</label><textarea id="json"></textarea>
    <button type="submit">Import editable JSON</button></form><p role="status">Loading local scene…</p>`;
  const form = document.querySelector("form")!;
  const input = document.querySelector("textarea")!;
  const button = document.querySelector("button")!;
  const status = document.querySelector<HTMLElement>("[role=status]")!;
  const pending = deferred();
  const workflow = vi.fn(() => pending.promise);
  const onImported = vi.fn(() => "Rendered imported draft at 500000 µs.");
  const controls = mountEditorJsonImportControls({ form, input, button, status, workflow, onImported });
  const activate = () => form.dispatchEvent(new Event("submit", { cancelable: true }));
  return { form, input, button, status, pending, workflow, onImported, controls, activate };
}
afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

it("blocks startup/corrupt/context-unavailable readiness and captures JSON once at activation", async () => {
  const f = fixture();
  expect(f.input.disabled).toBe(true);
  expect(f.button.disabled).toBe(true);
  f.input.value = "captured JSON";
  expect(f.activate()).toBe(false);
  expect(f.workflow).not.toHaveBeenCalled();
  f.controls.setReady(true);
  expect(f.input.disabled).toBe(false);
  expect(f.button.disabled).toBe(false);
  f.activate();
  f.input.value = "changed while pending";
  f.activate();
  f.button.click();
  expect(f.workflow).toHaveBeenCalledExactlyOnceWith({ kind: "editable-json-import", editableJson: "captured JSON" });
  expect(f.status.textContent).toBe("Import in progress.");
  expect(f.form.getAttribute("aria-busy")).toBe("true");
  expect(f.input.disabled).toBe(true);
  expect(f.button.disabled).toBe(true);
  f.pending.resolve();
  await vi.waitFor(() => expect(f.status.textContent).toBe("Import complete. Rendered imported draft at 500000 µs."));
  expect(f.onImported).toHaveBeenCalledTimes(1);
  expect(f.button.disabled).toBe(false);
  expect(f.form.getAttribute("aria-busy")).toBe("false");
  f.controls.setReady(false);
  f.activate();
  expect(f.workflow).toHaveBeenCalledTimes(1);
  expect(f.button.disabled).toBe(true);
  f.controls.dispose();
});

it("reports actionable failure and allows only a later explicit activation", async () => {
  const f = fixture();
  f.controls.setReady(true);
  f.activate();
  f.pending.reject(new Error("missing asset"));
  await vi.waitFor(() => expect(f.status.textContent).toContain("Check the JSON and locally stored PNG assets"));
  expect(f.onImported).not.toHaveBeenCalled();
  expect(f.button.disabled).toBe(false);
  expect(f.workflow).toHaveBeenCalledTimes(1);
  f.workflow.mockResolvedValueOnce(undefined);
  f.activate();
  await vi.waitFor(() => expect(f.onImported).toHaveBeenCalledTimes(1));
  expect(f.workflow).toHaveBeenCalledTimes(2);
  f.controls.dispose();
});

it.each([false, true])("removes listeners and suppresses late output on disposal (reject=%s)", async (reject) => {
  const f = fixture();
  const remove = vi.spyOn(f.form, "removeEventListener");
  f.controls.setReady(true);
  f.activate();
  const before = f.status.textContent;
  f.controls.dispose();
  f.controls.dispose();
  f.controls.setReady(true);
  f.activate();
  expect(f.button.disabled).toBe(true);
  expect(remove).toHaveBeenCalledTimes(1);
  const disposedMarkup = document.body.innerHTML;
  if (reject) f.pending.reject(new Error("late failure"));
  else f.pending.resolve();
  await f.pending.promise.catch(() => undefined);
  await Promise.resolve();
  expect(f.status.textContent).toBe(before);
  expect(document.body.innerHTML).toBe(disposedMarkup);
  expect(f.onImported).not.toHaveBeenCalled();
  expect(f.workflow).toHaveBeenCalledTimes(1);
});
