import { afterEach, expect, it, vi } from "vitest";
import type { SceneDocumentV1 } from "@particle-studio/scene-document";
import { mountEditorElementInspector } from "../src/editor-element-inspector.js";
import { mountEditorPositionControls } from "../src/editor-position-controls.js";

const documentData: SceneDocumentV1 = {
  schemaVersion: 1, durationUs: 1_000_000, seed: 42, loop: true,
  playbackRange: { startUs: 0, endUs: 1_000_000 }, rootIds: ["group"], tracks: [],
  elements: [
    { id: "group", type: "group", childrenIds: ["shape", "line", "text", "particle", "image"], transform: [1, 0, 0, 1, 100, 200] },
    { id: "shape", type: "shape", x: -2.5, y: 7.25, width: 20, height: 30, opacity: 1 },
    { id: "line", type: "line", x1: 0, y1: 0, x2: 1, y2: 1, opacity: 1 },
    { id: "text", type: "text", x: 0, y: 0, text: "<script>untrusted</script>", fontSize: 12, opacity: 1 },
    { id: "particle", type: "particle", count: 1, x: 0, y: 0, velocityX: 1, velocityY: 1, spread: 1, size: 1, opacity: 1, lifetimeSteps: 1 },
    { id: "image", type: "image", x: 0, y: 0, width: 1, height: 1, opacity: 1,
      asset: { sha256: `sha256:${"a".repeat(64)}`, mimeType: "image/png", byteLength: 68, intrinsicWidth: 1, intrinsicHeight: 1 } },
  ],
};
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
freeze(documentData);
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
function fixture() {
  document.body.innerHTML = `<select aria-label="Scene element"></select><pre aria-label="Published element JSON"></pre>
    <p id="inspection" role="status" aria-label="Element inspection status"></p>
    <form id="position"><label>Position X<input id="x"></label><label>Position Y<input id="y"></label>
    <button>Apply position</button></form><p id="position-status" role="status" aria-label="Position status"></p>
    <textarea aria-label="Editable JSON">not published JSON</textarea><p role="status"></p>`;
  const form = document.querySelector<HTMLFormElement>("form")!;
  const x = document.querySelector<HTMLInputElement>("#x")!; const y = document.querySelector<HTMLInputElement>("#y")!;
  const button = form.querySelector("button")!; const status = document.querySelector<HTMLElement>("#position-status")!;
  const select = document.querySelector("select")!;
  let current: { documentId: string; revisionId: string; document: SceneDocumentV1 } | null = {
    documentId: "doc", revisionId: "rev", document: documentData,
  };
  let resolve!: () => void; let reject!: (error: Error) => void;
  const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const apply = vi.fn((_request: { documentId: string; revisionId: string; elementId: string; x: number; y: number }) => pending);
  const onPublished = vi.fn(() => "Rendered current.");
  let busy = false;
  // The optional notification must not run while mounting the inspector. Both
  // components exist before ready/current synchronization starts.
  const changed = vi.fn(() => controls.syncSelection());
  const inspector = mountEditorElementInspector({ select, details: document.querySelector("pre")!,
    status: document.querySelector("#inspection")!, onSelectionChange: changed });
  const activity = {
    begin: vi.fn(() => { if (busy) return false; busy = true; controls.setBusy(true); inspector.setBusy(true); return true; }),
    end: vi.fn(() => {
      inspector.setCurrent(current); inspector.setBusy(false); busy = false; controls.setBusy(false);
      controls.setReady(true); controls.syncSelection();
    }),
  };
  const add = vi.spyOn(form, "addEventListener"); const remove = vi.spyOn(form, "removeEventListener");
  const controls = mountEditorPositionControls({ form, position: { x, y }, button, status, activity,
    getSelection: inspector.getSelection, getCurrent: () => current, setShapePosition: apply, onPublished });
  const ready = () => { inspector.setCurrent(current); inspector.setReady(true); controls.setReady(true); controls.syncSelection(); };
  const choose = (id: string) => { select.value = id; select.dispatchEvent(new Event("change")); };
  const submit = () => form.dispatchEvent(new Event("submit", { cancelable: true }));
  const snapshot = () => document.body.innerHTML + JSON.stringify([x.value, y.value, select.value]);
  const dispose = () => { controls.dispose(); inspector.dispose(); };
  return { controls, inspector, form, x, y, button, status, current: () => current,
    replace: (value: typeof current) => { current = value; inspector.setCurrent(value); },
    borrow: (value: typeof current) => { current = value; },
    pending, resolve, reject, apply, onPublished, activity, add, remove, ready, choose, submit, snapshot, dispose, changed };
}

it("explicit initial synchronization is safe and prefills immutable authored local metadata only", () => {
  const f = fixture(); expect(f.changed).not.toHaveBeenCalled(); f.submit(); expect(f.apply).not.toHaveBeenCalled();
  const clone = vi.spyOn(globalThis, "structuredClone"); const before = JSON.stringify(documentData);
  f.ready(); expect(f.button.disabled).toBe(true); f.choose("shape");
  expect(f.x.value).toBe("-2.5"); expect(f.y.value).toBe("7.25"); expect(f.button.disabled).toBe(false);
  expect(Object.isFrozen(f.current()!.document.elements[1])).toBe(true);
  expect(f.current()!.document).toBe(documentData); expect(JSON.stringify(documentData)).toBe(before);
  expect(clone).not.toHaveBeenCalled();
  expect(document.querySelectorAll('[role="status"]:not([aria-label])')).toHaveLength(1);
  expect(f.status.getAttribute("aria-label")).toBe("Position status"); f.dispose();
});
it.each(["group", "line", "text", "particle", "image"])("%s remains inspectable with disabled position guidance", (id) => {
  const f = fixture(); f.ready(); f.choose(id); f.submit();
  expect(f.x.disabled).toBe(true); expect(f.y.disabled).toBe(true); expect(f.button.disabled).toBe(true);
  expect(f.status.textContent).toMatch(/shape/i); expect(f.apply).not.toHaveBeenCalled();
  expect(JSON.parse(document.querySelector("pre")!.textContent!)).toEqual(documentData.elements.find((element) => element.id === id));
  expect(document.querySelector("script")).toBeNull(); f.dispose();
});
it.each([["x", ""], ["y", " "], ["x", "NaN"], ["y", "Infinity"], ["x", "-Infinity"], ["y", "1oops"]] as const)(
  "rejects %s=%s before acquiring work", (axis, value) => {
    const f = fixture(); f.ready(); f.choose("shape"); f[axis].value = value; f.submit();
    expect(f.status.textContent).toMatch(/finite|empty|required/i);
    expect(f.activity.begin).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled(); f.dispose();
  },
);
it("captures a frozen plain token and atomic values before busy callbacks, preserving typed same-source fields", async () => {
  const f = fixture(); f.ready(); f.choose("shape"); f.x.value = "-12.5"; f.y.value = "3.75";
  f.activity.begin.mockImplementationOnce(() => {
    f.controls.setBusy(true); f.inspector.setBusy(true); f.x.value = "999"; f.y.value = "999"; return true;
  });
  f.submit(); f.submit();
  expect(f.apply).toHaveBeenCalledExactlyOnceWith({ documentId: "doc", revisionId: "rev", elementId: "shape", x: -12.5, y: 3.75 });
  const input = f.apply.mock.calls[0]![0]; expect(Object.isFrozen(input)).toBe(true);
  expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
  f.choose("image"); expect(f.inspector.getSelection()?.elementId).toBe("shape");
  f.reject(new Error("same source failed")); await f.pending.catch(() => undefined);
  await vi.waitFor(() => expect(f.activity.end).toHaveBeenCalledTimes(1));
  expect(f.inspector.getSelection()?.elementId).toBe("shape"); expect(f.x.value).toBe("999");
  expect(f.status.textContent).toMatch(/failed/i); f.dispose();
});
it("same-source refresh and busy changes never overwrite typed values; identity change clears selection", () => {
  const f = fixture(); f.ready(); f.choose("shape"); f.x.value = "81.25";
  f.replace({ ...f.current()! }); f.controls.syncSelection(); f.controls.setBusy(true); f.inspector.setBusy(true);
  f.choose("image"); f.controls.syncSelection(); f.inspector.setBusy(false); f.controls.setBusy(false);
  expect(f.x.value).toBe("81.25");
  f.replace({ ...f.current()!, revisionId: "successor" }); f.controls.syncSelection();
  expect(f.inspector.getSelection()).toBeNull(); expect(f.button.disabled).toBe(true);
  f.choose("shape"); expect(f.x.value).toBe("-2.5"); f.dispose();
});
it.each(["new source", "unavailable current"] as const)(
  "external activity settles with truthful idle guidance after %s", (settlement) => {
    const f = fixture(); f.ready(); f.choose("shape");
    expect(f.status.textContent).toContain("Edit both authored local coordinates");
    expect(f.activity.begin()).toBe(true);
    expect(f.inspector.getSelection()?.elementId).toBe("shape");
    // Do not refresh inspection early: activity.end must discover actual current
    // while position's shared-busy flag is still set, exactly as in the entry.
    f.borrow(settlement === "new source" ? { ...f.current()!, documentId: "next-doc", revisionId: "next-rev" } : null);
    f.activity.end();
    expect(f.form.getAttribute("aria-busy")).toBe("false");
    expect(f.inspector.getSelection()).toBeNull();
    expect(f.x.value).toBe(""); expect(f.y.value).toBe("");
    expect(f.x.disabled).toBe(true); expect(f.y.disabled).toBe(true); expect(f.button.disabled).toBe(true);
    expect(f.status.dataset.positionStatus).toBe("idle");
    expect(f.status.textContent).toContain(settlement === "new source"
      ? "Select a published shape" : "Create a scene or import JSON");
    expect(f.status.textContent).not.toContain("Edit both");
    f.submit(); expect(f.apply).not.toHaveBeenCalled(); expect(f.onPublished).not.toHaveBeenCalled();
    f.dispose();
  },
);
it.each([false, true])("equal position publishes normally and resets selection even after render failure=%s", async (renderFailure) => {
  const f = fixture(); f.ready(); f.choose("shape");
  if (renderFailure) f.onPublished.mockImplementation(() => { throw new Error("render failed after commit"); });
  f.submit(); expect(f.apply).toHaveBeenCalledExactlyOnceWith({ documentId: "doc", revisionId: "rev", elementId: "shape", x: -2.5, y: 7.25 });
  f.replace({ ...f.current()!, revisionId: "published" }); f.resolve();
  await vi.waitFor(() => expect(f.activity.end).toHaveBeenCalledTimes(1));
  expect(f.inspector.getSelection()).toBeNull(); expect(f.button.disabled).toBe(true);
  expect(f.status.textContent).toMatch(renderFailure ? /published.*rendering failed/i : /Rendered current/);
  expect(f.status.textContent).not.toMatch(/rollback|try again/i); f.choose("shape");
  expect(f.inspector.getSelection()?.revisionId).toBe("published"); f.dispose();
});
it.each(["document", "revision", "missing", "nonshape"])("rejects a retained token against mismatched %s metadata", (kind) => {
  const f = fixture(); f.ready(); f.choose("shape");
  const metadata = { ...f.current()! };
  if (kind === "document") metadata.documentId = "foreign";
  if (kind === "revision") metadata.revisionId = "newer";
  if (kind === "missing") metadata.document = { ...documentData, tracks: [], rootIds: ["root"],
    elements: [{ id: "root", type: "group", childrenIds: [] }] };
  if (kind === "nonshape") metadata.document = { ...documentData, tracks: [], rootIds: ["shape"],
    elements: [{ id: "shape", type: "group", childrenIds: [] }] };
  f.borrow(metadata); f.controls.syncSelection(); f.submit();
  expect(f.inspector.getSelection()).toEqual({ documentId: "doc", revisionId: "rev", elementId: "shape" });
  expect(f.button.disabled).toBe(true); expect(f.apply).not.toHaveBeenCalled();
  expect(f.activity.begin).not.toHaveBeenCalled(); f.dispose();
});
it("cross-checks selection against actual borrowed current and denies not-ready/null/shared busy permission", () => {
  const f = fixture(); f.ready(); f.choose("shape"); f.controls.setReady(false); f.submit();
  expect(f.apply).not.toHaveBeenCalled(); f.controls.setReady(true);
  f.activity.begin.mockReturnValue(false); f.submit(); expect(f.apply).not.toHaveBeenCalled();
  f.replace(null); f.controls.syncSelection(); f.submit(); expect(f.button.disabled).toBe(true);
  expect(f.apply).not.toHaveBeenCalled(); f.dispose();
});
it.each([false, true])("position-first disposal freezes DOM, late listener and settlement (reject=%s)", async (reject) => {
  const f = fixture(); f.ready(); f.choose("shape"); f.submit();
  const listener = f.add.mock.calls[0]![1] as EventListener;
  f.dispose(); f.dispose(); const before = f.snapshot();
  expect(f.remove).toHaveBeenCalledTimes(1); expect(f.add).toHaveBeenCalledTimes(1);
  expect(f.remove.mock.calls[0]).toEqual(f.add.mock.calls[0]);
  if (reject) f.reject(new Error("failed")); else f.resolve();
  await f.pending.catch(() => undefined); await Promise.resolve(); await Promise.resolve();
  f.controls.setReady(true); f.controls.setBusy(false); f.controls.syncSelection();
  f.submit(); listener(new Event("submit", { cancelable: true }));
  expect(f.snapshot()).toBe(before); expect(f.onPublished).not.toHaveBeenCalled();
  expect(f.activity.end).not.toHaveBeenCalled(); expect(f.apply).toHaveBeenCalledTimes(1);
});
