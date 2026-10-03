import { afterEach, expect, it, vi } from "vitest";
import { mountEditorJsonImportControls } from "../src/editor-json-import-controls.js";
import { mountEditorPngImportControls } from "../src/editor-png-import-controls.js";

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

function creationFixture() {
  const f = fixture(); f.controls.dispose();
  const createButton = document.createElement("button");
  createButton.textContent = "Create blank scene"; document.body.append(createButton);
  let current = false;
  const createScene = vi.fn(() => f.pending.promise);
  const onCreated = vi.fn(() => { current = true; return "Rendered imported draft at 0 µs."; });
  const pngForm = document.createElement("form");
  pngForm.innerHTML = `<input type="file"><input value="0"><input value="0"><input value="64"><input value="64"><button>Import PNG</button>`;
  document.body.append(pngForm);
  const fields = pngForm.querySelectorAll("input");
  Object.defineProperty(fields[0], "files", { value: [new File(["png"], "selected.png", { type: "image/png" })] });
  const importPng = vi.fn(() => f.pending.promise);
  let busy = false;
  const activity = {
    begin() { if (busy) return false; busy = true; controls.setBusy(true); png.setBusy(true); return true; },
    end() { busy = false; controls.setBusy(false); png.setBusy(false); },
  };
  const options = { ...f, createButton, createScene, onCreated, hasCurrent: () => current, activity };
  const controls = mountEditorJsonImportControls(options);
  const png = mountEditorPngImportControls({ form: pngForm, input: fields[0]!, button: pngForm.querySelector("button")!,
    rectangle: { x: fields[1]!, y: fields[2]!, width: fields[3]!, height: fields[4]! },
    status: document.createElement("p"), importPng, onImported: f.onImported, activity });
  const create = () => createButton.dispatchEvent(new Event("click", { cancelable: true }));
  const activatePng = () => pngForm.dispatchEvent(new Event("submit", { cancelable: true }));
  return { ...f, controls, createButton, createScene, onCreated, png, pngForm, importPng, create, activatePng,
    current(value: boolean) { current = value; controls.setReady(true); png.setReady(true, value); } };
}

it.each(["create", "json", "png"])("creation shares pending state and captures no mutable inputs (%s first)", async (first) => {
  const f = creationFixture();
  expect(f.createButton.disabled).toBe(true); f.create();
  expect(f.createScene).not.toHaveBeenCalled();
  f.controls.setReady(true); f.png.setReady(true, true);
  expect(f.createButton.disabled).toBe(false);
  f.input.value = "captured JSON";
  if (first === "create") f.create(); else if (first === "json") f.activate(); else f.activatePng();
  f.input.value = "retarget";
  f.create(); f.activate(); f.activatePng(); f.createButton.click();
  expect(f.createButton.disabled).toBe(true); expect(f.button.disabled).toBe(true);
  expect(f.pngForm.querySelector("button")!.disabled).toBe(true);
  expect(f.form.getAttribute("aria-busy")).toBe("true");
  expect(f.pngForm.getAttribute("aria-busy")).toBe("true");
  expect(f.createScene).toHaveBeenCalledTimes(first === "create" ? 1 : 0);
  expect(f.workflow).toHaveBeenCalledTimes(first === "json" ? 1 : 0);
  expect(f.importPng).toHaveBeenCalledTimes(first === "png" ? 1 : 0);
  if (first === "create") {
    expect(f.createScene).toHaveBeenCalledExactlyOnceWith();
    expect(f.status.textContent).toContain("progress");
  }
  if (first === "json") expect(f.workflow).toHaveBeenCalledExactlyOnceWith({ kind: "editable-json-import", editableJson: "captured JSON" });
  f.pending.resolve();
  await vi.waitFor(() => expect(f.form.getAttribute("aria-busy")).toBe("false"));
  if (first === "create") {
    expect(f.onCreated).toHaveBeenCalledTimes(1); expect(f.onImported).not.toHaveBeenCalled();
    expect(f.status.textContent).toContain("Rendered imported draft at 0 µs.");
    expect(f.createButton.disabled).toBe(true);
  }
  f.current(true); f.create(); expect(f.createButton.disabled).toBe(true);
  expect(f.button.disabled).toBe(false); // Creation-only guard must not block replacement JSON.
  f.controls.setReady(false); f.create(); expect(f.createButton.disabled).toBe(true);
  f.controls.dispose(); f.png.dispose();
});

it.each([false, true])("creation owns exact listeners and freezes late resolve/reject output (reject=%s)", async (reject) => {
  const f = creationFixture();
  const formRemove = vi.spyOn(f.form, "removeEventListener");
  const buttonRemove = vi.spyOn(f.createButton, "removeEventListener");
  f.controls.setReady(true); f.create();
  expect(f.createScene).toHaveBeenCalledTimes(1);
  f.controls.dispose(); f.controls.dispose(); f.png.dispose();
  expect(formRemove).toHaveBeenCalledExactlyOnceWith("submit", expect.any(Function));
  expect(buttonRemove).toHaveBeenCalledExactlyOnceWith("click", expect.any(Function));
  const markup = document.body.innerHTML;
  if (reject) f.pending.reject(new Error("late create failure")); else f.pending.resolve();
  await f.pending.promise.catch(() => undefined); await Promise.resolve();
  f.controls.setReady(true); f.controls.setBusy(false); f.create(); f.activate();
  expect(document.body.innerHTML).toBe(markup);
  expect(f.onCreated).not.toHaveBeenCalled(); expect(f.onImported).not.toHaveBeenCalled();
  expect(f.createScene).toHaveBeenCalledTimes(1); expect(f.workflow).not.toHaveBeenCalled();
});

it("creation failure is actionable and preserves the no-current controls for explicit retry", async () => {
  const f = creationFixture(); f.controls.setReady(true); f.create();
  expect(f.createScene).toHaveBeenCalledTimes(1);
  f.pending.reject(new Error("CAS failed"));
  await vi.waitFor(() => expect(f.status.dataset.importStatus).toBe("error"));
  expect(f.status.textContent).toContain("refresh"); expect(f.status.textContent).toContain("try again");
  expect(f.onCreated).not.toHaveBeenCalled(); expect(f.createButton.disabled).toBe(false);
  f.createScene.mockResolvedValueOnce(undefined); f.create();
  await vi.waitFor(() => expect(f.onCreated).toHaveBeenCalledTimes(1));
  expect(f.createScene).toHaveBeenCalledTimes(2); f.controls.dispose(); f.png.dispose();
});

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
