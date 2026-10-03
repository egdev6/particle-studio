import { FIRST_SLICE_DOCUMENT, type SceneDocumentV1 } from "@particle-studio/scene-document";
import { createBrowserEditorSession } from "./browser-editor-session.js";
import { mountEditorJsonImportControls, type EditorImportActivity } from "./editor-json-import-controls.js";
import { mountEditorPngImportControls } from "./editor-png-import-controls.js";
import { renderEditorFrame } from "./editor-frame.js";

const canvas = document.querySelector<HTMLCanvasElement>("#scene")!;
const status = document.querySelector<HTMLElement>("#status")!;
const pngStatus = document.querySelector<HTMLElement>("#png-status")!;
const browser = createBrowserEditorSession();
let context: CanvasRenderingContext2D | null = null;
const render = (document: SceneDocumentV1, images: Parameters<typeof renderEditorFrame>[2], label: string) => {
  if (!context) throw new Error("Canvas2D context is unavailable.");
  const timeUs = document.playbackRange.startUs;
  renderEditorFrame(context, document, images, timeUs, { width: canvas.width, height: canvas.height });
  return `Rendered ${label} at ${timeUs} µs.`;
};
let ready = false;
let busy = false;
const activity: EditorImportActivity = {
  begin() {
    if (busy || !ready || !context || browser.disposed) return false;
    busy = true;
    controls.setBusy(true);
    pngControls.setBusy(true);
    return true;
  },
  end() {
    busy = false;
    if (browser.disposed) return;
    controls.setBusy(false);
    pngControls.setBusy(false);
    pngControls.setReady(ready, browser.current !== null);
  },
};
const renderCurrent = () => {
  const current = browser.current;
  if (!current) throw new Error("No usable imported draft.");
  return render(current.revision.document, current.images, "imported draft");
};
const controls = mountEditorJsonImportControls({
  form: document.querySelector<HTMLFormElement>("#json-import")!,
  input: document.querySelector<HTMLTextAreaElement>("#editable-json")!,
  button: document.querySelector<HTMLButtonElement>("#import-json")!,
  status, activity,
  workflow: (request) => {
    if (request.kind !== "editable-json-import") return Promise.reject(new Error("JSON input required."));
    return browser.importJson(request.editableJson);
  },
  onImported: renderCurrent,
});
const pngControls = mountEditorPngImportControls({
  form: document.querySelector<HTMLFormElement>("#png-import")!,
  input: document.querySelector<HTMLInputElement>("#png-file")!,
  button: document.querySelector<HTMLButtonElement>("#import-png")!,
  status: pngStatus,
  rectangle: {
    x: document.querySelector<HTMLInputElement>("#png-x")!,
    y: document.querySelector<HTMLInputElement>("#png-y")!,
    width: document.querySelector<HTMLInputElement>("#png-width")!,
    height: document.querySelector<HTMLInputElement>("#png-height")!,
  },
  activity, importPng: browser.importPng,
  onImported: () => {
    const message = renderCurrent();
    status.textContent = message;
    return message;
  },
});
window.addEventListener("pagehide", () => {
  controls.dispose();
  pngControls.dispose();
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
    ready = true;
    controls.setReady(true);
    pngControls.setReady(true, browser.current !== null);
  } catch (error) {
    if (browser.disposed) return;
    const message = error instanceof Error ? error.message : "Unable to restore scene.";
    status.textContent = `Error: ${message}`;
    pngStatus.textContent = `PNG import unavailable. ${message}`;
  }
}
void renderStartup();
