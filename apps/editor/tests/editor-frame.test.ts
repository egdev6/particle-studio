import { describe, expect, it, vi } from "vitest";
import { FIRST_SLICE_DOCUMENT, type SceneDocumentV1 } from "@particle-studio/scene-document";
import type { CachedPngImage } from "../src/png-image-cache.js";
import { createRuntimeImageResolver, renderEditorFrame, type EditorFrameContext } from "../src/editor-frame.js";

const asset = {
  sha256: `sha256:${"a".repeat(64)}`,
  mimeType: "image/png" as const,
  byteLength: 68,
  intrinsicWidth: 2,
  intrinsicHeight: 3,
};
const handle = { close: vi.fn() };
const images: readonly CachedPngImage[] = [{
  sha256: asset.sha256, mimeType: "image/png", byteLength: 68,
  width: 2, height: 3, handle,
}];
const scene: SceneDocumentV1 = {
  ...FIRST_SLICE_DOCUMENT,
  rootIds: ["shape", "image"],
  tracks: [],
  elements: [
    { id: "shape", type: "shape", x: 1, y: 2, width: 3, height: 4, opacity: 1 },
    { id: "image", type: "image", asset, x: 5, y: 6, width: 7, height: 8, opacity: 1 },
  ],
};

function recordingContext() {
  const calls: unknown[][] = [];
  const record = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const context: EditorFrameContext = {
    get globalAlpha() { return 1; },
    set globalAlpha(value: number) { calls.push(["alpha", value]); },
    get font() { return ""; },
    set font(value: string) { calls.push(["font", value]); },
    clearRect: record("clear"), save: record("save"), restore: record("restore"),
    beginPath: record("begin"), moveTo: record("move"), lineTo: record("line"),
    stroke: record("stroke"), transform: record("transform"),
    fillRect: record("shape"), fillText: record("text"), drawImage: record("image"),
  };
  return { context, calls };
}

describe("editor frame", () => {
  it("maps metadata and borrows the exact handle without closing it", () => {
    const resolver = createRuntimeImageResolver(images);
    expect(resolver.resolve(asset)).toEqual({ ...asset, handle });
    expect(resolver.resolve(asset)?.handle).toBe(handle);
    expect(resolver.resolve({ ...asset, sha256: `sha256:${"b".repeat(64)}` })).toBeUndefined();
    expect(handle.close).not.toHaveBeenCalled();
  });

  it("clears the caller viewport before ordered draws and returns evaluation", () => {
    const { context, calls } = recordingContext();
    const result = renderEditorFrame(context, scene, images, 0, { width: 20, height: 30 });
    expect(calls).toEqual([
      ["clear", 0, 0, 20, 30],
      ["save"], ["alpha", 1], ["shape", 1, 2, 3, 4], ["restore"],
      ["save"], ["alpha", 1], ["image", handle, 5, 6, 7, 8], ["restore"],
    ]);
    expect(result.commands).toEqual([
      { kind: "draw-shape", sourceId: "shape", x: 1, y: 2, width: 3, height: 4, opacity: 1 },
      { kind: "draw-image", sourceId: "image", resolved: handle, x: 5, y: 6, width: 7, height: 8, opacity: 1 },
    ]);
    expect(result.state.timeUs).toBe(0);
    expect(handle.close).not.toHaveBeenCalled();
  });

  it.each([
    [[], "RUNTIME_IMAGE_ASSET_UNRESOLVED"],
    [[{ ...images[0]!, byteLength: 69 }], "RUNTIME_IMAGE_ASSET_METADATA_MISMATCH"],
    [[{ ...images[0]!, width: 4 }], "RUNTIME_IMAGE_ASSET_METADATA_MISMATCH"],
    [[{ ...images[0]!, height: 4 }], "RUNTIME_IMAGE_ASSET_METADATA_MISMATCH"],
  ] as const)("rejects unresolved or mismatched images before any context operation (%#)", (input, error) => {
    const { context, calls } = recordingContext();
    expect(() => renderEditorFrame(context, scene, input, 0, { width: 20, height: 30 })).toThrow(error);
    expect(calls).toEqual([]);
  });

  it("rejects invalid documents and time before touching the context", () => {
    const { context, calls } = recordingContext();
    expect(() => renderEditorFrame(context, {}, images, 0, { width: 20, height: 30 })).toThrow("RUNTIME_DOCUMENT_INVALID");
    expect(() => renderEditorFrame(context, scene, images, -1, { width: 20, height: 30 })).toThrow("RUNTIME_TIME_US_INVALID");
    expect(calls).toEqual([]);
  });
});
