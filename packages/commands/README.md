# Commands

`@particle-studio/commands` provides an in-memory, revisioned editing session for validated SceneDocument v1 documents. Its public entrypoint is [`src/index.ts`](src/index.ts).

## Contributor quick path

From a clean checkout at the repository root, use the pinned Node 24.20.x and npm 12.0.2 toolchain. These are intended commands, not checks claimed to have run for this README:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run validator:prepare
npx vitest run --project core packages/commands/tests/command-session.test.ts
npx tsc -p packages/commands/tsconfig.json --noEmit --pretty false
```

Prepare the generated SceneDocument validator before importing commands. These focused checks do not establish a root-wide suite pass.

## Public contract

`createCommandSession(documentId, document, idSource?)` validates the initial document and requires a nonempty document ID; invalid input throws `TypeError("INVALID_INITIAL_SESSION")`. It clones the document. The optional `ElementIdSource` returns `{ kind: "id", id }` or `{ kind: "unavailable" }`; creating, replacing, or grouping elements needs a valid, noncolliding source ID.

The returned `CommandSession` exposes `dispatch(command)`, `snapshot()`, `undo()`, `redo()`, and `fork()`. `snapshot()` returns a detached `{ revision, document }`. `dispatch` accepts an unknown value and checks a version-1 envelope with nonempty `commandId` and `documentId`, safe-integer `expectedRevision`, `actorCapability` (`human-ui`, `browser-agent`, or `headless-agent`), and a supported payload. Payload types cover element creation/removal/replacement, grouping/ungrouping/reparenting, keyframe value updates, and track/keyframe creation, removal, changes, and moves; see the [tests](tests/command-session.test.ts) for exact payload shapes.

A successful dispatch validates the candidate document, returns `{ ok: true, revision, document }` with a detached document, and advances the revision by one. `expectedRevision` must equal the current revision; `commandId` is required but is not a deduplication key. Successful undo/redo replay validated patches and also advance the revision; a successful new dispatch clears redo. Even a valid no-op dispatch advances the revision. `fork()` copies the document, revision, and undo/redo history so later edits are independent, but shares the same ID-source callback (its external state is not rewound).

Failures return `{ ok: false, error: { code } }` without changing the session document, revision, or history. Codes are `MALFORMED_COMMAND`, `DOCUMENT_MISMATCH`, `REVISION_CONFLICT`, `TARGET_NOT_FOUND`, `INVALID_CANDIDATE`, `NOTHING_TO_UNDO`, `NOTHING_TO_REDO`, `ID_SOURCE_UNAVAILABLE`, `ID_SOURCE_INVALID`, `ID_COLLISION`, and `LAST_KEYFRAME`. Candidate validation uses SceneDocument's validator; this API reports a code, not the validator's detailed error. An ID-source callback may still have been called on a rejected candidate, so external ID allocation is not transactional.
