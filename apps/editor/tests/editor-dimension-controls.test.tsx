import { afterEach, expect, it, vi } from "vitest";
import type { SceneDocumentV1 } from "@particle-studio/scene-document";
import { mountEditorElementInspector, type InspectorCurrent } from "../src/editor-element-inspector.js";
import type { mountEditorPositionControls } from "../src/editor-position-controls.js";
import type { ShapeDimensionsRequest } from "../src/editor-session.js";

type DimensionOptions = Omit<Parameters<typeof mountEditorPositionControls>[0], "position" | "setShapePosition"> & {
  dimensions: Readonly<Record<"width" | "height", HTMLInputElement>>;
  setShapeDimensions: (request: ShapeDimensionsRequest) => Promise<unknown>;
};
type MountDimensions = (options: DimensionOptions) => ReturnType<typeof mountEditorPositionControls>;
const documentData: SceneDocumentV1 = {
  schemaVersion: 1, durationUs: 1_000_000, seed: 42, loop: true,
  playbackRange: { startUs: 0, endUs: 1_000_000 }, rootIds: ["root", "group"],
  elements: [
    { id: "root", type: "shape", x: 1, y: 2, width: 0, height: -3, opacity: 1 },
    { id: "group", type: "group", childrenIds: ["shape", "line", "text", "particle", "image"], transform: [1, 0, 0, 1, 100, 200] },
    { id: "shape", type: "shape", x: -2.5, y: 7.25, width: 20, height: 30, opacity: 1 },
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
freeze(documentData);
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
async function fixture() {
  document.body.innerHTML = `<select aria-label="Scene element"></select><pre aria-label="Published element JSON"></pre>
    <p id="inspection" role="status" aria-label="Element inspection status"></p>
    <form><label>Dimension width<input id="width"></label><label>Dimension height<input id="height"></label>
    <button>Apply dimensions</button></form><p id="dimensions-status" role="status" aria-label="Dimension status"></p>
    <textarea aria-label="Editable JSON">{"width":999,"height":999}</textarea><p role="status"></p>`;
  const form = document.querySelector("form")!; const select = document.querySelector("select")!;
  const width = document.querySelector<HTMLInputElement>("#width")!; const height = document.querySelector<HTMLInputElement>("#height")!;
  const button = form.querySelector("button")!; const status = document.querySelector<HTMLElement>("#dimensions-status")!;
  let current: InspectorCurrent | null = { documentId: "doc", revisionId: "rev", document: documentData };
  let controls: ReturnType<MountDimensions>;
  const inspector = mountEditorElementInspector({ select, details: document.querySelector("pre")!,
    status: document.querySelector("#inspection")!, onSelectionChange: () => controls?.syncSelection() });
  inspector.setCurrent(current); inspector.setReady(true);
  // Resolve only after genuine accessible DOM and published inspection exist.
  // A missing capability fails this assertion, never suite/module collection.
  const modulePath = "../src/" + "editor-dimension-controls.js";
  const loaded = await import(/* @vite-ignore */ modulePath).catch(() => ({})) as { mountEditorDimensionControls?: MountDimensions };
  expect(typeof loaded.mountEditorDimensionControls, "published-shape DOM dimension controller capability").toBe("function");
  let resolve!: () => void; let reject!: (error: Error) => void;
  const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const apply = vi.fn((_request: ShapeDimensionsRequest) => pending); const onPublished = vi.fn(() => "Rendered current.");
  let busy = false;
  const activity = {
    begin: vi.fn(() => { if (busy) return false; busy = true; controls.setBusy(true); inspector.setBusy(true); return true; }),
    end: vi.fn(() => {
      inspector.setCurrent(current); inspector.setBusy(false); busy = false; controls.setBusy(false);
      controls.setReady(true); controls.syncSelection();
    }),
  };
  const add = vi.spyOn(form, "addEventListener"); const remove = vi.spyOn(form, "removeEventListener");
  controls = loaded.mountEditorDimensionControls!({ form, dimensions: { width, height }, button, status, activity,
    getSelection: inspector.getSelection, getCurrent: () => current, setShapeDimensions: apply, onPublished });
  const ready = () => { controls.setReady(true); controls.syncSelection(); };
  const choose = (id: string) => { select.value = id; select.dispatchEvent(new Event("change")); };
  const submit = () => form.dispatchEvent(new Event("submit", { cancelable: true }));
  const borrow = (value: InspectorCurrent | null) => { current = value; };
  const replace = (value: InspectorCurrent | null) => { borrow(value); inspector.setCurrent(value); };
  const dispose = () => { controls.dispose(); inspector.dispose(); };
  const settled = () => vi.waitFor(() => expect(activity.end).toHaveBeenCalledTimes(1));
  const snapshot = () => document.body.innerHTML + JSON.stringify([width.value, height.value, select.value]);
  return { controls, inspector, form, select, width, height, button, status, current: () => current,
    borrow, replace, pending, resolve, reject, apply, onPublished, activity, add, remove, ready, choose, submit, dispose, settled, snapshot };
}
it("gates startup and selection, prefills root/nested immutable authored metadata without DOM-label or JSON authority", async () => {
  const f = await fixture(); f.choose("shape"); f.submit(); expect(f.apply).not.toHaveBeenCalled();
  const before = JSON.stringify(documentData); const clone = vi.spyOn(globalThis, "structuredClone");
  f.ready(); f.choose(""); f.submit(); expect(f.button.disabled).toBe(true); expect(f.activity.begin).not.toHaveBeenCalled();
  f.select.querySelector('option[value="shape"]')!.textContent = "shape width=999 height=999"; f.choose("shape");
  expect([f.width.value, f.height.value]).toEqual(["20", "30"]); expect(f.button.disabled).toBe(false);
  f.choose("root"); expect([f.width.value, f.height.value]).toEqual(["0", "-3"]);
  expect(f.current()!.document).toBe(documentData); expect(Object.isFrozen(documentData.elements[2])).toBe(true);
  expect(JSON.stringify(documentData)).toBe(before); expect(clone).not.toHaveBeenCalled();
  expect(document.querySelectorAll('[role="status"]:not([aria-label])')).toHaveLength(1);
  expect(f.status.getAttribute("aria-label")).toBe("Dimension status"); f.dispose();
});
it.each(["group", "line", "text", "particle", "image"])("%s remains inspectable but cannot submit dimensions", async (id) => {
  const f = await fixture(); f.ready(); f.choose(id); f.submit();
  expect([f.width.disabled, f.height.disabled, f.button.disabled]).toEqual([true, true, true]);
  expect(f.status.textContent).toMatch(/shape/i); expect(f.activity.begin).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
  expect(JSON.parse(document.querySelector("pre")!.textContent!)).toEqual(documentData.elements.find((element) => element.id === id));
  expect(document.querySelector("script")).toBeNull(); f.dispose();
});
it.each(["", " \t ", "NaN", "Infinity", "-Infinity", "1oops", "0", "-0", "-1", "-0.5"])(
  "rejects either malformed/nonpositive dimension %j before activity", async (value) => {
    const f = await fixture(); f.ready(); f.choose("shape");
    for (const axis of ["width", "height"] as const) {
      f.width.value = "20"; f.height.value = "30"; f[axis].value = value; f.submit();
      expect(f.status.textContent).toMatch(/finite|positive|empty|required/i);
    }
    expect(f.activity.begin).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled(); expect(f.onPublished).not.toHaveBeenCalled(); f.dispose();
  },
);
it.each([[0.125, 3.75], [Number.MAX_VALUE, Number.MIN_VALUE], [20, 30], [1, 1]])(
  "publishes positive finite pair %s/%s atomically, including equal authored values", async (width, height) => {
    const f = await fixture(); f.ready(); f.choose("shape"); f.width.value = ` ${width} `; f.height.value = ` ${height} `; f.submit();
    expect(f.apply).toHaveBeenCalledExactlyOnceWith({ documentId: "doc", revisionId: "rev", elementId: "shape", width, height });
    expect(f.status.textContent).toMatch(/pending/i); expect(f.onPublished).not.toHaveBeenCalled(); f.resolve(); await f.settled(); f.dispose();
  },
);
it("captures each input once and five frozen scalars before synchronous busy callbacks mutate source and selection", async () => {
  const f = await fixture(); f.ready(); f.choose("root"); f.width.value = "5.5"; f.height.value = "7.25";
  const widthRead = vi.spyOn(f.width, "value", "get"); const heightRead = vi.spyOn(f.height, "value", "get");
  f.activity.begin.mockImplementationOnce(() => {
    f.controls.setBusy(true); f.inspector.setBusy(true); f.width.value = "999"; f.height.value = "999";
    f.replace({ ...f.current()!, documentId: "next-doc", revisionId: "next-rev" }); return true;
  });
  f.submit(); f.submit(); expect(widthRead).toHaveBeenCalledTimes(1); expect(heightRead).toHaveBeenCalledTimes(1);
  expect(f.apply).toHaveBeenCalledExactlyOnceWith({ documentId: "doc", revisionId: "rev", elementId: "root", width: 5.5, height: 7.25 });
  expect(Object.isFrozen(f.apply.mock.calls[0]![0])).toBe(true); expect(Object.getPrototypeOf(f.apply.mock.calls[0]![0])).toBe(Object.prototype);
  f.resolve(); await f.settled(); expect(f.status.textContent).toContain("Rendered current."); f.dispose();
});
it.each(["JSON", "blank", "PNG", "rectangle", "position", "dimensions"])(
  "%s activity excludes forced dimension submit/click/select until settlement", async (origin) => {
    const f = await fixture(); f.ready(); f.choose("shape");
    // External origins borrow the same existing entry activity; dimensions owns it through submit.
    if (origin === "dimensions") f.submit(); else expect(f.activity.begin()).toBe(true);
    const calls = f.apply.mock.calls.length; expect(f.form.getAttribute("aria-busy")).toBe("true");
    expect([f.width.disabled, f.height.disabled, f.button.disabled]).toEqual([true, true, true]);
    f.choose("image"); f.button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); f.submit();
    expect(f.inspector.getSelection()?.elementId).toBe("shape"); expect(f.apply).toHaveBeenCalledTimes(calls);
    if (origin === "dimensions") { f.resolve(); await f.settled(); } else f.activity.end();
    expect(f.form.getAttribute("aria-busy")).toBe("false"); f.dispose();
  },
);
it("denies not-ready, null current and authoritative activity refusal even on forced submit", async () => {
  const f = await fixture(); f.ready(); f.choose("shape"); f.controls.setReady(false); f.submit();
  expect(f.activity.begin).not.toHaveBeenCalled(); f.controls.setReady(true); f.activity.begin.mockReturnValueOnce(false); f.submit();
  expect(f.apply).not.toHaveBeenCalled(); f.replace(null); f.controls.syncSelection(); f.submit();
  expect(f.button.disabled).toBe(true); expect(f.activity.begin).toHaveBeenCalledTimes(1); f.dispose();
});
it.each(["document", "revision", "missing", "nonshape"])("never retargets a retained token against %s metadata", async (kind) => {
  const f = await fixture(); f.ready(); f.choose("shape"); const metadata = { ...f.current()! };
  if (kind === "document") metadata.documentId = "foreign";
  if (kind === "revision") metadata.revisionId = "newer";
  if (kind === "missing" || kind === "nonshape") metadata.document = { ...documentData, tracks: [], rootIds: ["root"],
    elements: [{ id: kind === "missing" ? "root" : "shape", type: "group", childrenIds: [] }] };
  f.borrow(metadata); f.controls.syncSelection(); f.submit();
  expect(f.inspector.getSelection()).toEqual({ documentId: "doc", revisionId: "rev", elementId: "shape" });
  expect(f.button.disabled).toBe(true); expect(f.activity.begin).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled(); f.dispose();
});
it("same-source SDK rejection preserves typed pair/token/result across shared END and refresh", async () => {
  const f = await fixture(); f.ready(); f.choose("shape"); f.width.value = "81.25"; f.height.value = "12.5";
  f.replace({ ...f.current()! }); f.controls.syncSelection(); f.submit(); f.reject(new Error("same source failed")); await f.settled();
  expect([f.width.value, f.height.value]).toEqual(["81.25", "12.5"]);
  expect(f.inspector.getSelection()).toEqual({ documentId: "doc", revisionId: "rev", elementId: "shape" });
  expect(f.status.textContent).toMatch(/failed/i); const result = f.status.textContent;
  f.activity.begin(); f.activity.end(); expect(f.status.textContent).toBe(result);
  expect([f.width.value, f.height.value]).toEqual(["81.25", "12.5"]); f.dispose();
});
it.each([false, true])("own publication preserves truthful result through busy refresh/END (render failure=%s)", async (renderFailure) => {
  const f = await fixture(); f.ready(); f.choose("shape");
  if (renderFailure) f.onPublished.mockImplementation(() => { throw new Error("render failed after commit"); });
  f.submit(); f.replace({ ...f.current()!, revisionId: "published" }); f.controls.syncSelection();
  expect([f.width.value, f.height.value]).toEqual(["", ""]); expect(f.status.textContent).toMatch(/pending/i);
  f.resolve(); await f.settled(); expect(f.onPublished).toHaveBeenCalledTimes(1);
  expect(f.status.textContent).toMatch(renderFailure ? /published.*rendering failed/i : /Rendered current/);
  expect(f.status.textContent).not.toMatch(/rollback|try again/i); expect(f.inspector.getSelection()).toBeNull();
  f.submit(); expect(f.apply).toHaveBeenCalledTimes(1); f.choose("shape");
  expect(f.inspector.getSelection()?.revisionId).toBe("published"); expect([f.width.value, f.height.value]).toEqual(["20", "30"]); f.dispose();
});
it.each(["document", "revision", "current-to-null", "null-to-current"])(
  "external %s settlement refreshes actual guidance and requires explicit reselection", async (kind) => {
    const f = await fixture(); if (kind === "null-to-current") f.replace(null); f.ready();
    if (kind !== "null-to-current") f.choose("shape"); f.activity.begin();
    const next = { documentId: kind === "document" ? "next-doc" : "doc", revisionId: "next-rev", document: documentData };
    if (kind === "document") next.revisionId = "rev";
    f.borrow(kind === "current-to-null" ? null : next); f.activity.end();
    expect(f.inspector.getSelection()).toBeNull(); expect([f.width.value, f.height.value]).toEqual(["", ""]);
    expect([f.width.disabled, f.height.disabled, f.button.disabled]).toEqual([true, true, true]);
    expect(f.status.dataset.dimensionStatus).toBe("idle");
    expect(f.status.textContent).toMatch(kind === "current-to-null" ? /Create a scene or import JSON/i : /Select a published shape/i);
    f.submit(); expect(f.apply).not.toHaveBeenCalled(); expect(f.onPublished).not.toHaveBeenCalled();
    if (kind !== "current-to-null") { f.choose("shape"); expect(f.inspector.getSelection()?.revisionId).toBe(next.revisionId); }
    f.dispose();
  },
);
it.each([false, true])("idempotent controller-first disposal removes listener and suppresses late output/callbacks (reject=%s)", async (reject) => {
  const f = await fixture(); f.ready(); f.choose("shape"); f.submit(); const listener = f.add.mock.calls[0]![1] as EventListener;
  f.dispose(); f.dispose(); const before = f.snapshot();
  expect([f.width.disabled, f.height.disabled, f.button.disabled]).toEqual([true, true, true]);
  expect(f.add).toHaveBeenCalledTimes(1); expect(f.remove).toHaveBeenCalledTimes(1); expect(f.remove.mock.calls[0]).toEqual(f.add.mock.calls[0]);
  if (reject) f.reject(new Error("failed")); else f.resolve();
  await f.pending.catch(() => undefined); await Promise.resolve(); await Promise.resolve();
  f.controls.setReady(true); f.controls.setBusy(false); f.controls.syncSelection(); f.submit(); listener(new Event("submit", { cancelable: true }));
  expect(f.snapshot()).toBe(before); expect(f.onPublished).not.toHaveBeenCalled(); expect(f.activity.end).not.toHaveBeenCalled();
  expect(f.apply).toHaveBeenCalledTimes(1);
});
