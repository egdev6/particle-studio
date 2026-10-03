import { FIRST_SLICE_DOCUMENT } from "@particle-studio/scene-document";
import { createBrowserEditorSession } from "./browser-editor-session.js";
import { renderEditorFrame } from "./editor-frame.js";

const canvas = document.querySelector<HTMLCanvasElement>("#scene")!;
const status = document.querySelector<HTMLElement>("#status")!;
const browser = createBrowserEditorSession();
window.addEventListener("pagehide", () => { void browser.dispose(); }, { once: true });

async function renderStartup() {
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas2D context is unavailable.");
    const startup = await browser.start();
    if (browser.disposed || startup.kind === "disposed") return;
    const document = startup.kind === "restored" ? startup.current.revision.document : FIRST_SLICE_DOCUMENT;
    const images = startup.kind === "restored" ? startup.current.workspace.images : [];
    const timeUs = document.playbackRange.startUs;
    renderEditorFrame(context, document, images, timeUs, { width: canvas.width, height: canvas.height });
    status.textContent = `Rendered ${startup.kind === "restored" ? "restored draft" : "unpersisted sample"} at ${timeUs} µs.`;
  } catch (error) {
    if (browser.disposed) return;
    const message = error instanceof Error ? error.message : "Unable to restore scene.";
    status.textContent = `Error: ${message}`;
  }
}
void renderStartup();
