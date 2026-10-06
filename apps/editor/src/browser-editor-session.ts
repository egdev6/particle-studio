import { createIndexedDbPersistenceAdapter } from "@particle-studio/persistence-indexeddb";
import type { DurableDraftPublication } from "./durable-draft-workspace.js";
import { browserPngDecodePrimitive, browserSha256 } from "./browser-png-platform.js";
import { createEditorSession, type ShapeDimensionsRequest, type ShapeFillColorRequest, type ShapeOpacityRequest, type ShapePositionRequest } from "./editor-session.js";
import { EMPTY_SCENE_JSON } from "./empty-scene.js";

// One local editor slot; absence never creates a durable document.
export const BROWSER_DATABASE = "particle-studio-browser-viewer";
export const BROWSER_DOCUMENT = "browser-document";
/** Borrowed rendering data only; no publication release or cache authority. */
export interface BrowserCurrent {
  readonly revision: DurableDraftPublication["revision"];
  readonly images: DurableDraftPublication["workspace"]["images"];
}
export interface PngPlacement {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export type BrowserStartup =
  | { readonly kind: "sample" }
  | { readonly kind: "restored"; readonly current: BrowserCurrent }
  | { readonly kind: "disposed" };

export function createBrowserEditorSession() {
  const persistence = createIndexedDbPersistenceAdapter({ databaseName: BROWSER_DATABASE });
  const readPointers = persistence.readPointers.bind(persistence);
  let sequenceFloor = 0;
  let placement: PngPlacement | undefined;
  const session = createEditorSession({
    persistence, documentId: BROWSER_DOCUMENT,
    sha256: browserSha256, decodePng: browserPngDecodePrimitive.decodePng,
    jsonImportSequenceFloor: () => sequenceFloor,
    revisionId: () => crypto.randomUUID(), createdAt: Date.now,
    commandId: () => crypto.randomUUID(),
    elementIdSource: () => ({ kind: "id", id: `image-${crypto.randomUUID()}` }),
    geometry: () => {
      if (!placement) throw new Error("EDITOR_PNG_PLACEMENT_REQUIRED");
      return { ...placement, opacity: 1 };
    },
  });
  let disposed = false;
  let ready = false;
  let importBusy = false;
  let importFlight: Promise<BrowserCurrent | null> | undefined;
  const views = new WeakMap<DurableDraftPublication, BrowserCurrent>();
  const currentView = (): BrowserCurrent | null => {
    const current = session.workspace.current;
    if (disposed || !ready || current === null) return null;
    let view = views.get(current);
    if (!view) {
      view = Object.freeze({ revision: current.revision, images: current.workspace.images });
      views.set(current, view);
    }
    return view;
  };
  let flight: Promise<BrowserStartup> | undefined;
  let disposal: Promise<void> | undefined;
  const start = (): Promise<BrowserStartup> => {
    if (flight) return flight;
    flight = (async (): Promise<BrowserStartup> => {
      if (disposed) return { kind: "disposed" };
      try {
        const pointers = await readPointers(BROWSER_DOCUMENT);
        if (disposed) return { kind: "disposed" };
        sequenceFloor = Math.max(pointers.saved?.sequence ?? 0, pointers.draft?.sequence ?? 0);
        if (pointers.draft === null) {
          ready = true;
          return { kind: "sample" };
        }
        await session.reload();
        if (disposed) return { kind: "disposed" };
        ready = true;
        return { kind: "restored", current: currentView()! };
      } catch (error) {
        if (disposed) return { kind: "disposed" };
        throw error;
      }
    })();
    return flight;
  };
  const ownAction = (action: () => Promise<unknown>): Promise<BrowserCurrent | null> => {
    // Own and lock the flight before entering the action, whose source/IDs/
    // geometry capture and File read begin synchronously. No queued second action.
    let resolve!: (view: BrowserCurrent | null) => void;
    let reject!: (error: unknown) => void;
    const work = new Promise<BrowserCurrent | null>((yes, no) => { resolve = yes; reject = no; });
    importBusy = true;
    importFlight = work.finally(() => {
      importBusy = false; importFlight = undefined; placement = undefined;
    });
    try {
      void action().then(() => currentView()).then(resolve, reject);
    } catch (error) { reject(error); }
    return importFlight;
  };
  const importJson = (editableJson: string): Promise<BrowserCurrent | null> => {
    if (disposed || !ready || importBusy) return Promise.reject(new Error("EDITOR_JSON_IMPORT_UNAVAILABLE"));
    return ownAction(() => session.importWorkflow({ kind: "editable-json-import", editableJson }));
  };
  const createScene = (): Promise<BrowserCurrent | null> => {
    if (disposed || !ready || importBusy || session.workspace.current !== null) {
      return Promise.reject(new Error("EDITOR_SCENE_CREATION_UNAVAILABLE"));
    }
    // Delegate once: JSON owns the shared flight and startup-known sequence floor.
    return importJson(EMPTY_SCENE_JSON);
  };
  const importPng = (file: File, rectangle: PngPlacement): Promise<BrowserCurrent | null> => {
    if (disposed || !ready || importBusy) return Promise.reject(new Error("EDITOR_PNG_IMPORT_UNAVAILABLE"));
    if (!currentView()) return Promise.reject(new Error("Create a scene or import JSON first to create an editable document."));
    try {
      const captured = { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height };
      if (!Object.values(captured).every(Number.isFinite) || captured.width <= 0 || captured.height <= 0) {
        throw new Error("EDITOR_PNG_PLACEMENT_INVALID");
      }
      placement = Object.freeze(captured);
      return ownAction(() => session.importWorkflow({ kind: "image-import", file }));
    } catch (error) { return Promise.reject(error); }
  };
  const addRectangle = (rectangle: PngPlacement): Promise<BrowserCurrent | null> => {
    if (disposed || !ready || importBusy) return Promise.reject(new Error("EDITOR_RECTANGLE_UNAVAILABLE"));
    if (!currentView()) return Promise.reject(new Error("Create a scene or import JSON first to create an editable document."));
    try {
      const geometry = { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height };
      if (!Object.values(geometry).every(Number.isFinite) || geometry.width <= 0 || geometry.height <= 0) {
        throw new Error("EDITOR_RECTANGLE_GEOMETRY_INVALID");
      }
      return ownAction(() => session.addRectangle(geometry));
    } catch (error) { return Promise.reject(error); }
  };
  const setShapePosition = (request: ShapePositionRequest): Promise<BrowserCurrent | null> => {
    if (disposed || !ready || importBusy || !currentView()) {
      return Promise.reject(new Error("EDITOR_SHAPE_POSITION_UNAVAILABLE"));
    }
    try {
      // Read caller getters once; the session sees only captured scalar fields.
      const position = Object.freeze({ documentId: request.documentId, revisionId: request.revisionId,
        elementId: request.elementId, x: request.x, y: request.y });
      return ownAction(() => session.setShapePosition(position));
    } catch { return Promise.reject(new Error("EDITOR_SHAPE_POSITION_INPUT_INVALID")); }
  };
  const setShapeDimensions = (request: ShapeDimensionsRequest): Promise<BrowserCurrent | null> => {
    if (disposed || !ready || importBusy || !currentView()) {
      return Promise.reject(new Error("EDITOR_SHAPE_DIMENSIONS_UNAVAILABLE"));
    }
    try {
      if (request === null || typeof request !== "object" || Array.isArray(request)) {
        throw new Error("EDITOR_SHAPE_DIMENSIONS_INPUT_INVALID");
      }
      // Capture before entering the owned lane or invoking SDK callbacks.
      const dimensions = Object.freeze({ documentId: request.documentId, revisionId: request.revisionId,
        elementId: request.elementId, width: request.width, height: request.height });
      return ownAction(() => session.setShapeDimensions(dimensions));
    } catch { return Promise.reject(new Error("EDITOR_SHAPE_DIMENSIONS_INPUT_INVALID")); }
  };
  const setShapeOpacity = (request: ShapeOpacityRequest): Promise<BrowserCurrent | null> => {
    if (disposed || !ready || importBusy || !currentView()) {
      return Promise.reject(new Error("EDITOR_SHAPE_OPACITY_UNAVAILABLE"));
    }
    try {
      if (request === null || typeof request !== "object" || Array.isArray(request)) {
        throw new Error("EDITOR_SHAPE_OPACITY_INPUT_INVALID");
      }
      // Capture before entering the owned lane or invoking SDK callbacks.
      const selection = Object.freeze({ documentId: request.documentId, revisionId: request.revisionId,
        elementId: request.elementId, opacity: request.opacity });
      return ownAction(() => session.setShapeOpacity(selection));
    } catch { return Promise.reject(new Error("EDITOR_SHAPE_OPACITY_INPUT_INVALID")); }
  };
  const setShapeFillColor = (request: ShapeFillColorRequest): Promise<BrowserCurrent | null> => {
    if (disposed || !ready || importBusy || !currentView()) {
      return Promise.reject(new Error("EDITOR_SHAPE_FILL_COLOR_UNAVAILABLE"));
    }
    try {
      if (request === null || typeof request !== "object" || Array.isArray(request)) {
        throw new Error("EDITOR_SHAPE_FILL_COLOR_INPUT_INVALID");
      }
      // Capture before entering the owned lane or invoking SDK callbacks.
      const selection = Object.freeze({ documentId: request.documentId, revisionId: request.revisionId,
        elementId: request.elementId, fillColor: request.fillColor });
      // Caller getters can synchronously start another action or dispose.
      if (disposed || !ready || importBusy || !currentView()) {
        return Promise.reject(new Error("EDITOR_SHAPE_FILL_COLOR_UNAVAILABLE"));
      }
      return ownAction(() => session.setShapeFillColor(selection));
    } catch { return Promise.reject(new Error("EDITOR_SHAPE_FILL_COLOR_INPUT_INVALID")); }
  };
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposed = true;
    // A flag does not cancel the workspace queue. Release only after owned work.
    disposal = Promise.all([flight, importFlight].map((work) =>
      work?.catch(() => undefined))).then(() => {
      session.workspace.current?.release();
      session.cache.clear();
    });
    return disposal;
  };
  return Object.freeze({ start, createScene, importJson, importPng, addRectangle, setShapePosition, setShapeDimensions, setShapeOpacity, setShapeFillColor, dispose,
    get current() { return currentView(); }, get disposed() { return disposed; } });
}
