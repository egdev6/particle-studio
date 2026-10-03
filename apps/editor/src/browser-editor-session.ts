import { createIndexedDbPersistenceAdapter } from "@particle-studio/persistence-indexeddb";
import type { DurableDraftPublication } from "./durable-draft-workspace.js";
import { browserPngDecodePrimitive, browserSha256 } from "./browser-png-platform.js";
import { createEditorSession } from "./editor-session.js";

// One local editor slot; absence never creates a durable document.
export const BROWSER_DATABASE = "particle-studio-browser-viewer";
export const BROWSER_DOCUMENT = "browser-document";
/** Borrowed rendering data only; no publication release or cache authority. */
export interface BrowserCurrent {
  readonly revision: DurableDraftPublication["revision"];
  readonly images: DurableDraftPublication["workspace"]["images"];
}
export type BrowserStartup =
  | { readonly kind: "sample" }
  | { readonly kind: "restored"; readonly current: BrowserCurrent }
  | { readonly kind: "disposed" };

export function createBrowserEditorSession() {
  const persistence = createIndexedDbPersistenceAdapter({ databaseName: BROWSER_DATABASE });
  const readPointers = persistence.readPointers.bind(persistence);
  let sequenceFloor = 0;
  const session = createEditorSession({
    persistence, documentId: BROWSER_DOCUMENT,
    sha256: browserSha256, decodePng: browserPngDecodePrimitive.decodePng,
    jsonImportSequenceFloor: () => sequenceFloor,
    revisionId: () => crypto.randomUUID(), createdAt: Date.now,
    commandId: () => crypto.randomUUID(),
    elementIdSource: () => ({ kind: "id", id: `image-${crypto.randomUUID()}` }),
    geometry: () => ({ x: 0, y: 0, width: 1, height: 1, opacity: 1 }),
  });
  let disposed = false;
  let ready = false;
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
  const importJson = (editableJson: string): Promise<BrowserCurrent | null> => {
    if (disposed || !ready || importFlight) return Promise.reject(new Error("EDITOR_JSON_IMPORT_UNAVAILABLE"));
    // Capture input and activate synchronously. Only this facade owns session
    // actions: single flight excludes any queued reload/release/source change.
    // The genuine publication still checks its prior pointers and performs CAS.
    try {
      importFlight = session.importWorkflow({ kind: "editable-json-import", editableJson })
        .then(() => currentView()).finally(() => { importFlight = undefined; });
    } catch (error) { return Promise.reject(error); }
    return importFlight;
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
  return Object.freeze({ start, importJson, dispose,
    get current() { return currentView(); }, get disposed() { return disposed; } });
}
