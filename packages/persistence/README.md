# Persistence core

`@particle-studio/persistence` defines validated, immutable SceneDocument revision and persistence-port contracts. Its public entrypoint is [`src/index.ts`](src/index.ts). This package models storage decisions; it does not implement filesystem or IndexedDB storage. Those adapters belong to separate packages.

## Contributor quick path

From a clean checkout at the repository root, use the pinned Node 24.20.x and npm 12.0.2 toolchain. These are intended commands, not checks claimed to have run for this README:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run validator:prepare
npx vitest run --project core packages/persistence/tests
npx tsc -p packages/persistence/tsconfig.json --noEmit --pretty false
```

Prepare the generated SceneDocument validator before importing persistence. These focused checks do not establish a root-wide suite pass.

## Public contract

- `createCompleteRevision` validates a SceneDocument v1, nonblank document/revision IDs, and a nonnegative safe-integer sequence. It stores a defensive document copy and canonical bytes with their canonicalization identifier and byte length. `createSavedRevisionPointer`, `createDraftRevisionPointer`, and `createRevisionPointersSnapshot` model separate saved and draft references; a draft may carry a `parentApprovalHash`. The `PersistenceAdapterPort` interface describes reading revisions/pointers and writing a complete revision with its pointer snapshot; this core does not perform I/O or guarantee adapter atomicity.
- `createValidAutosaveCandidate`, `createInvalidAutosaveCandidate`, and `selectRecoveryOffer` separate eligible autosaves from typed diagnostics (`incomplete`, `corrupt`, `invalid-document`). Selection filters foreign/discarded revisions and candidates not newer than the saved sequence, then ranks by descending sequence and ascending UTF-16 revision ID. It returns an offer, not an automatic restore. `acceptRecoveryOffer` preserves the saved pointer and points the draft at the offered revision; decline leaves pointers unchanged, while discard returns an explicit suppression identity for callers to retain. Decisions reject stale offers or cross-document pointers.
- `createContentAddressedAsset` checks the `sha256:` plus lowercase 64-hex identity format, nonblank MIME type, nonnegative safe-integer byte length, and matching `Uint8Array` length. It copies bytes; it does **not** calculate or verify the hash of those bytes. `AssetPersistencePort` describes async reads/writes, not a storage implementation.
- `createApprovalRecord` binds document/revision IDs, snapshot hash, canonical document bytes, envelope bytes, verified asset manifest, and local-human audit metadata to genuine in-process SceneDocument approval evidence. `validateApprovalRecord` rejects copied or forged records; `readApprovalRecordRuntimeVersion` reads private runtime evidence. `reuseIdenticalApprovalRecord` returns the existing record only when its immutable identity matches the candidate (audit time may differ), otherwise it rejects the conflict. `forkApprovedDraft` requires genuine approval and an unlinked draft pointer at the approved revision, then returns a distinct child draft pointer linked by `parentApprovalHash`, without changing the saved pointer or approval. Its accepted reasons are `content`, `runtime-version`, `schema-version`, and `verified-assets`; it does not create a new approval.

Invalid inputs throw `PersistenceValidationError` with a stable `PERSISTENCE_*` code for identity, document, pointer, recovery, asset, or approval boundaries; see the [tests](tests/persistence-ports.test.ts) for exact cases. Approval authority is an in-process branded record, not something reconstructed by deserializing plain JSON. Returned documents and bytes are defensively copied; callers and adapters remain responsible for actual durable writes, reads, and asset integrity checks.
