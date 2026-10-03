import type { Page } from "@playwright/test";

export const BROWSER_DATABASE = "particle-studio-browser-viewer";
export const BROWSER_DOCUMENT = "browser-document";
type Row = Record<string, unknown>;
export type NativeRows = Partial<Record<"revisions" | "pointers" | "assets" | "autosaves" | "approvals", Row[]>>;

/** Native IDB only: reconstruct typed fields inside the serialized evaluate closure. */
export async function nativeRows(page: Page, rows: NativeRows = {}) {
  return page.evaluate(async ({ databaseName, rows }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stores = ["revisions", "pointers", "assets", "autosaves", "approvals"];
    try {
      if (Object.keys(rows).length) {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(stores, "readwrite");
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
          for (const [store, records] of Object.entries(rows)) {
            for (const original of records) {
              const record = { ...original };
              for (const field of ["bytes", "canonicalBytes", "approvalEnvelopeBytes", "canonicalDocumentBytes"]) {
                if (Array.isArray(record[field])) record[field] = new Uint8Array(record[field] as number[]);
              }
              transaction.objectStore(store).put(record);
            }
          }
        });
      }
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const transaction = database.transaction(stores, "readonly");
        const snapshot: Record<string, unknown> = {};
        transaction.oncomplete = () => resolve(snapshot);
        transaction.onerror = () => reject(transaction.error);
        for (const store of stores) {
          const request = transaction.objectStore(store).getAll();
          request.onsuccess = () => {
            snapshot[store] = JSON.parse(JSON.stringify(request.result, (_key, value: unknown) =>
              value instanceof Uint8Array ? Array.from(value) : value));
          };
        }
      });
    } finally {
      database.close(); // Test-owned connection only; never closes the production adapter.
    }
  }, { databaseName: BROWSER_DATABASE, rows });
}
