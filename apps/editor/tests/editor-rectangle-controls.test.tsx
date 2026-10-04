import { afterEach, expect, it, vi } from "vitest";
import { mountEditorRectangleControls } from "../src/editor-rectangle-controls.js";
import { mountEditorJsonImportControls } from "../src/editor-json-import-controls.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

function fixture() {
  document.body.innerHTML = `<form id="rectangle-create"><input id="x" value="16"><input id="y" value="24">
    <input id="width" value="120"><input id="height" value="80"><button>Add rectangle</button></form>
    <p id="rectangle-status" role="status" aria-label="Rectangle creation status"></p>
    <form id="json"><textarea></textarea><button>Import editable JSON</button></form><p id="status" role="status"></p>`;
  const form = document.querySelector<HTMLFormElement>("#rectangle-create")!;
  const button = form.querySelector("button")!;
  const status = document.querySelector<HTMLElement>("#rectangle-status")!;
  const rectangle = Object.fromEntries(["x", "y", "width", "height"].map((key) =>
    [key, document.getElementById(key)!])) as Record<"x" | "y" | "width" | "height", HTMLInputElement>;
  const listeners = vi.spyOn(form, "addEventListener");
  const pending = deferred();
  const addRectangle = vi.fn((_geometry: { x: number; y: number; width: number; height: number }) => pending.promise);
  const onCreated = vi.fn(() => "Rendered current.");
  let busy = false;
  const activity = {
    begin: vi.fn(() => {
      if (busy) return false;
      busy = true; controls.setBusy(true); json.setBusy(true); return true;
    }),
    end: vi.fn(() => { busy = false; controls.setBusy(false); json.setBusy(false); }),
  };
  const controls = mountEditorRectangleControls({ form, rectangle, button, status,
    addRectangle, onCreated, activity });
  const jsonForm = document.querySelector<HTMLFormElement>("#json")!;
  const workflow = vi.fn(() => pending.promise);
  const json = mountEditorJsonImportControls({ form: jsonForm, input: jsonForm.querySelector("textarea")!,
    button: jsonForm.querySelector("button")!, status: document.querySelector("#status")!,
    workflow, onImported: () => "Rendered JSON.", activity });
  const submit = () => form.dispatchEvent(new Event("submit", { cancelable: true }));
  return { controls, json, jsonForm, workflow, form, button, status, rectangle, pending,
    addRectangle, onCreated, activity, submit, listeners };
}

it("guards pre-ready, no-current and shared pending before action/input-dependent work", () => {
  const f = fixture();
  f.submit(); expect(f.addRectangle).not.toHaveBeenCalled(); expect(f.button.disabled).toBe(true);
  f.controls.setReady(true, false); f.submit();
  expect(f.status.textContent).toContain("Create a scene or import JSON");
  expect(f.activity.begin).not.toHaveBeenCalled();
  f.controls.setReady(true, true); f.controls.setBusy(true); f.submit();
  expect(f.addRectangle).not.toHaveBeenCalled();
  f.controls.setBusy(false); expect(f.button.disabled).toBe(false);
  f.controls.dispose(); f.json.dispose(); f.submit();
  expect(f.addRectangle).not.toHaveBeenCalled();
});

it.each([["x", ""], ["y", " "], ["x", "NaN"], ["y", "Infinity"],
  ["width", "0"], ["width", "Infinity"], ["height", "-1"]])(
  "reports invalid %s=%s without acquiring shared work", (key, value) => {
    const f = fixture(); f.controls.setReady(true, true);
    f.rectangle[key as keyof typeof f.rectangle].value = value;
    f.submit(); expect(f.status.textContent).toContain("finite");
    expect(f.addRectangle).not.toHaveBeenCalled(); expect(f.activity.begin).not.toHaveBeenCalled();
    f.controls.dispose(); f.json.dispose();
  },
);

it("captures exact geometry, prevents repeated and JSON cross-activation and renders once", async () => {
  const f = fixture(); f.controls.setReady(true, true); f.json.setReady(true);
  f.submit(); f.submit(); f.jsonForm.dispatchEvent(new Event("submit", { cancelable: true }));
  expect(f.addRectangle).toHaveBeenCalledExactlyOnceWith({ x: 16, y: 24, width: 120, height: 80 });
  expect(f.workflow).not.toHaveBeenCalled(); expect(f.button.disabled).toBe(true);
  expect(f.form.getAttribute("aria-busy")).toBe("true");
  f.rectangle.x.value = "220"; f.rectangle.width.value = "1";
  expect(f.addRectangle.mock.calls[0]![0]).toEqual({ x: 16, y: 24, width: 120, height: 80 });
  f.pending.resolve(); await vi.waitFor(() => expect(f.onCreated).toHaveBeenCalledTimes(1));
  expect(f.status.textContent).toContain("Rendered current.");
  expect(f.activity.end).toHaveBeenCalledTimes(1); expect(f.button.disabled).toBe(false);
  f.controls.dispose(); f.json.dispose();
});

it("reports committed rectangle with rendering failure without offering creation retry", async () => {
  const f = fixture(); f.controls.setReady(true, true);
  const remove = vi.spyOn(f.form, "removeEventListener");
  f.onCreated.mockImplementation(() => { throw new Error("rendering fault after publication"); });
  try {
    f.submit(); f.pending.resolve();
    await vi.waitFor(() => expect(f.status.textContent).toBe(
      "Rectangle created, but rendering failed. Refresh to view the published draft."));
    expect(f.status.textContent).not.toMatch(/creation failed|try again/i);
    expect(f.addRectangle).toHaveBeenCalledTimes(1);
    expect(f.onCreated).toHaveBeenCalledTimes(1);
    expect(f.activity.end).toHaveBeenCalledTimes(1);
    expect(f.form.getAttribute("aria-busy")).toBe("false");
    expect(f.button.disabled).toBe(false);
  } finally {
    f.controls.dispose(); f.controls.dispose(); f.json.dispose();
  }
  expect(remove).toHaveBeenCalledTimes(1);
  expect(remove.mock.calls[0]).toEqual(f.listeners.mock.calls[0]);
});

it("JSON activation blocks rectangle through the same activity lane", async () => {
  const f = fixture(); f.controls.setReady(true, true); f.json.setReady(true);
  f.jsonForm.dispatchEvent(new Event("submit", { cancelable: true })); f.submit();
  expect(f.workflow).toHaveBeenCalledTimes(1); expect(f.addRectangle).not.toHaveBeenCalled();
  f.pending.resolve(); await vi.waitFor(() => expect(f.activity.end).toHaveBeenCalledTimes(1));
  f.controls.dispose(); f.json.dispose();
});

it.each([false, true])("disposal removes the owned listener once and freezes late settlement (reject=%s)", async (reject) => {
  const f = fixture(); f.controls.setReady(true, true);
  const remove = vi.spyOn(f.form, "removeEventListener");
  f.submit(); f.controls.dispose(); f.controls.dispose(); f.json.dispose();
  const snapshot = document.body.innerHTML;
  expect(remove).toHaveBeenCalledTimes(1);
  expect(remove.mock.calls[0]![0]).toBe("submit");
  expect(f.listeners).toHaveBeenCalledTimes(1);
  expect(remove.mock.calls[0]).toEqual(f.listeners.mock.calls[0]);
  if (reject) f.pending.reject(new Error("preparation failed")); else f.pending.resolve();
  await f.pending.promise.catch(() => undefined);
  await Promise.resolve(); await Promise.resolve();
  f.controls.setReady(true, true); f.controls.setBusy(false); f.submit();
  expect(document.body.innerHTML).toBe(snapshot);
  expect(f.onCreated).not.toHaveBeenCalled(); expect(f.addRectangle).toHaveBeenCalledTimes(1);
  expect(f.activity.end).not.toHaveBeenCalled();
});
