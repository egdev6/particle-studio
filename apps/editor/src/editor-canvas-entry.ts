import { FIRST_SLICE_DOCUMENT, type SceneDocumentV1 } from "@particle-studio/scene-document";
import { createBrowserEditorSession } from "./browser-editor-session.js";
import { mountEditorJsonImportControls } from "./editor-json-import-controls.js";
import { renderEditorFrame } from "./editor-frame.js";

const canvas = document.querySelector<HTMLCanvasElement>("#scene")!;
const status = document.querySelector<HTMLElement>("#status")!;
const browser = createBrowserEditorSession();
let context: CanvasRenderingContext2D | null = null;
const render = (document: SceneDocumentV1, images: Parameters<typeof renderEditorFrame>[2], label: string) => {
  if (!context) throw new Error("Canvas2D context is unavailable.");
  const timeUs = document.playbackRange.startUs;
  renderEditorFrame(context, document, images, timeUs, { width: canvas.width, height: canvas.height });
  return `Rendered ${label} at ${timeUs} µs.`;
};
const controls = mountEditorJsonImportControls({
  form: document.querySelector<HTMLFormElement>("#json-import")!,
  input: document.querySelector<HTMLTextAreaElement>("#editable-json")!,
  button: document.querySelector<HTMLButtonElement>("#import-json")!,
  status,
  workflow: (request) => {
    if (request.kind !== "editable-json-import") return Promise.reject(new Error("JSON input required."));
    return browser.importJson(request.editableJson);
  },
  onImported: () => {
    const current = browser.current;
    if (!current) throw new Error("No usable imported draft.");
    return render(current.revision.document, current.images, "imported draft");
  },
});
window.addEventListener("pagehide", () => {
  controls.dispose();
  void browser.dispose();
}, { once: true });

async function renderStartup() {
  try {
    context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas2D context is unavailable.");
    const startup = await browser.start();
    if (browser.disposed || startup.kind === "disposed") return;
    const document = startup.kind === "restored" ? startup.current.revision.document : FIRST_SLICE_DOCUMENT;
    const images = startup.kind === "restored" ? startup.current.images : [];
    status.textContent = render(document, images, startup.kind === "restored" ? "restored draft" : "unpersisted sample");
    controls.setReady(true);
  } catch (error) {
    if (browser.disposed) return;
    const message = error instanceof Error ? error.message : "Unable to restore scene.";
    status.textContent = `Error: ${message}`;
  }
}
void renderStartup();
