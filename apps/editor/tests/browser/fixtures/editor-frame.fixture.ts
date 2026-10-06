import { FIRST_SLICE_DOCUMENT, type SceneDocumentV1 } from "@particle-studio/scene-document";
import { browserPngDecodePrimitive } from "../../../src/browser-png-platform.js";
import { renderEditorFrame } from "../../../src/editor-frame.js";

// Copied fixed PNG vector from browser-png-platform.fixture.ts to keep that proof unchanged.
// Digest is independently pinned there; this vector's single opaque pixel is black.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const asset = {
  sha256: "sha256:431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460",
  mimeType: "image/png" as const,
  byteLength: 68,
  intrinsicWidth: 1,
  intrinsicHeight: 1,
};
const scene: SceneDocumentV1 = {
  ...FIRST_SLICE_DOCUMENT,
  rootIds: ["shape", "image"],
  tracks: [],
  elements: [
    { id: "shape", type: "shape", x: 0, y: 0, width: 4, height: 4, opacity: 1 },
    { id: "image", type: "image", asset, x: 8, y: 0, width: 4, height: 4, opacity: 1 },
  ],
};
const output = (id: string, value: string) => {
  document.querySelector(`#${id}`)!.textContent = value;
};

async function run() {
  const bytes = Uint8Array.from(atob(PNG_BASE64), (char) => char.charCodeAt(0));
  const decoded = await browserPngDecodePrimitive.decodePng(bytes);
  if (typeof decoded !== "object" || decoded === null || !("handle" in decoded)) {
    throw new Error("Expected decoded PNG handle");
  }
  const bitmap = decoded.handle;
  try {
    if (!(bitmap instanceof ImageBitmap)) throw new Error("Expected real ImageBitmap");
    const canvas = document.querySelector<HTMLCanvasElement>("canvas")!;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas2D unavailable");
    const images = [{
      sha256: asset.sha256, mimeType: asset.mimeType, byteLength: bytes.length,
      width: bitmap.width, height: bitmap.height, handle: bitmap,
    }];
    const viewport = { width: canvas.width, height: canvas.height };
    const pixel = (x: number) => Array.from(context.getImageData(x, 1, 1, 1).data).join(",");
    const snapshot = () => Array.from(context.getImageData(0, 0, 20, 8).data).join(",");
    context.fillStyle = "white";
    renderEditorFrame(context, scene, images, 0, viewport);
    output("pixels", `${pixel(1)};${pixel(9)}`);
    output("bitmap", `${bitmap.constructor.name}:${bitmap.width}x${bitmap.height}`);
    const before = snapshot();
    for (const [id, reference, expected] of [
      ["unknown", { ...asset, sha256: `sha256:${"b".repeat(64)}` }, "RUNTIME_IMAGE_ASSET_UNRESOLVED"],
      ["mismatch", { ...asset, byteLength: 69 }, "RUNTIME_IMAGE_ASSET_METADATA_MISMATCH"],
    ] as const) {
      const invalid = {
        ...scene,
        elements: scene.elements.map((element) => element.type === "image" ? { ...element, asset: reference } : element),
      };
      try {
        renderEditorFrame(context, invalid, images, 0, viewport);
        throw new Error("Invalid reference unexpectedly rendered");
      } catch (error) {
        if (!(error instanceof Error) || error.message !== expected) throw error;
        output(id, `${error.message}:${snapshot() === before}`);
      }
    }
    const replacement: SceneDocumentV1 = {
      ...scene,
      rootIds: ["new"],
      elements: [{ id: "new", type: "shape", x: 16, y: 0, width: 4, height: 4, opacity: 1 }],
    };
    renderEditorFrame(context, replacement, images, 0, viewport);
    output("replacement", `${pixel(1)};${pixel(9)};${pixel(17)}`);
  } finally {
    if (bitmap instanceof ImageBitmap) bitmap.close();
  }
  output("status", "passed");
}

const colorScene: SceneDocumentV1 = {
  ...FIRST_SLICE_DOCUMENT,
  rootIds: ["color-default", "color-authored", "color-alpha", "color-particle"],
  tracks: [],
  elements: [
    { id: "color-default", type: "shape", x: 0, y: 0, width: 6, height: 4, opacity: 1 },
    { id: "color-authored", type: "shape", x: 8, y: 0, width: 6, height: 4, opacity: 1, fillColor: "#3Fa9F5" },
    { id: "color-alpha", type: "shape", x: 16, y: 0, width: 6, height: 4, opacity: 0.5, fillColor: "#00ff00" },
    { id: "color-particle", type: "particle", count: 1, x: 2, y: 6, velocityX: 0, velocityY: 0, spread: 0, size: 3, opacity: 1, lifetimeSteps: 3 },
  ],
};

function colorShapes() {
  const canvas = document.createElement("canvas");
  canvas.width = 24;
  canvas.height = 12;
  document.body.append(canvas);
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas2D unavailable");
    context.fillStyle = "#ffffff";
    renderEditorFrame(context, colorScene, [], 0, { width: canvas.width, height: canvas.height });
    const pixel = (x: number, y: number) =>
      Array.from(context.getImageData(x, y, 1, 1).data);
    return {
      defaultBlack: pixel(2, 1),
      authoredOpaque: pixel(10, 1),
      alphaGreen: pixel(18, 1),
      particleCallerWhite: pixel(3, 7),
      restoredFillStyle: context.fillStyle,
    };
  } finally {
    canvas.remove();
  }
}

export type EditorFrameColors = { colorShapes: typeof colorShapes };
declare global { interface Window { editorFrameColors: EditorFrameColors } }
window.editorFrameColors = { colorShapes };

void run().catch((error: unknown) => output("status", `failed: ${String(error)}`));
