import { afterEach, expect, it, vi } from "vitest";
import type { SceneDocumentV1 } from "@particle-studio/scene-document";
import { mountEditorElementInspector, type InspectorCurrent } from "../src/editor-element-inspector.js";
import { mountEditorPositionControls } from "../src/editor-position-controls.js";
import { mountEditorDimensionControls } from "../src/editor-dimension-controls.js";
import type { ShapeOpacityRequest } from "../src/editor-session.js";

type OpacityOptions = Omit<Parameters<typeof mountEditorPositionControls>[0], "position" | "setShapePosition"> & {
  opacity: HTMLInputElement;
  setShapeOpacity: (request: ShapeOpacityRequest) => Promise<unknown>;
};
type MountOpacity = (options: OpacityOptions) => ReturnType<typeof mountEditorPositionControls>;
const scene: SceneDocumentV1 = {
  schemaVersion: 1, durationUs: 1_000_000, seed: 42, loop: true,
  playbackRange: { startUs: 0, endUs: 1_000_000 }, rootIds: ["root", "group"],
  elements: [
    { id: "root", type: "shape", x: 1, y: 2, width: 10, height: 20, opacity: 1 },
    { id: "group", type: "group", childrenIds: ["shape", "line", "text", "particle", "image"], transform: [1, 0, 0, 1, 100, 200] },
    { id: "shape", type: "shape", x: -2.5, y: 7.25, width: 20, height: 30, opacity: 0.5 },
    { id: "line", type: "line", x1: 0, y1: 0, x2: 1, y2: 1, opacity: 1 },
    { id: "text", type: "text", x: 0, y: 0, text: "<script>untrusted</script>", fontSize: 12, opacity: 1 },
    { id: "particle", type: "particle", count: 1, x: 0, y: 0, velocityX: 1, velocityY: 1, spread: 1, size: 1, opacity: 1, lifetimeSteps: 1 },
    { id: "image", type: "image", x: 0, y: 0, width: 1, height: 1, opacity: 1,
      asset: { sha256: `sha256:${"a".repeat(64)}`, mimeType: "image/png", byteLength: 68, intrinsicWidth: 1, intrinsicHeight: 1 } },
  ],
  tracks: [{ elementId: "shape", property: "opacity", interpolation: "linear", easing: "linear",
    keyframes: [{ timeUs: 0, value: 0.25 }, { timeUs: 1_000_000, value: 0.75 }] }],
};
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
freeze(scene);
const withOpacity = (opacity: number): SceneDocumentV1 => freeze({ ...scene,
  elements: scene.elements.map((element) => element.type === "shape" ? { ...element, opacity } : element) });
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
async function fixture(source = scene) {
  document.body.innerHTML = `<select aria-label="Scene element"></select><pre aria-label="Published element JSON"></pre>
    <p id="inspection" role="status" aria-label="Element inspection status"></p>
    <form><label>Shape opacity<input type="number" step="any"></label><button>Apply opacity</button></form>
    <p id="opacity-status" role="status" aria-label="Opacity status"></p>
    <textarea aria-label="Editable JSON">{"opacity":999}</textarea><p role="status"></p>`;
  const form = document.querySelector("form")!; const select = document.querySelector("select")!;
  const opacity = form.querySelector("input")!; const button = form.querySelector("button")!;
  const status = document.querySelector<HTMLElement>("#opacity-status")!;
  let current: InspectorCurrent | null = { documentId: "doc", revisionId: "rev", document: source };
  let controls: ReturnType<MountOpacity> | undefined;
  const notification = vi.fn(() => controls?.syncSelection());
  const inspector = mountEditorElementInspector({ select, details: document.querySelector("pre")!,
    status: document.querySelector("#inspection")!, onSelectionChange: notification });
  inspector.setCurrent(current); inspector.setReady(true);
  const choose = (id: string) => { select.value = id; select.dispatchEvent(new Event("change")); };
  choose("shape");
  expect(inspector.getSelection()).toEqual({ documentId: "doc", revisionId: "rev", elementId: "shape" });
  expect(JSON.parse(document.querySelector("pre")!.textContent!)).toEqual(JSON.parse(JSON.stringify(source.elements[2])));
  expect(select.disabled).toBe(false); expect(current.document).toBe(source);
  const modulePath = "../src/" + "editor-opacity-controls.js";
  const loaded = await import(/* @vite-ignore */ modulePath).catch((error: unknown) => {
    // Inspect the first missing target, never a name appearing only in an importer stack.
    const target = error instanceof Error
      ? /(?:Failed to load url|Cannot find module|Cannot find package)\s+['"]?([^'"\s(]+)/i.exec(error.message)?.[1]
      : undefined;
    if (target === modulePath || target?.endsWith("/apps/editor/src/editor-opacity-controls.js")) return {};
    throw error;
  }) as { mountEditorOpacityControls?: MountOpacity };
  expect(typeof loaded.mountEditorOpacityControls, "healthy published-shape DOM opacity capability").toBe("function");
  let resolve!: () => void; let reject!: (error: Error) => void;
  const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const apply = vi.fn((_request: ShapeOpacityRequest) => pending);
  const onPublished = vi.fn(() => "Authored opacity published; animation tracks may override it.");
  const getCurrent = vi.fn(() => current);
  let busy = false;
  const activity = {
    begin: vi.fn(() => { if (busy) return false; busy = true; controls!.setBusy(true); inspector.setBusy(true); return true; }),
    end: vi.fn(() => {
      inspector.setCurrent(current); inspector.setBusy(false); busy = false; controls!.setBusy(false);
      controls!.setReady(true); controls!.syncSelection();
    }),
  };
  const add = vi.spyOn(form, "addEventListener"); const remove = vi.spyOn(form, "removeEventListener");
  controls = loaded.mountEditorOpacityControls!({ form, opacity, button, status, activity,
    getSelection: inspector.getSelection, getCurrent, setShapeOpacity: apply, onPublished });
  const ready = () => { controls!.setReady(true); controls!.syncSelection(); };
  const submit = () => form.dispatchEvent(new Event("submit", { cancelable: true }));
  const borrow = (value: InspectorCurrent | null) => { current = value; };
  const replace = (value: InspectorCurrent | null) => { borrow(value); inspector.setCurrent(value); };
  const dispose = () => { controls!.dispose(); inspector.dispose(); };
  const settled = () => vi.waitFor(() => expect(activity.end).toHaveBeenCalledTimes(1));
  const snapshot = () => document.body.innerHTML + JSON.stringify([opacity.value, select.value]);
  return { controls, inspector, form, select, opacity, button, status, current: () => current, getCurrent,
    borrow, replace, pending, resolve, reject, apply, onPublished, activity, add, remove, notification,
    ready, choose, submit, dispose, settled, snapshot };
}
it.each([0, -0, 0.125, 1, -0.25, 2])("prefills root and nested authored %s, not tracks, option labels or unsent JSON", async (value) => {
  const source = withOpacity(value); const before = JSON.stringify(source); const f = await fixture(source);
  f.submit(); expect(f.activity.begin).not.toHaveBeenCalled(); f.ready();
  f.select.querySelector('option[value="shape"]')!.textContent = "opacity=999";
  for (const id of ["root", "shape"]) { f.choose(id); expect(f.opacity.value).toBe(String(value)); }
  expect(JSON.stringify(source)).toBe(before); expect(f.current()!.document).toBe(source);
  expect(Object.isFrozen(source.elements[2])).toBe(true); expect(Object.isFrozen(f.controls)).toBe(true);
  expect(f.status.getAttribute("aria-label")).toBe("Opacity status");
  expect(document.querySelectorAll('[role="status"]:not([aria-label])')).toHaveLength(1); f.dispose();
});
it.each(["group", "line", "text", "particle", "image"])("%s is inspectable but read-only", async (id) => {
  const f = await fixture(); f.ready(); f.choose(id); f.submit();
  expect([f.opacity.disabled, f.button.disabled]).toEqual([true, true]); expect(f.status.textContent).toMatch(/shape/i);
  expect(JSON.parse(document.querySelector("pre")!.textContent!)).toEqual(scene.elements.find((element) => element.id === id));
  expect(f.activity.begin).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
  expect(document.querySelector("script")).toBeNull(); f.dispose();
});
it.each(["", " \t ", "NaN", "Infinity", "-Infinity", "1oops", "-0.25", "1.001", "2"])("rejects new %j without effects", async (value) => {
  const f = await fixture(withOpacity(2)); f.ready(); f.opacity.value = value;
  // Number inputs sanitize malformed strings; business rules must reject the resulting empty value too.
  const actual = f.opacity.value;
  if (value.trim() === "" && value !== "") vi.spyOn(f.opacity, "value", "get").mockReturnValueOnce(value);
  f.submit(); expect(f.status.textContent).toMatch(/finite|empty|required|0.*1/i);
  expect(f.opacity.value).toBe(actual); expect(f.activity.begin).not.toHaveBeenCalled();
  expect(f.apply).not.toHaveBeenCalled(); expect(f.onPublished).not.toHaveBeenCalled();
  f.opacity.value = "0.5"; f.submit(); expect(f.apply).toHaveBeenCalledTimes(1); f.resolve(); await f.settled(); f.dispose();
});
it.each([0, -0, 0.125, 0.5, 1])("accepts inclusive %s including equal authored opacity", async (value) => {
  const f = await fixture(); f.ready(); f.opacity.value = Object.is(value, -0) ? "-0" : String(value); f.submit();
  expect(f.apply).toHaveBeenCalledExactlyOnceWith({ documentId: "doc", revisionId: "rev", elementId: "shape", opacity: value });
  expect(f.status.dataset.opacityStatus).toBe("pending"); expect(f.onPublished).not.toHaveBeenCalled();
  f.resolve(); await f.settled(); expect(f.status.textContent).toMatch(/authored.*tracks/i); f.dispose();
});
it("captures four frozen fields once before begin mutates selection, source and input and reenters", async () => {
  const f = await fixture(); f.ready(); f.choose("root"); f.opacity.value = "0.375";
  const read = vi.spyOn(f.opacity, "value", "get");
  f.activity.begin.mockImplementationOnce(() => {
    f.submit(); f.controls.setBusy(true); f.inspector.setBusy(true); f.opacity.value = "0.9";
    f.replace({ ...f.current()!, documentId: "next", revisionId: "new" }); f.choose("image"); return true;
  });
  f.submit(); f.submit(); expect(read).toHaveBeenCalledTimes(1);
  expect(f.apply).toHaveBeenCalledExactlyOnceWith({ documentId: "doc", revisionId: "rev", elementId: "root", opacity: 0.375 });
  expect(Object.keys(f.apply.mock.calls[0]![0])).toEqual(["documentId", "revisionId", "elementId", "opacity"]);
  expect(Object.isFrozen(f.apply.mock.calls[0]![0])).toBe(true); f.resolve(); await f.settled(); f.dispose();
});
it.each(["JSON", "blank", "PNG", "rectangle", "position", "dimensions", "opacity"])("%s busy excludes forced events and preserves feedback", async (origin) => {
  const f = await fixture(); f.ready(); f.opacity.value = ""; f.submit(); const feedback = f.status.textContent;
  f.opacity.value = "0.5";
  if (origin === "opacity") f.submit(); else expect(f.activity.begin()).toBe(true);
  const calls = f.apply.mock.calls.length; const pendingFeedback = f.status.textContent;
  expect([f.opacity.disabled, f.button.disabled]).toEqual([true, true]); expect(f.form.getAttribute("aria-busy")).toBe("true");
  f.controls.setReady(false); f.controls.setReady(true); f.choose("image");
  f.opacity.dispatchEvent(new Event("input", { bubbles: true }));
  f.button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); f.submit();
  expect(f.apply).toHaveBeenCalledTimes(calls); expect(f.activity.end).not.toHaveBeenCalled();
  expect(f.inspector.getSelection()?.elementId).toBe("shape"); expect(f.status.textContent).toBe(pendingFeedback);
  if (origin === "opacity") { f.resolve(); await f.settled(); } else { f.activity.end(); expect(f.status.textContent).toBe(feedback); }
  expect(f.form.getAttribute("aria-busy")).toBe("false"); f.dispose();
});
it.each(["before", "pending", "failed", "sample", "absent", "saved-only"])("startup %s cannot dispatch", async (state) => {
  const f = await fixture();
  if (["sample", "absent", "saved-only"].includes(state)) { f.replace(null); f.ready(); }
  else f.controls.setReady(false);
  f.choose("shape"); f.submit(); expect(f.button.disabled).toBe(true);
  expect(f.activity.begin).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled(); f.dispose();
});
it.each(["document", "revision", "missing", "nonshape", "foreign", "released"])("authoritative %s current cannot reuse an Inspector token", async (kind) => {
  const f = await fixture(); f.ready(); const token = f.inspector.getSelection();
  const next = { ...f.current()! };
  if (kind === "document" || kind === "foreign") next.documentId = "other";
  if (kind === "revision") next.revisionId = "other";
  if (kind === "missing" || kind === "nonshape") next.document = freeze({ ...scene, tracks: [], rootIds: ["root"],
    elements: [{ id: "root", type: "shape", x: 0, y: 0, width: 1, height: 1, opacity: 1 },
      ...(kind === "nonshape" ? [{ id: "shape", type: "group" as const, childrenIds: [] }] : [])] });
  f.borrow(kind === "released" ? null : next); f.controls.syncSelection(); f.submit();
  expect(f.inspector.getSelection()).toEqual(token); expect(f.button.disabled).toBe(true);
  expect(f.activity.begin).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled(); f.dispose();
});
it("begin refusal neither applies nor ends somebody else's activity", async () => {
  const f = await fixture(); f.ready(); f.activity.begin.mockReturnValueOnce(false); f.submit();
  expect(f.apply).not.toHaveBeenCalled(); expect(f.activity.end).not.toHaveBeenCalled(); f.dispose();
});
it("same-source rejection keeps typed value, token and own feedback through later shared settlement", async () => {
  const f = await fixture(); f.ready(); f.opacity.value = "0.875"; const token = f.inspector.getSelection();
  f.replace({ ...f.current()! }); f.controls.syncSelection(); f.submit(); f.reject(new Error("same source failed")); await f.settled();
  expect(f.opacity.value).toBe("0.875"); expect(f.inspector.getSelection()).toEqual(token);
  expect(f.status.textContent).toMatch(/failed/i); const feedback = f.status.textContent;
  f.activity.begin(); f.activity.end(); expect(f.status.textContent).toBe(feedback); expect(f.opacity.value).toBe("0.875"); f.dispose();
});
it.each([false, true])("own committed publication retains truth through END (render fault=%s)", async (fault) => {
  const f = await fixture(); f.ready(); if (fault) f.onPublished.mockImplementation(() => { throw new Error("render after commit"); });
  f.submit(); f.replace({ ...f.current()!, revisionId: "published" }); f.controls.syncSelection();
  expect(f.opacity.value).toBe(""); expect(f.status.dataset.opacityStatus).toBe("pending"); f.resolve(); await f.settled();
  expect(f.onPublished).toHaveBeenCalledTimes(1); expect(f.inspector.getSelection()).toBeNull();
  expect(f.status.textContent).toMatch(fault ? /published.*rendering failed/i : /authored.*tracks/i);
  expect(f.status.textContent).not.toMatch(/rollback|try again/i); f.submit(); expect(f.apply).toHaveBeenCalledTimes(1);
  f.choose("shape"); expect(f.opacity.value).toBe("0.5"); expect(f.inspector.getSelection()?.revisionId).toBe("published"); f.dispose();
});
it.each(["position", "dimensions"])("external %s settles changed document/revision from actual current, even equal values and IDs", async (origin) => {
  const f = await fixture(); f.ready(); f.opacity.value = ""; f.submit();
  const form = document.createElement("form");
  form.innerHTML = "<input><input><button></button><p></p>"; document.body.append(form);
  const inputs = form.querySelectorAll("input");
  const common = { form, button: form.querySelector("button")!, status: form.querySelector("p")!, activity: f.activity,
    getSelection: f.inspector.getSelection, getCurrent: f.getCurrent, onPublished: () => "Other edit published." };
  const applyOther = vi.fn(async () => undefined);
  const other = origin === "position"
    ? mountEditorPositionControls({ ...common, position: { x: inputs[0]!, y: inputs[1]! }, setShapePosition: applyOther })
    : mountEditorDimensionControls({ ...common, dimensions: { width: inputs[0]!, height: inputs[1]! }, setShapeDimensions: applyOther });
  other.setReady(true); other.syncSelection();
  for (const next of [{ ...f.current()!, documentId: "next" }, { ...f.current()!, documentId: "next", revisionId: "next" }]) {
    const ends = f.activity.end.mock.calls.length;
    applyOther.mockImplementationOnce(async () => { f.borrow(next); });
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(f.activity.end).toHaveBeenCalledTimes(ends + 1));
    expect(f.inspector.getSelection()).toBeNull();
    expect(f.opacity.value).toBe(""); expect(f.button.disabled).toBe(true); expect(f.status.dataset.opacityStatus).toBe("idle");
    expect(f.status.textContent).toMatch(/Select a published shape/i); f.submit(); expect(f.apply).not.toHaveBeenCalled();
    f.choose("shape"); other.syncSelection();
    expect(f.opacity.value).toBe("0.5"); expect(f.inspector.getSelection()?.documentId).toBe("next");
  }
  other.dispose(); f.activity.begin(); f.borrow(null); f.activity.end(); expect(f.status.textContent).toMatch(/Create a scene or import JSON/i);
  f.activity.begin(); f.borrow({ documentId: "fresh", revisionId: "fresh", document: scene }); f.activity.end();
  expect(f.inspector.getSelection()).toBeNull(); expect(f.status.textContent).toMatch(/Select a published shape/i); f.dispose();
});
it.each(["apply", "DOM", "notification"])("%s fault still settles acquired activity without claiming rollback", async (fault) => {
  const f = await fixture(); f.ready();
  if (fault === "apply") f.apply.mockImplementationOnce(() => { throw new Error("apply failed"); });
  if (fault === "notification") f.onPublished.mockImplementationOnce(() => { throw new Error("notification failed"); });
  f.submit();
  if (fault === "DOM") vi.spyOn(f.status, "textContent", "set").mockImplementationOnce(() => { throw new Error("DOM failed"); });
  f.resolve(); await f.settled(); expect(f.apply).toHaveBeenCalledTimes(1);
  expect(f.status.textContent).toMatch(fault === "apply" ? /edit failed/i : /published.*rendering failed/i);
  expect(f.status.textContent).not.toMatch(/rollback|try again/i); f.dispose();
});
it("provider failures propagate instead of allowing dispatch against invented metadata", async () => {
  const f = await fixture(); f.ready(); f.getCurrent.mockImplementationOnce(() => { throw new Error("metadata unavailable"); });
  expect(() => f.controls.syncSelection()).toThrow("metadata unavailable");
  expect(f.activity.begin).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled(); f.dispose();
});
it.each([false, true])("controller-first idempotent disposal suppresses late output and callbacks (reject=%s)", async (reject) => {
  const f = await fixture(); f.ready(); f.submit(); const listener = f.add.mock.calls[0]![1] as EventListener;
  f.dispose(); f.dispose(); const before = f.snapshot();
  expect([f.opacity.disabled, f.button.disabled]).toEqual([true, true]);
  expect(f.add).toHaveBeenCalledTimes(1); expect(f.remove).toHaveBeenCalledTimes(1); expect(f.remove.mock.calls[0]).toEqual(f.add.mock.calls[0]);
  expect(f.inspector.getSelection()).toBeNull(); expect(f.notification).toHaveBeenCalled();
  if (reject) f.reject(new Error("failed")); else f.resolve();
  await f.pending.catch(() => undefined); await Promise.resolve(); await Promise.resolve();
  f.controls.setReady(true); f.controls.setBusy(false); f.controls.syncSelection(); f.submit(); listener(new Event("submit", { cancelable: true }));
  expect(f.snapshot()).toBe(before); expect(f.onPublished).not.toHaveBeenCalled(); expect(f.activity.end).not.toHaveBeenCalled();
  expect(f.apply).toHaveBeenCalledTimes(1);
});
