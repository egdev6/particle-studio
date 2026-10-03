import { createIndexedDbPersistenceAdapter } from "@particle-studio/persistence-indexeddb";
import type { DurableDraftPublication } from "./durable-draft-workspace.js";
import { browserPngDecodePrimitive, browserSha256 } from "./browser-png-platform.js";
import { createEditorSession } from "./editor-session.js";

// One local read-only viewer slot; absence never creates a durable document.
export const BROWSER_DATABASE = "particle-studio-browser-viewer";
export const BROWSER_DOCUMENT = "browser-document";
export type BrowserStartup =
  | { readonly kind: "sample" }
  | { readonly kind: "restored"; readonly current: DurableDraftPublication }
  | { readonly kind: "disposed" };

export function createBrowserEditorSession() {
  const persistence = createIndexedDbPersistenceAdapter({ databaseName: BROWSER_DATABASE });
  const readPointers = persistence.readPointers.bind(persistence);
  const session = createEditorSession({
    persistence, documentId: BROWSER_DOCUMENT,
    sha256: browserSha256, decodePng: browserPngDecodePrimitive.decodePng,
    revisionId: () => crypto.randomUUID(), createdAt: Date.now,
    commandId: () => crypto.randomUUID(),
    elementIdSource: () => ({ kind: "id", id: `image-${crypto.randomUUID()}` }),
    geometry: () => ({ x: 0, y: 0, width: 1, height: 1, opacity: 1 }),
  });
  let disposed = false;
  let flight: Promise<BrowserStartup> | undefined;
  let disposal: Promise<void> | undefined;
  const start = (): Promise<BrowserStartup> => {
    if (flight) return flight;
    flight = (async (): Promise<BrowserStartup> => {
      if (disposed) return { kind: "disposed" };
      try {
        const pointers = await readPointers(BROWSER_DOCUMENT);
        if (disposed) return { kind: "disposed" };
        if (pointers.draft === null) return { kind: "sample" };
        const current = await session.reload();
        return disposed ? { kind: "disposed" } : { kind: "restored", current };
      } catch (error) {
        if (disposed) return { kind: "disposed" };
        throw error;
      }
    })();
    return flight;
  };
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposed = true;
    // A flag does not cancel the workspace queue. Release only after owned work.
    disposal = (flight ?? Promise.resolve()).catch(() => undefined).then(() => {
      session.workspace.current?.release();
      session.cache.clear();
    });
    return disposal;
  };
  return Object.freeze({ start, dispose, get disposed() { return disposed; } });
}
