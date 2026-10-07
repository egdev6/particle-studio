import { afterEach, expect, it, vi } from "vitest";
import type { SceneDocumentV1 } from "@particle-studio/scene-document";
import { mountEditorElementInspector, type InspectorCurrent } from "../src/editor-element-inspector.js";
import type { ShapeVisibilityRequest } from "../src/editor-session.js";

type Controls = typeof import("../src/editor-visibility-controls.js")["mountEditorVisibilityControls"];
const scene: SceneDocumentV1 = {
  schemaVersion: 1, durationUs: 1_000_000, seed: 42, loop: true,
  playbackRange: { startUs: 0, endUs: 1_000_000 }, rootIds: ["root", "authored", "shy", "hidden", "image", "line", "text", "particle"],
  elements: [
    { id: "root", type: "shape", x: 0, y: 0, width: 1, height: 1, opacity: 1 },
    { id: "authored", type: "shape", x: 0, y: 0, width: 1, height: 1, opacity: 1, visible: true },
    { id: "shy", type: "shape", x: 0, y: 0, width: 1, height: 1, opacity: 1, visible: false },
    { id: "hidden", type: "group", childrenIds: ["nested"], transform: [1, 0, 0, 1, 0, 0], visible: false },
    { id: "nested", type: "shape", x: 0, y: 0, width: 1, height: 1, opacity: 1 },
    { id: "image", type: "image", x: 0, y: 0, width: 1, height: 1, opacity: 1,
      asset: { sha256: `sha256:${"a".repeat(64)}`, mimeType: "image/png", byteLength: 68, intrinsicWidth: 1, intrinsicHeight: 1 } },
    { id: "line", type: "line", x1: 0, y1: 0, x2: 1, y2: 1, opacity: 1 },
    { id: "text", type: "text", x: 0, y: 0, text: "<script>untrusted</script>", fontSize: 12, opacity: 1 },
    { id: "particle", type: "particle", count: 1, x: 0, y: 0, velocityX: 1, velocityY: 1, spread: 1, size: 1, opacity: 1, lifetimeSteps: 1 },
  ],
  tracks: [],
};
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
freeze(scene);
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

async function fixture(source = scene) {
  document.body.innerHTML = `<select aria-label="Scene element"></select><pre aria-label="Published element JSON"></pre>
    <p id="inspection" role="status" aria-label="Element inspection status"></p>
    <form><label>Shape visible<input type="checkbox"></label><button>Apply visibility</button></form>
    <p id="visibility-status" role="status" aria-label="Visibility status"></p>`;
  const form = document.querySelector("form")!; const select = document.querySelector("select")!;
  const visible = form.querySelector("input")!; const button = form.querySelector("button")!;
  const status = document.querySelector<HTMLElement>("#visibility-status")!;
  let current: InspectorCurrent | null = { documentId: "doc", revisionId: "rev", document: source };
  let controls: ReturnType<Controls> | undefined;
  const notification = vi.fn(() => controls?.syncSelection());
  const inspector = mountEditorElementInspector({ select, details: document.querySelector("pre")!, status: document.querySelector("#inspection")!, onSelectionChange: notification });
  inspector.setCurrent(current); inspector.setReady(true);
  const choose = (id: string) => { select.value = id; select.dispatchEvent(new Event("change")); };
  choose("root");
  expect(inspector.getSelection()).toEqual({ documentId: "doc", revisionId: "rev", elementId: "root" });
  const modulePath = "../src/" + "editor-visibility-controls.js";
  const loaded = await vi.importActual<{ mountEditorVisibilityControls?: Controls }>(modulePath)
    .catch(() => ({}) as { mountEditorVisibilityControls?: Controls });
  expect(typeof loaded.mountEditorVisibilityControls, "healthy published-shape DOM visibility capability").toBe("function");
  let resolve!: () => void; let reject!: (error: Error) => void;
  const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const apply = vi.fn((_request: ShapeVisibilityRequest) => pending);
  const onPublished = vi.fn(() => "Authored visibility published; hidden shapes keep their place.");
  const getCurrent = vi.fn(() => current);
  let busy = false;
  const activity = {
    begin: vi.fn(() => { if (busy) return false; busy = true; controls!.setBusy(true); inspector.setBusy(true); return true; }),
    end: vi.fn(() => { inspector.setCurrent(current); inspector.setBusy(false); busy = false;
      controls!.setBusy(false); controls!.setReady(true); controls!.syncSelection(); }),
  };
  const add = vi.spyOn(form, "addEventListener"); const remove = vi.spyOn(form, "removeEventListener");
  controls = loaded.mountEditorVisibilityControls!({ form, visible, button, status, activity,
    getSelection: inspector.getSelection, getCurrent, setShapeVisibility: apply, onPublished });
  const ready = () => { controls!.setReady(true); controls!.syncSelection(); };
  const submit = () => form.dispatchEvent(new Event("submit", { cancelable: true }));
  const borrow = (value: InspectorCurrent | null) => { current = value; };
  const replace = (value: InspectorCurrent | null) => { borrow(value); inspector.setCurrent(value); };
  const dispose = () => { controls!.dispose(); inspector.dispose(); };
  const settled = () => vi.waitFor(() => expect(activity.end).toHaveBeenCalledTimes(1));
  const snapshot = () => document.body.innerHTML + JSON.stringify([visible.checked, select.value, form.getAttribute("aria-busy")]);
  return { controls, inspector, form, select, visible, button, status, current: () => current, getCurrent, borrow, replace,
    pending, resolve, reject, apply, onPublished, activity, add, remove, notification, ready, choose, submit, dispose, settled, snapshot };
}

it.each([
  ["root", true, "absent"], ["authored", true, "present"], ["shy", false, "present"], ["nested", true, "ancestor"],
] as const)("selection %s prefills checkbox %s for %s without injecting authored fields", async (id, checked, kind) => {
  const f = await fixture(); f.ready(); f.choose(id);
  const element = f.current()!.document.elements.find((candidate) => candidate.id === id)!;
  expect(f.visible.type).toBe("checkbox"); expect(f.visible.checked).toBe(checked);
  expect(f.inspector.getSelection()?.elementId).toBe(id);
  const present = kind === "present";
  expect(Object.prototype.hasOwnProperty.call(element, "visible")).toBe(present);
  if (present) expect((element as { visible?: boolean }).visible).toBe(checked);
  if (kind === "ancestor") expect(f.status.textContent).toMatch(/ancestor|hidden/i);
  else expect(f.status.dataset.visibilityStatus).toBe("idle");
  expect(f.button.disabled).toBe(false);
  expect(f.activity.begin).not.toHaveBeenCalled();
  expect(Object.prototype.hasOwnProperty.call(element, "visible")).toBe(present); f.dispose();
});

it.each(["hidden", "image", "line", "text", "particle"])("%s is inspectable but read-only", async (id) => {
  const f = await fixture(); f.ready(); f.choose(id); const before = JSON.stringify(f.current()!.document); f.submit();
  expect([f.visible.disabled, f.button.disabled]).toEqual([true, true]);
  expect(f.inspector.getSelection()?.elementId).toBe(id);
  expect(f.activity.begin).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
  expect(JSON.stringify(f.current()!.document)).toBe(before); expect(document.querySelector("script")).toBeNull(); f.dispose();
});

it.each([true, false])("explicit Apply captures %s as a frozen four-field request before begin", async (visible) => {
  const f = await fixture(); f.ready(); f.choose("root"); f.visible.checked = visible;
  const read = vi.spyOn(f.visible, "checked", "get");
  f.activity.begin.mockImplementationOnce(() => {
    f.submit(); f.controls.setBusy(true); f.inspector.setBusy(true);
    f.visible.checked = !visible; f.replace({ ...f.current()!, documentId: "next", revisionId: "new" }); f.choose("shy"); return true;
  });
  f.submit(); expect(read).toHaveBeenCalledTimes(1);
  expect(f.apply).toHaveBeenCalledExactlyOnceWith({ documentId: "doc", revisionId: "rev", elementId: "root", visible });
  expect(Object.keys(f.apply.mock.calls[0]![0])).toEqual(["documentId", "revisionId", "elementId", "visible"]);
  expect(Object.isFrozen(f.apply.mock.calls[0]![0])).toBe(true);
  expect(f.status.dataset.visibilityStatus).toBe("pending"); expect([f.visible.disabled, f.button.disabled]).toEqual([true, true]);
  f.submit(); expect(f.apply).toHaveBeenCalledTimes(1); f.resolve(); await f.settled(); f.dispose();
});

it("begin refusal applies nothing, ends nothing and resets own busy", async () => {
  const f = await fixture(); f.ready(); f.activity.begin.mockReturnValueOnce(false); f.submit();
  expect(f.apply).not.toHaveBeenCalled(); expect(f.activity.end).not.toHaveBeenCalled();
  expect([f.visible.disabled, f.button.disabled]).toEqual([false, false]); f.dispose();
});

it.each(["scene", "json", "png", "rectangle", "position", "dimensions", "opacity", "fill-color"])(
  "shared %s origin blocks duplicate dispatch and preserves the draft across busy cycles", async () => {
    const f = await fixture(); f.ready(); f.choose("root"); f.visible.checked = false;
    f.controls.setBusy(true);
    expect([f.visible.disabled, f.button.disabled]).toEqual([true, true]); expect(f.form.getAttribute("aria-busy")).toBe("true");
    const calls = f.apply.mock.calls.length; f.submit(); expect(f.apply).toHaveBeenCalledTimes(calls);
    f.replace({ ...f.current()! }); f.controls.syncSelection(); expect(f.visible.checked).toBe(false);
    f.controls.setBusy(false); expect(f.visible.checked).toBe(false); expect(f.button.disabled).toBe(false); f.dispose();
  });

it("changed source during shared busy clears the draft and restores guidance on settlement", async () => {
  const f = await fixture(); f.ready(); f.choose("root"); f.visible.checked = false;
  const token = f.inspector.getSelection(); f.controls.setBusy(true);
  f.replace({ ...f.current()!, revisionId: "next" }); f.controls.setBusy(false);
  expect(token).not.toBeNull(); expect(f.inspector.getSelection()).toBeNull();
  expect(f.visible.checked).toBe(true); expect(f.button.disabled).toBe(true);
  expect(f.status.dataset.visibilityStatus).toBe("idle");
  expect(f.status.textContent).toMatch(/select a published shape|create a scene or import/i);
  f.submit(); expect(f.apply).not.toHaveBeenCalled(); f.dispose();
});

it("same-source rejection retains draft, token and error for explicit retry", async () => {
  const f = await fixture(); f.ready(); f.choose("root"); f.visible.checked = false;
  const token = f.inspector.getSelection(); f.replace({ ...f.current()! }); f.controls.syncSelection(); f.submit();
  f.reject(new Error("same source failed")); await f.settled();
  expect(f.visible.checked).toBe(false); expect(f.inspector.getSelection()).toEqual(token);
  expect(f.status.dataset.visibilityStatus).toBe("error"); expect(f.status.textContent).toMatch(/failed/i);
  f.submit(); await vi.waitFor(() => expect(f.apply).toHaveBeenCalledTimes(2)); f.dispose();
});

it.each([false, true])("published outcome reports render fault distinctly without rollback (fault=%s)", async (fault) => {
  const f = await fixture(); f.ready(); f.choose("root");
  if (fault) f.onPublished.mockImplementation(() => { throw new Error("render after commit"); });
  f.submit(); f.replace({ ...f.current()!, revisionId: "published" }); f.controls.syncSelection();
  expect(f.status.dataset.visibilityStatus).toBe("pending"); f.resolve(); await f.settled();
  expect(f.onPublished).toHaveBeenCalledTimes(1); expect(f.current()!.revisionId).toBe("published");
  expect(f.status.textContent).toMatch(fault ? /published.*render/i : /published|authored/i);
  expect(f.status.textContent).not.toMatch(/rollback|try again/i); f.dispose();
});

it.each([false, true])("controller-first idempotent disposal suppresses late output and callbacks (reject=%s)", async (reject) => {
  const f = await fixture(); f.ready(); f.choose("root"); f.visible.checked = true; f.submit();
  const listener = f.add.mock.calls[0]![1] as EventListener;
  f.dispose(); f.dispose(); const before = f.snapshot();
  expect([f.visible.disabled, f.button.disabled]).toEqual([true, true]);
  expect(f.add).toHaveBeenCalledTimes(1); expect(f.remove).toHaveBeenCalledTimes(1); expect(f.remove.mock.calls[0]).toEqual(f.add.mock.calls[0]);
  if (reject) f.reject(new Error("failed")); else f.resolve();
  await f.pending.catch(() => undefined); await Promise.resolve(); await Promise.resolve();
  f.controls.setReady(true); f.controls.setBusy(false); f.controls.syncSelection(); f.submit(); listener(new Event("submit", { cancelable: true }));
  expect(f.snapshot()).toBe(before); expect(f.onPublished).not.toHaveBeenCalled(); expect(f.activity.end).not.toHaveBeenCalled();
  expect(f.apply).toHaveBeenCalledTimes(1); f.dispose();
});

// Advanced visibility contract matrix: guard ordering, hostile host surfaces, and settlement phases.

it.each(["ready", "current", "document", "revision", "missing-element", "nonshape"] as const)(
  "authoritative gate blocks dispatch with no session writes when %s is absent or stale", async (kind) => {
    const f = await fixture(); f.ready(); f.choose("root"); const published = f.current()!.document;
    if (kind === "ready") f.controls.setReady(false);
    if (kind === "current") f.borrow(null);
    if (kind === "document") f.borrow({ ...f.current()!, documentId: "other" });
    if (kind === "revision") f.borrow({ ...f.current()!, revisionId: "other" });
    if (kind === "missing-element") f.borrow({ ...f.current()!, document: freeze({ ...scene,
      rootIds: scene.rootIds.filter((id) => id !== "root"), elements: scene.elements.filter((element) => element.id !== "root") }) });
    if (kind === "nonshape") f.choose("hidden");
    const before = JSON.stringify(published); f.submit();
    expect(f.activity.begin).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
    expect(f.activity.end).not.toHaveBeenCalled(); expect(JSON.stringify(published)).toBe(before);
    f.dispose();
  });

it("a throwing checked getter raises no uncaught window error, dispatch, or settlement", async () => {
  const f = await fixture(); f.ready(); f.choose("root"); const errors: ErrorEvent[] = [];
  const onError = (event: ErrorEvent) => { errors.push(event); event.preventDefault(); };
  window.addEventListener("error", onError);
  Object.defineProperty(f.visible, "checked", { configurable: true, get() { throw new Error("hostile checked"); } });
  try {
    expect(() => f.submit()).not.toThrow();
    expect(f.activity.begin).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
    expect(f.activity.end).not.toHaveBeenCalled(); expect(errors).toHaveLength(0);
  } finally {
    window.removeEventListener("error", onError);
    Reflect.deleteProperty(f.visible, "checked"); f.dispose();
  }
});

const rawCheckedValues: readonly [unknown][] = [[0], [1], ["true"], ["false"], [null], [undefined], [{}], [[]], [new Boolean(false)]];
it.each(rawCheckedValues)(
  "raw checked value %o cannot reach the session as an authored boolean", async (raw) => {
    const f = await fixture(); f.ready(); f.choose("root");
    Object.defineProperty(f.visible, "checked", { configurable: true, get: () => raw });
    try {
      f.submit(); expect(f.apply).not.toHaveBeenCalled();
      expect(f.activity.begin).not.toHaveBeenCalled(); expect(f.activity.end).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(f.visible, "checked"); f.dispose();
    }
  });

it("acquisition failure settles without dispatch, settlement, or a stuck local busy flag", async () => {
  const f = await fixture(); f.ready(); f.choose("root"); f.visible.checked = true;
  f.activity.begin.mockImplementationOnce(() => { throw new Error("begin failed"); });
  f.submit(); await Promise.resolve(); await Promise.resolve();
  expect(f.apply).not.toHaveBeenCalled(); expect(f.activity.end).not.toHaveBeenCalled();
  expect([f.visible.disabled, f.button.disabled]).toEqual([false, false]);
  expect(f.status.dataset.visibilityStatus).toBe("error"); f.dispose();
});

it.each(["shared-busy", "dispose"] as const)(
  "a %s reentry during the checked read cancels acquisition before begin", async (mode) => {
    const f = await fixture(); f.ready(); f.choose("root");
    Object.defineProperty(f.visible, "checked", { configurable: true, get: () => {
      if (mode === "dispose") f.controls.dispose(); else f.controls.setBusy(true); return true;
    } });
    try {
      f.submit(); expect(f.activity.begin).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(f.visible, "checked"); f.dispose();
    }
  });

it("disposal inside begin acquires no work and never settles the lane", async () => {
  const f = await fixture(); f.ready(); f.choose("root");
  f.activity.begin.mockImplementationOnce(() => { f.controls.dispose(); return true; });
  f.submit(); await Promise.resolve(); await Promise.resolve();
  expect(f.apply).not.toHaveBeenCalled(); expect(f.activity.end).not.toHaveBeenCalled(); f.dispose();
});

it.each(["button", "visible", "form", "status"] as const)(
  "public syncSelection reports nothing uncaught when the %s host write throws", async (target) => {
    const f = await fixture(); f.ready(); f.choose("root");
    if (target === "button") Object.defineProperty(f.button, "disabled", { configurable: true, get: () => false, set() { throw new Error("hostile button"); } });
    if (target === "visible") Object.defineProperty(f.visible, "checked", { configurable: true, get: () => true, set() { throw new Error("hostile visible"); } });
    if (target === "form") Object.defineProperty(f.form, "setAttribute", { configurable: true, value() { throw new Error("hostile form"); } });
    if (target === "status") Object.defineProperty(f.status, "textContent", { configurable: true, get: () => "", set() { throw new Error("hostile status"); } });
    try {
      f.borrow({ ...f.current()!, revisionId: "next" });
      expect(() => f.controls.syncSelection()).not.toThrow();
    } finally {
      Reflect.deleteProperty(f.button, "disabled"); Reflect.deleteProperty(f.visible, "checked");
      Reflect.deleteProperty(f.form, "setAttribute"); Reflect.deleteProperty(f.status, "textContent"); f.dispose();
    }
  });

it.each(["syncSelection", "setReady", "setBusy", "dispose"] as const)(
  "public %s never throws and reports false availability when the provider throws", async (method) => {
    const f = await fixture(); f.ready(); f.choose("root");
    f.getCurrent.mockImplementation(() => { throw new Error("provider down"); });
    try {
      expect(() => {
        if (method === "syncSelection") f.controls.syncSelection();
        else if (method === "setReady") f.controls.setReady(true);
        else if (method === "setBusy") f.controls.setBusy(true);
        else f.controls.dispose();
      }).not.toThrow();
    } finally {
      f.getCurrent.mockImplementation(() => f.current()); f.dispose();
    }
  });

it("owner settlement failure after publication reports a finishing fault, not a render fault", async () => {
  const f = await fixture(); f.ready(); f.choose("root");
  const settle = f.activity.end.getMockImplementation()!;
  f.activity.end.mockImplementation(() => { settle(); throw new Error("owner end failed"); });
  f.submit(); f.resolve(); await f.settled();
  expect(f.status.dataset.visibilityStatus).toBe("error");
  expect(f.status.textContent).toMatch(/published/i); expect(f.status.textContent).toMatch(/update|finishing|settlement/i);
  expect(f.status.textContent).not.toMatch(/rendering failed/i); f.dispose();
});

it.each(["document", "revision", "missing"] as const)(
  "external settlement after a %s change consumes the stale draft and restores guidance", async (kind) => {
    const f = await fixture(); f.ready(); f.choose("root"); f.visible.checked = false;
    f.controls.setBusy(true);
    if (kind === "document") f.borrow({ ...f.current()!, documentId: "next" });
    else if (kind === "revision") f.borrow({ ...f.current()!, revisionId: "next" });
    else f.borrow(null);
    f.controls.setBusy(false);
    expect(f.visible.checked).toBe(true); expect(f.status.dataset.visibilityStatus).toBe("idle");
    expect(f.status.textContent).toMatch(/select a published shape|create a scene or import/i);
    expect(f.apply).not.toHaveBeenCalled(); f.dispose();
  });

const deepScene = freeze<SceneDocumentV1>({ ...scene, rootIds: [...scene.rootIds, "g1"], elements: [
  ...scene.elements,
  { id: "g1", type: "group", childrenIds: ["g2"], transform: [1, 0, 0, 1, 0, 0] },
  { id: "g2", type: "group", childrenIds: ["g3"], transform: [1, 0, 0, 1, 0, 0], visible: false },
  { id: "g3", type: "group", childrenIds: ["leaf"], transform: [1, 0, 0, 1, 0, 0] },
  { id: "leaf", type: "shape", x: 0, y: 0, width: 1, height: 1, opacity: 1 },
] });

it("a valid three-level hidden ancestor chain keeps authoring enabled with inherited guidance", async () => {
  const f = await fixture(deepScene); f.ready(); f.choose("leaf");
  expect(f.visible.checked).toBe(true); expect(f.button.disabled).toBe(false);
  expect(f.status.textContent).toMatch(/hidden ancestor/i);
  f.submit(); await vi.waitFor(() => expect(f.activity.begin).toHaveBeenCalledTimes(1));
  f.resolve(); await f.settled(); f.dispose();
});

// Complement matrix: bespoke providers, prepublication host faults, same-doc settlement clearing.

it("a throwing getSelection provider cannot break the public syncSelection path", async () => {
  const f = await fixture(); f.ready(); f.choose("root"); f.controls.dispose();
  const loaded = await vi.importActual<{ mountEditorVisibilityControls: Controls }>("../src/" + "editor-visibility-controls.js");
  const getSelection = vi.fn(() => f.inspector.getSelection());
  const ctl = loaded.mountEditorVisibilityControls({ form: f.form, visible: f.visible, button: f.button, status: f.status,
    activity: f.activity, getSelection, getCurrent: f.getCurrent, setShapeVisibility: f.apply, onPublished: f.onPublished });
  ctl.setReady(true);
  getSelection.mockImplementation(() => { throw new Error("provider down"); });
  try {
    expect(() => ctl.syncSelection()).not.toThrow();
    expect(f.activity.begin).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
  } finally {
    getSelection.mockImplementation(() => f.inspector.getSelection()); ctl.dispose(); f.dispose();
  }
});

it.each(["button", "status"] as const)(
  "pending %s failure after acquisition settles exactly once without silent publication", async (target) => {
    const f = await fixture(); f.ready(); f.choose("root");
    f.activity.begin.mockImplementationOnce(() => true);
    if (target === "button") Object.defineProperty(f.button, "disabled", { configurable: true, get: () => false, set() { throw new Error("hostile button"); } });
    if (target === "status") Object.defineProperty(f.status, "textContent", { configurable: true, get: () => "", set() { throw new Error("hostile status"); } });
    try {
      f.submit(); await f.settled();
      expect(f.apply).not.toHaveBeenCalled(); expect(f.onPublished).not.toHaveBeenCalled();
      expect(f.activity.end).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(f.button, "disabled"); Reflect.deleteProperty(f.status, "textContent"); f.dispose();
    }
  });

it("external settlement clears a prior error when the same published doc selection changes", async () => {
  const f = await fixture(); f.ready(); f.choose("root"); f.visible.checked = false;
  f.apply.mockRejectedValueOnce(new Error("rejected once"));
  f.submit(); await f.settled();
  expect(f.status.dataset.visibilityStatus).toBe("error");
  f.controls.setBusy(true); f.choose("shy"); f.controls.setBusy(false);
  expect(f.inspector.getSelection()?.elementId).toBe("shy"); expect(f.visible.checked).toBe(false);
  expect(f.status.dataset.visibilityStatus).toBe("idle");
  expect(f.status.textContent).not.toMatch(/failed|try again/i);
  f.dispose();
});

it("a checked getter that changes the source after the guard still publishes the frozen intent", async () => {
  const f = await fixture(); f.ready(); f.choose("root");
  Object.defineProperty(f.visible, "checked", { configurable: true, get: () => {
    f.borrow({ ...f.current()!, documentId: "next", revisionId: "new" }); return false;
  } });
  try {
    f.submit();
    expect(f.apply).toHaveBeenCalledExactlyOnceWith({ documentId: "doc", revisionId: "rev", elementId: "root", visible: false });
    f.resolve(); await f.settled();
  } finally {
    Reflect.deleteProperty(f.visible, "checked"); f.dispose();
  }
});

it("a transient prefill write failure does not consume the new selection before retry", async () => {
  const f = await fixture(); f.ready(); f.choose("root");
  Object.defineProperty(f.visible, "checked", { configurable: true, get: () => true,
    set() { throw new Error("transient prefill failure"); } });
  try {
    f.choose("shy"); f.submit();
    expect(f.activity.begin).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(f.visible, "checked");
  }
  try {
    f.controls.syncSelection();
    expect(f.inspector.getSelection()?.elementId).toBe("shy");
    expect(f.visible.checked).toBe(false); expect(f.button.disabled).toBe(false);
    expect(f.status.dataset.visibilityStatus).toBe("idle");
  } finally { f.dispose(); }
});
