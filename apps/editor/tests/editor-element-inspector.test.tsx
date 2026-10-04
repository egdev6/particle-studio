import { afterEach, expect, it, vi } from "vitest";
import { canonicalizeSceneDocument, validateSceneDocument, type SceneDocumentV1 } from "@particle-studio/scene-document";
import { mountEditorElementInspector } from "../src/editor-element-inspector.js";

const authored: SceneDocumentV1 = {
  schemaVersion: 1, durationUs: 1_000_000, seed: 99, loop: false,
  playbackRange: { startUs: 500_000, endUs: 900_000 }, rootIds: ["root"],
  elements: [
    { id: "root", type: "group", childrenIds: ["nested", "line", "text", "particle", "image"] },
    { id: "nested", type: "group", childrenIds: ["shape"], transform: [1, 0, 0, 1, 3, 4], visible: true },
    { id: "shape", type: "shape", x: 16, y: 24, width: 120, height: 80, opacity: 1 },
    { id: "line", type: "line", x1: 2, y1: 3, x2: 20, y2: 30, opacity: 0.6, visible: false },
    { id: "text", type: "text", text: "<img src=x onerror=alert(1)>&\"", x: 8, y: 9, fontSize: 12, opacity: 1 },
    { id: "particle", type: "particle", count: 2, x: 1, y: 2, velocityX: 3, velocityY: 4,
      spread: 5, size: 6, opacity: 0.7, lifetimeSteps: 20 },
    { id: "image", type: "image", x: 180, y: 24, width: 4, height: 4, opacity: 1,
      asset: { sha256: `sha256:${"a".repeat(64)}`, mimeType: "image/png", byteLength: 68,
        intrinsicWidth: 1, intrinsicHeight: 1 } },
  ],
  tracks: [{ elementId: "shape", property: "opacity", interpolation: "linear", easing: "linear",
    keyframes: [{ timeUs: 0, value: 0.25 }, { timeUs: 1_000_000, value: 0.75 }] },
    { elementId: "text", property: "text.text", interpolation: "step",
      keyframes: [{ timeUs: 0, value: "animated, not authored" }] }],
};
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
const canonical = canonicalizeSceneDocument(authored);
const documentData = freeze(JSON.parse(new TextDecoder().decode(canonical.bytes)) as SceneDocumentV1);
const source = (documentId = "doc", revisionId = "rev") => ({ documentId, revisionId, document: documentData });
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
function fixture() {
  const select = document.createElement("select"); select.setAttribute("aria-label", "Scene element");
  const details = document.createElement("pre"); details.setAttribute("aria-label", "Published element JSON");
  const status = document.createElement("p"); status.setAttribute("role", "status");
  status.setAttribute("aria-label", "Element inspection status");
  document.body.append(select, details, status);
  const add = vi.spyOn(select, "addEventListener"); const remove = vi.spyOn(select, "removeEventListener");
  const controls = mountEditorElementInspector({ select, details, status });
  const choose = (id: string) => { select.value = id; select.dispatchEvent(new Event("change")); };
  const snapshot = () => ({ value: select.value, disabled: select.disabled,
    options: Array.from(select.options, (option) => [option.value, option.textContent]),
    details: details.textContent, status: status.textContent });
  const ready = () => { controls.setCurrent(source()); controls.setReady(true); };
  return { controls, select, details, status, add, remove, choose, snapshot, ready };
}

it("validates canonical fixtures and exposes frozen UI-only methods and one owned listener", () => {
  expect(validateSceneDocument(authored).ok).toBe(true);
  expect(documentData).toEqual(authored); expect(Object.isFrozen(documentData)).toBe(true);
  const f = fixture(); expect(Object.isFrozen(f.controls)).toBe(true);
  expect(Object.keys(f.controls).sort()).toEqual(["dispose", "setBusy", "setCurrent", "setReady"]);
  expect(f.add).toHaveBeenCalledTimes(1); expect(f.add.mock.calls[0]![0]).toBe("change");
  f.controls.dispose(); f.controls.dispose(); expect(f.remove).toHaveBeenCalledTimes(1);
  expect(f.remove.mock.calls[0]).toEqual(f.add.mock.calls[0]);
});

it("gates initial, nullable, startup not-ready and busy sources without sample promotion", () => {
  const f = fixture(); expect(f.select.disabled).toBe(true); expect(f.details.textContent).toBe("");
  f.controls.setReady(true); f.controls.setCurrent(null);
  expect(f.select.disabled).toBe(true); expect(f.status.textContent).toMatch(/Create blank scene.*import JSON/i);
  f.controls.setReady(false); f.controls.setCurrent(source()); f.choose("shape");
  expect(f.select.disabled).toBe(true); expect(f.details.textContent).toBe("");
  f.controls.setReady(true); expect(f.select.disabled).toBe(false); expect(f.select.value).toBe("");
  f.controls.setBusy(true); f.choose("shape"); expect(f.select.disabled).toBe(true);
  expect(f.details.textContent).toBe(""); expect(f.status.textContent).toMatch(/pending|busy/i);
  f.controls.setBusy(false); expect(f.select.value).toBe("");
  f.controls.setCurrent(null); expect(f.select.disabled).toBe(true); expect(f.details.textContent).toBe("");
});

it("lists every actual element in document order, with placeholder and no implicit selection", () => {
  const f = fixture(); f.ready();
  expect(Array.from(f.select.options, (option) => option.value)).toEqual(["", ...authored.elements.map((e) => e.id)]);
  expect(f.select.options[0]!.textContent).toMatch(/select|choose/i);
  authored.elements.forEach((element, index) => {
    expect(f.select.options[index + 1]!.textContent).toContain(element.id);
    expect(f.select.options[index + 1]!.textContent).toContain(element.type);
  });
  expect(f.select.value).toBe(""); expect(f.details.textContent).toBe("");
});

it.each(authored.elements.map((element) => [element.id, element] as const))(
  "shows exact authored %s metadata, not evaluated animation/defaults or resource handles", (id, expected) => {
    const f = fixture(); f.ready(); const before = JSON.stringify(documentData);
    const clone = vi.spyOn(globalThis, "structuredClone");
    const elements = documentData.elements; const tracks = documentData.tracks; const roots = documentData.rootIds;
    f.choose(id); expect(JSON.parse(f.details.textContent!)).toEqual(expected);
    expect(f.details.tagName).toBe("PRE"); expect(f.details.querySelector("input,textarea,img,script")).toBeNull();
    expect(f.details.textContent).not.toMatch(/"handle"|"bytes"|"canonicalBytes"|"points"/);
    expect(documentData.elements).toBe(elements); expect(documentData.tracks).toBe(tracks);
    expect(documentData.rootIds).toBe(roots); expect(JSON.stringify(documentData)).toBe(before);
    expect(clone).not.toHaveBeenCalled();
    expect(documentData.seed).toBe(99); expect(Object.isFrozen(elements[0])).toBe(true);
    if (expected.type === "group") {
      for (const key of ["x", "y", "width", "height", "opacity"]) expect(JSON.parse(f.details.textContent!)).not.toHaveProperty(key);
    }
    if (expected.type === "text") expect(f.details.textContent).toContain("<img src=x onerror=alert(1)>");
  },
);

it("ignores unrelated invalid editable JSON and safely rejects unknown/stale options", () => {
  const f = fixture(); f.ready(); const input = document.createElement("textarea");
  input.value = "not JSON"; document.body.append(input); f.choose("shape");
  expect(JSON.parse(f.details.textContent!)).toEqual(authored.elements[2]);
  const injected = document.createElement("option"); injected.value = "<img src=x onerror=alert(1)>";
  injected.textContent = injected.value; f.select.append(injected); f.choose(injected.value);
  expect(f.details.textContent).toBe(""); expect(f.select.value).toBe("");
  expect(document.querySelector("img,script")).toBeNull();
  f.choose("shape"); f.choose(""); expect(f.details.textContent).toBe("");
});

it("retains valid same-identity selection across refresh and rejected owned work; disabled events cannot retarget", () => {
  const f = fixture(); f.ready(); f.choose("shape"); const detail = f.details.textContent;
  f.controls.setCurrent(source()); expect(f.select.value).toBe("shape"); expect(f.details.textContent).toBe(detail);
  f.controls.setBusy(true); expect(f.status.textContent).toMatch(/pending|busy/i);
  expect(f.status.textContent).toContain("doc"); expect(f.status.textContent).toContain("rev");
  f.choose("image"); expect(f.details.textContent).toBe(detail);
  f.controls.setCurrent(source()); f.controls.setBusy(false);
  expect(f.select.value).toBe("shape"); expect(f.details.textContent).toBe(detail);
  f.controls.setReady(false); f.choose("text"); f.controls.setReady(true);
  expect(f.select.value).toBe("shape"); expect(f.details.textContent).toBe(detail);
});

it.each([["different-doc", "rev"], ["doc", "different-rev"]])(
  "clears reused IDs on source identity change to %s/%s", (documentId, revisionId) => {
    const f = fixture(); f.ready(); f.choose("shape");
    f.controls.setCurrent(source(documentId, revisionId));
    expect(f.select.value).toBe(""); expect(f.details.textContent).toBe("");
    f.choose("shape"); expect(JSON.parse(f.details.textContent!)).toEqual(authored.elements[2]);
    f.controls.setCurrent(null); expect(f.details.textContent).toBe("");
  },
);

it("drops a selected ID absent from an otherwise same-identity metadata refresh", () => {
  const f = fixture(); f.ready(); f.choose("shape");
  const document: SceneDocumentV1 = { ...authored, rootIds: ["root"], tracks: [],
    elements: [{ id: "root", type: "group", childrenIds: [] }] };
  f.controls.setCurrent({ ...source(), document });
  expect(f.select.value).toBe(""); expect(f.details.textContent).toBe("");
});

it("freezes DOM after idempotent disposal and ignores late current/ready/busy and owned events", () => {
  const f = fixture(); f.ready(); f.choose("shape"); f.controls.setBusy(true);
  const listener = f.add.mock.calls[0]![1] as EventListener;
  f.controls.dispose(); f.controls.dispose(); expect(f.select.disabled).toBe(true); const before = f.snapshot();
  f.controls.setCurrent(null); f.controls.setCurrent(source("late", "late"));
  f.controls.setReady(false); f.controls.setReady(true); f.controls.setBusy(false);
  f.select.dispatchEvent(new Event("change")); listener(new Event("change"));
  expect(f.snapshot()).toEqual(before); expect(f.remove).toHaveBeenCalledTimes(1);
});
