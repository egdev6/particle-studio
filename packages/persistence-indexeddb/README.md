# IndexedDB persistence adapter

`@particle-studio/persistence-indexeddb` stores SceneDocument revisions, pointers, autosaves, content-addressed assets, and approval records in browser IndexedDB through Dexie. Its public entrypoint is [`src/index.ts`](src/index.ts). The tests use `fake-indexeddb/auto` under Node; the adapter itself requires IndexedDB and Web Crypto (`crypto.subtle.digest`).

## Contributor quick path

From a clean checkout at the repository root, use Node 24.20.x and npm 12.0.2. These are **intended commands**, not checks claimed to have run for this change:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run validator:prepare
npx vitest run --project core packages/persistence-indexeddb/tests
npx tsc -p packages/persistence-indexeddb/tsconfig.json --noEmit --pretty false
```

Prepare the generated SceneDocument validator before running the focused tests. These checks do not establish a root-wide suite or browser pass.

## Public contract

`createIndexedDbPersistenceAdapter({ databaseName })` returns the core `PersistenceAdapterPort` and `AssetPersistencePort` plus `IndexedDbAutosaveStorage` and `IndexedDbApprovalStorage`. The optional `injectAssetWriteFailure` and `injectPointerPublicationFailure` callbacks are failure-injection hooks. The exported `IndexedDbPersistenceError` carries an `IndexedDbPersistenceErrorCode`; core validation can also reject invalid inputs. `deleteIndexedDbPersistenceDatabase(databaseName)` deletes the named database (used by test cleanup). Callers choose a database name and manage its lifecycle; there is no explicit close method on the returned adapter.

- `writeCompleteRevision` validates a complete revision and publishes its saved/draft pointer snapshot in one Dexie transaction. `readRevision` returns a complete revision or `null`; `readPointers` returns empty pointers for an absent record but rejects dangling, foreign, or incomplete stored pointers.
- `writeAutosaveRevision` writes a revision and autosave together, retaining the ten newest complete non-saved autosaves per document; a saved autosave is protected. `readAutosaveRevisions` returns complete entries newest first. `readRecoveryOffer` selects an offer using the core recovery rules, reports incomplete/corrupt candidates, and removes those invalid autosave entries after constructing the result. It does **not** accept the offer or change pointers automatically.
- `writeAsset` computes a SHA-256 address from bytes and writes it independently of revisions and pointers. Identical bytes and metadata can be reused; a same-address metadata conflict is rejected. `readAsset` checks stored byte shape, length, and actual SHA-256 before returning a defensive asset. The core asset constructor validates hash **format** and byte length, but does not itself compute or verify the digest.
- `writeApproval` validates genuine approval evidence and verifies every referenced stored asset, then inserts or reuses an immutable approval in a Dexie transaction. `readApproval` revalidates the stored seal and approval evidence; absent records return `null`. An approval write does not publish revision pointers or create missing assets.

Writes map quota failures to `PERSISTENCE_INDEXEDDB_QUOTA_EXCEEDED` and other storage failures to `PERSISTENCE_INDEXEDDB_WRITE_FAILED` where handled; asset reads distinguish missing, unreadable, and hash-mismatched data, while invalid stored pointers use `PERSISTENCE_INDEXEDDB_POINTER_INCOMPLETE`. Approval validation/conflicts can retain core `PERSISTENCE_*` errors. Transactions cover the tables named for each write, not a single transaction spanning separate API calls or all persistence operations. See [adapter tests](tests/indexeddb-persistence.test.ts) and the [persistence core contract](../persistence/README.md) for recovery and approval semantics.
