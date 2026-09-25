# Filesystem persistence adapter

`@particle-studio/persistence-fs` stores revisions and pointer snapshots under an outputs root, and content-addressed assets under a workspace root. It implements the ports from [`@particle-studio/persistence`](../persistence/README.md); the documents root is part of the confinement authority but these adapters do not write to it.

## Contributor quick path

From a clean checkout at the repository root, use Node 24.20.x and npm 12.0.2. These are **intended commands**, not checks claimed to have run for this change:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run validator:prepare
npx vitest run --project core packages/persistence-fs/tests
npx tsc -p packages/persistence-fs/tsconfig.json --noEmit --pretty false
```

Prepare the generated SceneDocument validator before importing the revision/asset persistence chain. These focused checks do not establish a root-wide suite or platform-independent filesystem guarantee.

## Public entrypoints

- `@particle-studio/persistence-fs` (`.`): `createRootConfinement({ workspace, documents, outputs })` accepts three existing absolute directory roots, canonicalizes them, and rejects equal or nested roots (including aliases). The returned authority binds role-relative operations: `resolveExistingPath`, `prepareCreateTarget`/`verifyCreatedTarget`, `prepareReplaceableTarget`, `publishImmutableFile`, and `publishReplaceablePointer`. Invalid operation paths (including traversal, absolute paths, device names, and ambiguous components) are rejected. `RootConfinementError.code` distinguishes failures.
- `@particle-studio/persistence-fs/revision-persistence`: `createFileSystemPersistenceAdapter({ authority })` returns `readRevision`, `readPointers`, and `writeCompleteRevision`. Complete revisions are immutable canonical records in a private outputs layout; identical records are reused, conflicting or corrupt records are rejected. Each successful write replaces one versioned `{ saved, draft }` pointer snapshot, including an all-null snapshot. Pointer references are checked for complete revisions; a failed pointer publication can leave an orphan revision. `FileSystemPersistenceError.code` identifies validation, stored-record, publication, and durability-uncertain failures.
- `@particle-studio/persistence-fs/asset-persistence`: `createFileSystemAssetPersistenceAdapter({ authority })` returns `writeAsset` and `readAsset`. Records live in a private workspace layout keyed by SHA-256 of asset bytes. Reads verify canonical encoding, byte length, and digest; identical records are reused, while MIME conflicts and corrupt records fail without overwrite. Raw assets are limited to 16 MiB and serialized records to 24 MiB. `FileSystemAssetPersistenceError.code` distinguishes input, record, publication, and durability-uncertain failures.

Test-only seams and layout helpers are not package exports. See the [filesystem tests](tests) for the exact error cases and size limits.

## Confinement and publication limits

Confinement checks canonical containment at operation boundaries and rejects symlinked record leaves on adapter reads and non-regular/symlinked pointer leaves when preparing replacement. Directories are provisioned one level at a time; publisher stages bytes in an exclusive same-directory file, syncs and closes it, then hard-links immutable records without replacement or renames replaceable pointers, rechecks the final path, and syncs the parent directory. Pre-publication failure does not report success; cleanup is best effort. Once publication occurs, a failed final check or directory operation reports **durability uncertain** rather than rolling back: inspect the stored record before retrying. This is not a multi-record transaction, nor a defense against concurrent namespace swaps, hard links, mount indirection, or a same-user adversary controlling the roots; prepared paths do not reserve filesystem state.
