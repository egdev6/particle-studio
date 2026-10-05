import { createBrowserEditorSession, type BrowserCurrent } from "../../../src/browser-editor-session.js";
import type { ShapeDimensionsRequest } from "../../../src/editor-session.js";
import { renderEditorFrame } from "../../../src/editor-frame.js";

// Test-only observation of real native handles and readonly pointer requests.
const handles: { bitmap: ImageBitmap; closes: number }[] = [];
const decode = globalThis.createImageBitmap;
globalThis.createImageBitmap = async (source: ImageBitmapSource) => {
  const bitmap = await decode(source); const record = { bitmap, closes: 0 }; handles.push(record);
  const close = bitmap.close.bind(bitmap);
  bitmap.close = () => { record.closes += 1; close(); }; return bitmap;
};
const ids: string[] = []; const uuid = crypto.randomUUID.bind(crypto);
crypto.randomUUID = () => { const id = uuid(); ids.push(id); return id; };
let hold = false; let settle: ((reject: boolean) => void) | undefined;
const get = IDBObjectStore.prototype.get;
IDBObjectStore.prototype.get = function (key) {
  const request = get.call(this, key);
  if (!hold || this.name !== "pointers" || this.transaction.mode !== "readonly") return request;
  hold = false;
  const intercept = (event: Event) => {
    event.stopImmediatePropagation(); request.removeEventListener("success", intercept, true);
    settle = (reject) => {
      settle = undefined;
      if (reject) Object.defineProperty(request, "error", { value: new DOMException("Held read fault", "UnknownError") });
      request.dispatchEvent(new Event(reject ? "error" : "success", { cancelable: true }));
    };
  };
  request.addEventListener("success", intercept, true); return request;
};
const browser = createBrowserEditorSession() as ReturnType<typeof createBrowserEditorSession> & {
  setShapeDimensions(request: ShapeDimensionsRequest): Promise<BrowserCurrent | null>;
};
const canvas = document.querySelector<HTMLCanvasElement>("#scene")!;
const context = canvas.getContext("2d")!; const output = document.querySelector("#status")!;
let renderFault = false; let renders = 0; let notifications = 0; let result = "idle";
const clear = context.clearRect.bind(context);
context.clearRect = (...args) => { if (renderFault) throw new Error("Render fault after commit"); clear(...args); };
function render() {
  const current = browser.current;
  if (!current) return;
  renderEditorFrame(context, current.revision.document, current.images, 0, { width: canvas.width, height: canvas.height });
  renders += 1;
}
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (char) => char.charCodeAt(0));
const placement = { x: 280, y: 10, width: 8, height: 8 };
function action(name: string, request: ShapeDimensionsRequest) {
  switch (name) {
    case "json": return browser.importJson(JSON.stringify(browser.current!.revision.document));
    case "blank": return browser.createScene();
    case "png": return browser.importPng(new File([png], "pixel.png", { type: "image/png" }), placement);
    case "rectangle": return browser.addRectangle(placement);
    case "position": return browser.setShapePosition({ ...request, x: 16, y: 24 });
    case "dimensions": return browser.setShapeDimensions(request);
    default: throw new Error("Unknown fixture action");
  }
}
async function launch(name: string, request: ShapeDimensionsRequest) {
  try {
    const next = await action(name, request);
    if (browser.disposed) { result = "disposed"; return; }
    try { render(); result = "complete"; } catch { result = "published, but rendering failed"; }
    if (next !== browser.current) throw new Error("Facade returned other than actual current");
  } catch { result = "rejected"; }
  if (!browser.disposed) { notifications += 1; output.textContent = result; }
}
const harness = {
  browser, ids, png: Array.from(png), render,
  publish: async (json: string) => { await browser.importJson(json); render(); },
  action, launch: (name: string, request: ShapeDimensionsRequest) => { result = "pending"; void launch(name, request); },
  hold: () => { hold = true; }, settle: (reject: boolean) => { if (!settle) throw new Error("No held native result"); settle(reject); },
  fault: (value: boolean) => { renderFault = value; },
  snapshot: () => ({ result, pending: settle !== undefined, renders, notifications, dom: output.textContent,
    current: browser.current ? {
      ...browser.current.revision, document: browser.current.revision.document,
      canonicalBytes: Array.from(browser.current.revision.canonicalBytes),
    } : null,
    pixels: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
    handles: handles.map(({ bitmap, closes }, id) => {
      let useful = false;
      try { const probe = document.createElement("canvas"); probe.width = probe.height = 1;
        const ctx = probe.getContext("2d")!; ctx.drawImage(bitmap, 0, 0); useful = ctx.getImageData(0, 0, 1, 1).data[3] === 255;
      } catch { /* Closed native bitmap is not drawable. */ }
      return { id, closes, useful };
    }),
  }),
};
export type DimensionsHarness = typeof harness;
declare global { interface Window { dimensions: DimensionsHarness } }
window.dimensions = harness;
void browser.start().then(() => { render(); output.textContent = "ready"; }).catch((error: unknown) => { output.textContent = String(error); });
