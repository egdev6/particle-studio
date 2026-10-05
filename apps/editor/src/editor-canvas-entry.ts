import { FIRST_SLICE_DOCUMENT, type SceneDocumentV1 } from "@particle-studio/scene-document";
import { createBrowserEditorSession } from "./browser-editor-session.js";
import { mountEditorJsonImportControls, type EditorImportActivity } from "./editor-json-import-controls.js";
import { mountEditorPngImportControls } from "./editor-png-import-controls.js";
import { mountEditorRectangleControls } from "./editor-rectangle-controls.js";
import { mountEditorElementInspector } from "./editor-element-inspector.js";
import { mountEditorPositionControls } from "./editor-position-controls.js";
import { mountEditorDimensionControls } from "./editor-dimension-controls.js";
import { mountEditorOpacityControls } from "./editor-opacity-controls.js";
import { renderEditorFrame } from "./editor-frame.js";

const canvas = document.querySelector<HTMLCanvasElement>("#scene")!;
const status = document.querySelector<HTMLElement>("#status")!;
const pngStatus = document.querySelector<HTMLElement>("#png-status")!;
const browser = createBrowserEditorSession();
let positionControls: ReturnType<typeof mountEditorPositionControls> | undefined;
let dimensionControls: ReturnType<typeof mountEditorDimensionControls> | undefined;
let opacityControls: ReturnType<typeof mountEditorOpacityControls> | undefined;
const inspector = mountEditorElementInspector({
  select: document.querySelector<HTMLSelectElement>("#scene-element")!,
  details: document.querySelector<HTMLElement>("#element-details")!,
  status: document.querySelector<HTMLElement>("#element-status")!,
  onSelectionChange: () => {
    positionControls?.syncSelection();
    dimensionControls?.syncSelection();
    opacityControls?.syncSelection();
  },
});
const currentMetadata = () => {
  const current = browser.current;
  return current ? {
    documentId: current.revision.documentId,
    revisionId: current.revision.revisionId,
    document: current.revision.document,
  } : null;
};
const refreshInspector = () => inspector.setCurrent(currentMetadata());
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
    rectangleControls.setBusy(true);
    positionControls?.setBusy(true);
    dimensionControls?.setBusy(true);
    opacityControls?.setBusy(true);
    inspector.setBusy(true);
    return true;
  },
  end() {
    if (browser.disposed) return;
    // Publication may have committed even when rendering the new frame threw.
    refreshInspector();
    inspector.setBusy(false);
    busy = false;
    controls.setBusy(false);
    pngControls.setBusy(false);
    pngControls.setReady(ready, browser.current !== null);
    rectangleControls.setBusy(false);
    rectangleControls.setReady(ready, browser.current !== null);
    positionControls?.setBusy(false);
    positionControls?.setReady(ready);
    positionControls?.syncSelection();
    dimensionControls?.setBusy(false);
    dimensionControls?.setReady(ready);
    dimensionControls?.syncSelection();
    opacityControls?.setBusy(false);
    opacityControls?.setReady(ready);
    opacityControls?.syncSelection();
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
  createButton: document.querySelector<HTMLButtonElement>("#create-scene")!,
  createScene: browser.createScene,
  hasCurrent: () => browser.current !== null,
  onCreated: renderCurrent,
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
const rectangleControls = mountEditorRectangleControls({
  form: document.querySelector<HTMLFormElement>("#rectangle-create")!,
  button: document.querySelector<HTMLButtonElement>("#add-rectangle")!,
  status: document.querySelector<HTMLElement>("#rectangle-status")!,
  rectangle: {
    x: document.querySelector<HTMLInputElement>("#rectangle-x")!,
    y: document.querySelector<HTMLInputElement>("#rectangle-y")!,
    width: document.querySelector<HTMLInputElement>("#rectangle-width")!,
    height: document.querySelector<HTMLInputElement>("#rectangle-height")!,
  },
  activity, addRectangle: browser.addRectangle,
  onCreated: () => {
    const message = renderCurrent();
    status.textContent = message;
    return message;
  },
});
positionControls = mountEditorPositionControls({
  form: document.querySelector<HTMLFormElement>("#shape-position")!,
  position: {
    x: document.querySelector<HTMLInputElement>("#position-x")!,
    y: document.querySelector<HTMLInputElement>("#position-y")!,
  },
  button: document.querySelector<HTMLButtonElement>("#apply-position")!,
  status: document.querySelector<HTMLElement>("#position-status")!,
  activity, getSelection: inspector.getSelection, getCurrent: currentMetadata,
  setShapePosition: browser.setShapePosition,
  onPublished: () => {
    const message = renderCurrent();
    status.textContent = message;
    return message;
  },
});
dimensionControls = mountEditorDimensionControls({
  form: document.querySelector<HTMLFormElement>("#shape-dimensions")!,
  dimensions: {
    width: document.querySelector<HTMLInputElement>("#dimension-width")!,
    height: document.querySelector<HTMLInputElement>("#dimension-height")!,
  },
  button: document.querySelector<HTMLButtonElement>("#apply-dimensions")!,
  status: document.querySelector<HTMLElement>("#dimension-status")!,
  activity, getSelection: inspector.getSelection, getCurrent: currentMetadata,
  setShapeDimensions: browser.setShapeDimensions,
  onPublished: () => {
    const message = renderCurrent();
    status.textContent = message;
    return message;
  },
});
opacityControls = mountEditorOpacityControls({
  form: document.querySelector<HTMLFormElement>("#shape-opacity")!,
  opacity: document.querySelector<HTMLInputElement>("#shape-opacity-value")!,
  button: document.querySelector<HTMLButtonElement>("#apply-opacity")!,
  status: document.querySelector<HTMLElement>("#opacity-status")!,
  activity, getSelection: inspector.getSelection, getCurrent: currentMetadata,
  setShapeOpacity: (request) => browser.setShapeOpacity(request),
  onPublished: () => {
    const message = renderCurrent();
    status.textContent = message;
    return message;
  },
});
positionControls.syncSelection();
dimensionControls.syncSelection();
opacityControls.syncSelection();
window.addEventListener("pagehide", () => {
  controls.dispose();
  pngControls.dispose();
  rectangleControls.dispose();
  positionControls?.dispose();
  dimensionControls?.dispose();
  opacityControls?.dispose();
  inspector.dispose();
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
    refreshInspector();
    inspector.setReady(true);
    controls.setReady(true);
    pngControls.setReady(true, browser.current !== null);
    rectangleControls.setReady(true, browser.current !== null);
    positionControls?.setReady(true);
    positionControls?.syncSelection();
    dimensionControls?.setReady(true);
    dimensionControls?.syncSelection();
    opacityControls?.setReady(true);
    opacityControls?.syncSelection();
  } catch (error) {
    if (browser.disposed) return;
    const message = error instanceof Error ? error.message : "Unable to restore scene.";
    status.textContent = `Error: ${message}`;
    pngStatus.textContent = `PNG import unavailable. ${message}`;
    document.querySelector<HTMLElement>("#rectangle-status")!.textContent = `Rectangle creation unavailable. ${message}`;
    positionControls?.setReady(false);
    document.querySelector<HTMLElement>("#position-status")!.textContent = `Position editing unavailable. ${message}`;
    dimensionControls?.setReady(false);
    document.querySelector<HTMLElement>("#dimension-status")!.textContent = `Dimension editing unavailable. ${message}`;
    opacityControls?.setReady(false);
    document.querySelector<HTMLElement>("#opacity-status")!.textContent = `Opacity editing unavailable. ${message}`;
  }
}
void renderStartup();
