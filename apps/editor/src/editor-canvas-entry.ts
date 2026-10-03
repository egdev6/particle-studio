import { FIRST_SLICE_DOCUMENT } from "@particle-studio/scene-document";
import { renderEditorFrame } from "./editor-frame.js";

const canvas = document.querySelector<HTMLCanvasElement>("#scene")!;
const status = document.querySelector<HTMLElement>("#status")!;
const timeUs = FIRST_SLICE_DOCUMENT.playbackRange.startUs;

try {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas2D context is unavailable.");
  renderEditorFrame(context, FIRST_SLICE_DOCUMENT, [], timeUs, {
    width: canvas.width,
    height: canvas.height,
  });
  status.textContent = `Rendered example at ${timeUs} µs.`;
} catch (error) {
  const message = error instanceof Error ? error.message : "Unable to render example.";
  status.textContent = `Error: ${message}`;
}
