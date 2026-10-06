import { afterEach, expect, it, vi } from "vitest";
import type { SceneDocumentV1 } from "@particle-studio/scene-document";
import { mountEditorElementInspector, type InspectorCurrent } from "../src/editor-element-inspector.js";
import { mountEditorPositionControls } from "../src/editor-position-controls.js";
import type { ShapeFillColorRequest } from "../src/editor-session.js";

type FillOptions = Omit<Parameters<typeof mountEditorPositionControls>[0], "position" | "setShapePosition"> & {
  fillColor: HTMLInputElement;
  setShapeFillColor: (request: ShapeFillColorRequest) => Promise<unknown>;
};
type MountFill = (options: FillOptions) => ReturnType<typeof mountEditorPositionControls>;
const scene: SceneDocumentV1 = {
  schemaVersion: 1, durationUs: 1_000_000, seed: 42, loop: true,
  playbackRange: { startUs: 0, endUs: 1_000_000 }, rootIds: ["root", "group"],
  elements: [
    { id: "root", type: "shape", x: 0, y: 0, width: 1, height: 1, opacity: 1, fillColor: "#3FA9F5" },
    { id: "group", type: "group", childrenIds: ["shape"], transform: [1, 0, 0, 1, 0, 0] },
    { id: "shape", type: "shape", x: 0, y: 0, width: 1, height: 1, opacity: 1, fillColor: "#3fa9f5" },
    { id: "plain", type: "shape", x: 0, y: 0, width: 1, height: 1, opacity: 1 },
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
    <form><label>Shape fill color<input type="text"></label><button>Apply fill color</button></form>
    <p id="fill-status" role="status" aria-label="Fill color status"></p><p role="status"></p>`;
  const form = document.querySelector("form")!; const select = document.querySelector("select")!;
  const fillColor = form.querySelector("input")!; const button = form.querySelector("button")!;
  const status = document.querySelector<HTMLElement>("#fill-status")!;
  let current: InspectorCurrent | null = { documentId: "doc", revisionId: "rev", document: source };
  let controls: ReturnType<MountFill> | undefined;
  const notification = vi.fn(() => controls?.syncSelection());
  const inspector = mountEditorElementInspector({ select, details: document.querySelector("pre")!, status: document.querySelector("#inspection")!, onSelectionChange: notification });
  inspector.setCurrent(current); inspector.setReady(true);
  const choose = (id: string) => { select.value = id; select.dispatchEvent(new Event("change")); };
  choose("root");
  expect(inspector.getSelection()).toEqual({ documentId: "doc", revisionId: "rev", elementId: "root" });
  const modulePath = "../src/" + "editor-fill-color-controls.js";
  const loaded = await import(/* @vite-ignore */ modulePath).catch((error: unknown) => {
    const target = error instanceof Error ? /(?:Failed to load url|Cannot find module|Cannot find package)\s+['"]?([^'"\s(]+)/i.exec(error.message)?.[1] : undefined;
    if (target === modulePath || target?.endsWith("/apps/editor/src/editor-fill-color-controls.js")) return {};
    throw error;
  }) as { mountEditorFillColorControls?: MountFill };
  expect(typeof loaded.mountEditorFillColorControls, "healthy published-shape DOM fill color capability").toBe("function");
  let resolve!: () => void; let reject!: (error: Error) => void;
  const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const apply = vi.fn((_request: ShapeFillColorRequest) => pending);
  const onPublished = vi.fn(() => "Fill color published; absent colors fall back to black.");
  const getCurrent = vi.fn(() => current);
  let busy = false;
  const activity = {
    begin: vi.fn(() => { if (busy) return false; busy = true; controls!.setBusy(true); inspector.setBusy(true); return true; }),
    end: vi.fn(() => { inspector.setCurrent(current); inspector.setBusy(false); busy = false;
      controls!.setBusy(false); controls!.setReady(true); controls!.syncSelection(); }),
  };
  const add = vi.spyOn(form, "addEventListener"); const remove = vi.spyOn(form, "removeEventListener");
  controls = loaded.mountEditorFillColorControls!({ form, fillColor, button, status, activity,
    getSelection: inspector.getSelection, getCurrent, setShapeFillColor: apply, onPublished });
  const ready = () => { controls!.setReady(true); controls!.syncSelection(); };
  const submit = () => form.dispatchEvent(new Event("submit", { cancelable: true }));
  const borrow = (value: InspectorCurrent | null) => { current = value; };
  const replace = (value: InspectorCurrent | null) => { borrow(value); inspector.setCurrent(value); };
  const dispose = () => { controls!.dispose(); inspector.dispose(); };
  const settled = () => vi.waitFor(() => expect(activity.end).toHaveBeenCalledTimes(1));
  const snapshot = () => document.body.innerHTML + JSON.stringify([fillColor.value, select.value, form.getAttribute("aria-busy")]);
  return { controls, inspector, form, select, fillColor, button, status, current: () => current, getCurrent, borrow, replace,
    pending, resolve, reject, apply, onPublished, activity, add, remove, notification, ready, choose, submit, dispose, settled, snapshot };
}

it.each([["root", "#3FA9F5"], ["shape", "#3fa9f5"], ["plain", ""]])(
  "prefills %s case-exact with black fallback guidance, never inserting a default", async (id, expected) => {
    const f = await fixture(); f.ready(); f.choose(id);
    expect(f.fillColor.type).toBe("text");
    expect(f.fillColor.value).toBe(expected);
    if (id === "plain") {
      expect(f.status.textContent).toMatch(/#000000|black/i);
      expect(f.current()!.document.elements.find((e) => e.id === "plain")).not.toHaveProperty("fillColor");
    }
    f.dispose();
  });
it.each(["", " ", "\n", "#3a9", "#3fa9f5ff", "rebeccapurple", "rgb(63,169,245)", "#3fa9fg", " #3fa9f5", "#3fa9f5 ", "#3fa9f5\n", "3fa9f5"])(
  "rejects raw %j without trimming or side effects", async (value) => {
    const f = await fixture(); f.ready(); f.fillColor.value = value;
    const actual = f.fillColor.value; if (value !== actual) vi.spyOn(f.fillColor, "value", "get").mockReturnValueOnce(value);
    f.submit();
    expect(f.status.dataset.fillColorStatus).toBe("error"); expect(f.status.textContent).toMatch(/fill|color|hex|#RRGGBB/i);
    expect(f.fillColor.value).toBe(actual);
    expect([f.activity.begin, f.apply, f.onPublished].map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
    f.dispose();
  });
it("captures the frozen four-field request once before begin mutates input, selection and reenters", async () => {
  const f = await fixture(); f.ready(); f.fillColor.value = "#0A0B0C";
  const read = vi.spyOn(f.fillColor, "value", "get");
  f.activity.begin.mockImplementationOnce(() => {
    f.submit(); f.controls.setBusy(true); f.inspector.setBusy(true); f.fillColor.value = "#ffffff";
    f.replace({ ...f.current()!, documentId: "next", revisionId: "new" }); f.choose("plain"); return true;
  });
  f.submit();
  expect(read).toHaveBeenCalledTimes(1);
  expect(f.apply).toHaveBeenCalledExactlyOnceWith({ documentId: "doc", revisionId: "rev", elementId: "root", fillColor: "#0A0B0C" });
  expect(Object.keys(f.apply.mock.calls[0]![0])).toEqual(["documentId", "revisionId", "elementId", "fillColor"]);
  expect(Object.isFrozen(f.apply.mock.calls[0]![0])).toBe(true);
  expect(f.status.dataset.fillColorStatus).toBe("pending");
  expect([f.fillColor.disabled, f.button.disabled]).toEqual([true, true]);
  f.resolve(); await f.settled(); f.dispose();
});
it("begin refusal applies nothing and never ends another activity", async () => {
  const f = await fixture(); f.ready(); f.activity.begin.mockReturnValueOnce(false); f.submit();
  expect(f.apply).not.toHaveBeenCalled(); expect(f.activity.end).not.toHaveBeenCalled();
  expect([f.fillColor.disabled, f.button.disabled]).toEqual([false, false]); f.dispose();
});
it("SDK rejection reports an error, keeps input and ends acquired activity once", async () => {
  const f = await fixture(); f.ready(); f.fillColor.value = "#123456"; f.submit();
  f.reject(new Error("fill failed")); await f.settled();
  expect(f.status.dataset.fillColorStatus).toBe("error"); expect(f.status.textContent).toMatch(/failed/i);
  expect(f.activity.end).toHaveBeenCalledTimes(1); expect(f.onPublished).not.toHaveBeenCalled();
  expect(f.fillColor.value).toBe("#123456"); f.dispose();
});
it("same-source refresh preserves typed input and own feedback through shared settlement", async () => {
  const f = await fixture(); f.ready(); f.fillColor.value = "#ABCDEF";
  const token = f.inspector.getSelection();
  f.replace({ ...f.current()! }); f.controls.syncSelection(); f.submit();
  f.reject(new Error("same source failed")); await f.settled();
  expect(f.fillColor.value).toBe("#ABCDEF"); expect(f.inspector.getSelection()).toEqual(token);
  expect(f.status.textContent).toMatch(/failed/i); const feedback = f.status.textContent;
  f.activity.begin(); f.activity.end(); expect(f.status.textContent).toBe(feedback);
  expect(f.fillColor.value).toBe("#ABCDEF"); f.dispose();
});
it.each([["next", "rev"], ["doc", "next"]])("changed %s/%s source requires reselection and fresh guidance", async (documentId, revisionId) => {
  const f = await fixture(); f.ready();
  f.activity.begin(); f.borrow({ ...f.current()!, documentId, revisionId }); f.activity.end();
  expect(f.inspector.getSelection()).toBeNull(); expect(f.fillColor.value).toBe("");
  expect(f.button.disabled).toBe(true); expect(f.status.dataset.fillColorStatus).toBe("idle");
  expect(f.status.textContent).toMatch(/select a published shape/i);
  f.fillColor.value = "#111111"; f.submit(); expect(f.apply).not.toHaveBeenCalled();
  f.choose("root"); expect(f.fillColor.value).toBe("#3FA9F5"); f.dispose();
});
it.each([false, true])("own committed publication keeps truth through END (render fault=%s)", async (fault) => {
  const f = await fixture(); f.ready();
  if (fault) f.onPublished.mockImplementation(() => { throw new Error("render after commit"); });
  f.submit(); f.replace({ ...f.current()!, revisionId: "published" }); f.controls.syncSelection();
  expect(f.status.dataset.fillColorStatus).toBe("pending"); f.resolve(); await f.settled();
  expect(f.onPublished).toHaveBeenCalledTimes(1);
  expect(f.status.textContent).toMatch(fault ? /published.*rendering failed/i : /published|authored/i);
  expect(f.status.textContent).not.toMatch(/rollback|try again/i);
  f.submit(); expect(f.apply).toHaveBeenCalledTimes(1); f.dispose();
});
it.each(["nonshape", "stale", "missing", "startup"])("authoritative %s current cannot dispatch", async (kind) => {
  const f = await fixture(); if (kind === "startup") f.controls.setReady(false); else f.ready();
  if (kind === "stale") f.borrow({ ...f.current()!, revisionId: "other" });
  if (kind === "missing") f.borrow({ ...f.current()!, document: freeze({ ...scene, elements: scene.elements.filter((e) => e.id !== "root") }) });
  if (kind === "nonshape") f.borrow({ ...f.current()!, document: freeze({ ...scene, elements: [{ id: "root", type: "group" as const, childrenIds: [] }] }) });
  f.controls.syncSelection(); f.submit();
  expect(f.button.disabled).toBe(true); expect(f.activity.begin).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled(); f.dispose();
});
it.each([false, true])("dispose is idempotent and suppresses late output and listeners (reject=%s)", async (reject) => {
  const f = await fixture(); f.ready(); f.fillColor.value = "#222222"; f.submit();
  const listener = f.add.mock.calls[0]![1] as EventListener;
  f.dispose(); f.dispose(); const before = f.snapshot();
  expect([f.fillColor.disabled, f.button.disabled]).toEqual([true, true]);
  expect(f.remove).toHaveBeenCalledTimes(1); expect(f.remove.mock.calls[0]).toEqual(f.add.mock.calls[0]);
  expect(f.inspector.getSelection()).toBeNull(); expect(f.notification).toHaveBeenCalled();
  if (reject) f.reject(new Error("failed")); else f.resolve();
  await f.pending.catch(() => undefined); await Promise.resolve(); await Promise.resolve();
  f.controls.setReady(true); f.controls.setBusy(false); f.controls.syncSelection(); f.submit(); listener(new Event("submit", { cancelable: true }));
  expect(f.snapshot()).toBe(before); expect(f.onPublished).not.toHaveBeenCalled(); expect(f.activity.end).not.toHaveBeenCalled();
  expect(f.apply).toHaveBeenCalledTimes(1);
});
