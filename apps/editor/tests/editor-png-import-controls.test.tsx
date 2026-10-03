import { afterEach, expect, it, vi } from "vitest";
import { mountEditorPngImportControls } from "../src/editor-png-import-controls.js";
import { mountEditorJsonImportControls } from "../src/editor-json-import-controls.js";

function fixture() {
  document.body.innerHTML = `<form id="png"><input type="file"><input id="x" value="0"><input id="y" value="0">
    <input id="width" value="64"><input id="height" value="64"><button>Import PNG</button></form><p id="png-status"></p>
    <form id="json"><textarea></textarea><button>Import JSON</button></form><p id="json-status"></p>`;
  const form = document.querySelector<HTMLFormElement>("#png")!;
  const input = form.querySelector("input")!;
  const button = form.querySelector("button")!;
  const status = document.querySelector<HTMLElement>("#png-status")!;
  const rectangle = Object.fromEntries(["x", "y", "width", "height"].map((key) =>
    [key, document.querySelector<HTMLInputElement>(`#${key}`)!])) as Record<"x" | "y" | "width" | "height", HTMLInputElement>;
  const jsonForm = document.querySelector<HTMLFormElement>("#json")!;
  const jsonInput = jsonForm.querySelector("textarea")!;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const importPng = vi.fn(() => promise);
  const workflow = vi.fn(() => promise);
  const onImported = vi.fn(() => "Rendered imported draft at 500000 µs.");
  let busy = false;
  const activity = {
    begin() { if (busy) return false; busy = true; png.setBusy(true); json.setBusy(true); return true; },
    end() { busy = false; png.setBusy(false); json.setBusy(false); },
  };
  const png = mountEditorPngImportControls({ form, input, button, rectangle, status, importPng, onImported, activity });
  const json = mountEditorJsonImportControls({ form: jsonForm, input: jsonInput, button: jsonForm.querySelector("button")!,
    status: document.querySelector<HTMLElement>("#json-status")!, workflow, onImported, activity });
  const file = new File(["png"], "selected.png", { type: "image/png" });
  const select = (value: File | null = file) => Object.defineProperty(input, "files", { configurable: true, value: value ? [value] : [] });
  const activate = () => form.dispatchEvent(new Event("submit", { cancelable: true }));
  const activateJson = () => jsonForm.dispatchEvent(new Event("submit", { cancelable: true }));
  const ready = () => { png.setReady(true, true); json.setReady(true); };
  return { form, input, button, status, rectangle, png, json, jsonForm, jsonInput, file, select, activate,
    activateJson, ready, importPng, workflow, onImported, resolve, reject, promise };
}
afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

it("blocks unavailable/context/corrupt startup and no-current, then validates File and placement", () => {
  const f = fixture();
  expect(f.button.disabled).toBe(true);
  f.select(); f.activate();
  expect(f.importPng).not.toHaveBeenCalled();
  f.png.setReady(true, false);
  expect(f.status.textContent).toContain("Import JSON first");
  expect(f.button.disabled).toBe(true);
  f.activate();
  f.ready(); f.select(null); f.activate();
  expect(f.status.textContent).toContain("Select a PNG");
  f.select();
  for (const [key, value] of [["x", ""], ["y", "Infinity"], ["width", "0"], ["height", "-1"]] as const) {
    const original = f.rectangle[key].value;
    f.rectangle[key].value = value; f.activate();
    expect(f.status.textContent).toContain("finite");
    f.rectangle[key].value = original;
  }
  expect(f.importPng).not.toHaveBeenCalled();
  f.png.setReady(false, true); f.activate();
  expect(f.button.disabled).toBe(true);
  f.png.dispose(); f.json.dispose();
});

it.each(["png", "json"])("captures independent inputs and owns same-turn cross-action activity (%s first)", async (first) => {
  const f = fixture(); f.ready(); f.select();
  f.jsonInput.value = "captured JSON";
  if (first === "png") f.activate(); else f.activateJson();
  f.rectangle.x.value = "200";
  f.select(new File(["different"], "different.png", { type: "image/png" }));
  f.jsonInput.value = "changed JSON";
  f.activate(); f.activateJson(); f.button.click();
  expect(f.button.disabled).toBe(true);
  expect(f.jsonForm.querySelector("button")!.disabled).toBe(true);
  expect(f.form.getAttribute("aria-busy")).toBe("true");
  expect(f.jsonForm.getAttribute("aria-busy")).toBe("true");
  if (first === "png") {
    expect(f.importPng).toHaveBeenCalledExactlyOnceWith(f.file, { x: 0, y: 0, width: 64, height: 64 });
    expect(f.workflow).not.toHaveBeenCalled();
  } else {
    expect(f.workflow).toHaveBeenCalledExactlyOnceWith({ kind: "editable-json-import", editableJson: "captured JSON" });
    expect(f.importPng).not.toHaveBeenCalled();
  }
  f.resolve();
  await vi.waitFor(() => expect(f.onImported).toHaveBeenCalledTimes(1));
  expect(f.button.disabled).toBe(false);
  expect(f.jsonForm.querySelector("button")!.disabled).toBe(false);
  expect(f.form.getAttribute("aria-busy")).toBe("false");
  f.png.dispose(); f.json.dispose();
});

it.each([false, true])("removes its listener once and freezes late DOM after page disposal (reject=%s)", async (reject) => {
  const f = fixture(); f.ready(); f.select(); f.activate();
  const remove = vi.spyOn(f.form, "removeEventListener");
  f.png.dispose(); f.json.dispose(); f.png.dispose();
  const markup = document.body.innerHTML;
  expect(remove).toHaveBeenCalledExactlyOnceWith("submit", expect.any(Function));
  if (reject) f.reject(new Error("decode fault")); else f.resolve();
  await f.promise.catch(() => undefined); await Promise.resolve();
  f.png.setReady(true, true); f.png.setBusy(false); f.activate(); f.activateJson();
  expect(document.body.innerHTML).toBe(markup);
  expect(f.onImported).not.toHaveBeenCalled();
  expect(f.importPng).toHaveBeenCalledTimes(1);
});

it("reports a failed PNG without a render and enables a later explicit action", async () => {
  const f = fixture(); f.ready(); f.select(); f.activate();
  f.reject(new Error("decode"));
  await vi.waitFor(() => expect(f.status.textContent).toContain("PNG import failed"));
  expect(f.status.textContent).toContain("refresh");
  expect(f.onImported).not.toHaveBeenCalled();
  expect(f.button.disabled).toBe(false);
  f.importPng.mockResolvedValueOnce(undefined); f.activate();
  await vi.waitFor(() => expect(f.onImported).toHaveBeenCalledTimes(1));
  f.png.dispose(); f.json.dispose();
});
