# Commands

`@particle-studio/commands` provides an in-memory, revisioned editing session for validated SceneDocument v1 documents. Its public entrypoint is [`src/index.ts`](src/index.ts).

## Contributor quick path

From a clean checkout at the repository root, use the pinned Node 24.20.x and npm 12.0.2 toolchain. These are intended commands, not checks claimed to have run for this README:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run validator:prepare
npx vitest run --project core packages/commands/tests
npx tsc -p packages/commands/tsconfig.json --noEmit --pretty false
```

Prepare the generated SceneDocument validator before importing commands. These focused checks do not establish a root-wide suite pass.

## Public contract

`createCommandSession(documentId, document, idSource?)` validates the initial document and requires a nonempty document ID; invalid input throws `TypeError("INVALID_INITIAL_SESSION")`. It clones the document. The optional `ElementIdSource` returns `{ kind: "id", id }` or `{ kind: "unavailable" }`; creating, replacing, or grouping elements needs a valid, noncolliding source ID.

The returned `CommandSession` exposes `dispatch(command)`, `snapshot()`, `undo()`, `redo()`, and `fork()`. `snapshot()` returns a detached `{ revision, document }`. `dispatch` accepts an unknown value and checks a version-1 envelope with nonempty `commandId` and `documentId`, safe-integer `expectedRevision`, `actorCapability` (`human-ui`, `browser-agent`, or `headless-agent`), and a supported payload. Payload types cover element creation/removal/replacement, grouping/ungrouping/reparenting, keyframe value updates, and track/keyframe creation, removal, changes, and moves; see the [tests](tests/command-session.test.ts) for exact payload shapes.

### Shape position

The private supported payload `{ type: "set-shape-position", elementId, x, y }` requires exactly those keys, a nonempty element ID and two finite numbers. It requires `actorCapability: "human-ui"`; browser-agent and headless-agent requests return `MALFORMED_COMMAND`. This envelope policy is not authentication; other operations retain their existing actor handling.

An existing root or nested shape keeps its ID while both authored/local axes change atomically in one validated candidate and one revision/history entry. Negative and fractional coordinates are accepted; no world conversion, reparenting or ID allocation occurs. Every other document field is preserved. Missing targets return `TARGET_NOT_FOUND`; nonshape targets return `INVALID_CANDIDATE`.

Equal coordinates are accepted without a no-op error and still append their own undo entry, possibly with empty patches. See the [position tests](tests/command-set-shape-position.test.ts). This primitive is in-memory only: it adds no UI, durable writes or bitmap/cache behavior.

### Shape dimensions

The private supported payload `{ type: "set-shape-dimensions", elementId, width, height }` requires exactly those keys, a nonempty element ID and two finite numbers strictly greater than zero, including positive fractions. This command-only restriction does not narrow SceneDocument's finite-only shape dimension domain. It requires `actorCapability: "human-ui"`; browser-agent and headless-agent requests return `MALFORMED_COMMAND`. This envelope policy is not authentication; other operations retain their existing actor handling.

An existing root or nested shape keeps its ID while both authored/local dimensions change atomically in one validated candidate and one revision/history entry. Every other document field is preserved; no ID allocation, world conversion or reparenting occurs. Missing targets return `TARGET_NOT_FOUND`; nonshape targets return `INVALID_CANDIDATE`.

Equal positive dimensions are accepted and still append their own undo entry, possibly with empty patches. See the [dimensions tests](tests/command-set-shape-dimensions.test.ts). This primitive is in-memory only: it adds no UI, durable writes, bitmap/cache behavior or new agent capability.

### Shape opacity

The private supported payload `{ type: "set-shape-opacity", elementId, opacity }` requires exactly those keys, a nonempty element ID and a finite number from 0 through 1 inclusive. Zero, negative zero, one and fractions are accepted without coercion. This command-only restriction does not narrow SceneDocument's finite-only shape opacity domain: existing values such as -0.25 or 2 remain valid initial document values, without clamping or migration.

It requires `actorCapability: "human-ui"`; browser-agent and headless-agent requests return `MALFORMED_COMMAND`. This envelope policy is not authentication; older commands retain their existing actor handling.

An existing root or nested shape keeps its ID while only its authored opacity changes in one validated candidate and one revision/history entry. Every other document field is preserved, including transforms, hierarchy, asset references and tracks; no ID allocation occurs. Missing targets return `TARGET_NOT_FOUND`; nonshape targets return `INVALID_CANDIDATE`. Unchanged opacity tracks can override authored opacity during rendering; this command does not alter renderer behavior.

Equal values, including zero, still append their own undo entry, possibly with empty patches, and clear redo. See the [opacity tests](tests/command-set-shape-opacity.test.ts). This primitive is in-memory only: it adds no UI, durable writes, public payload API or new agent capability.

### Color de relleno de shapes

El payload privado `{ type: "set-shape-fill-color", elementId, fillColor }` exige exactamente esas tres claves de cadena propias y enumerables, un ID no vacío y `#` seguido de seis dígitos hexadecimales ASCII. Conserva las mayúsculas/minúsculas; no acepta alpha, abreviaturas ni coerción. Solo admite `actorCapability: "human-ui"`: es una política del envelope, no autenticación ni una nueva capacidad de agentes.

Edita únicamente el relleno de una shape existente, raíz o anidada, en un candidato validado y una entrada de revisión/historial; no asigna IDs. Los guards de documento/revisión y los errores de target mantienen su comportamiento existente. Undo restaura el documento anterior, incluida la ausencia de `fillColor`; redo reproduce el valor literal. Un valor idéntico también crea una entrada de historial y limpia redo.

Véanse los [tests de color](tests/command-set-shape-fill-color.test.ts). Esta primitiva es solo en memoria: todavía no añade API durable ni controles de Inspector.

### Visibilidad de shapes

El payload privado `{ type: "set-shape-visibility", elementId, visible }` exige exactamente `type`, `elementId` y `visible` como claves propias y enumerables; `visible` debe ser booleano y el ID una cadena no vacía sin recortar. Solo admite `actorCapability: "human-ui"`: es una política del envelope, no autenticación.

Edita únicamente `visible` de una shape existente, raíz o anidada, conservando ID, transform, relleno, assets y tracks; no asigna IDs. Targets ausentes devuelven `TARGET_NOT_FOUND`; otros tipos (grupo, línea, partícula, texto, imagen) devuelven `INVALID_CANDIDATE`.

Undo elimina un `visible` recién insertado o restaura el anterior; un valor booleano igual también crea una entrada de historial y limpia redo. Véanse los [tests de visibilidad](tests/command-set-shape-visibility.test.ts). Es solo en memoria: no añade SDK, UI ni píxeles nativos.

### Revision and history

A successful dispatch validates the candidate document, returns `{ ok: true, revision, document }` with a detached document, and advances the revision by one. `expectedRevision` must equal the current revision; `commandId` is required but is not a deduplication key. Successful undo/redo replay validated patches and also advance the revision; a successful new dispatch clears redo. Even a valid no-op dispatch advances the revision. `fork()` copies the document, revision, and undo/redo history so later edits are independent, but shares the same ID-source callback (its external state is not rewound).

Failures return `{ ok: false, error: { code } }` without changing the session document, revision, or history. Codes are `MALFORMED_COMMAND`, `DOCUMENT_MISMATCH`, `REVISION_CONFLICT`, `TARGET_NOT_FOUND`, `INVALID_CANDIDATE`, `NOTHING_TO_UNDO`, `NOTHING_TO_REDO`, `ID_SOURCE_UNAVAILABLE`, `ID_SOURCE_INVALID`, `ID_COLLISION`, and `LAST_KEYFRAME`. Candidate validation uses SceneDocument's validator; this API reports a code, not the validator's detailed error. An ID-source callback may still have been called on a rejected candidate, so external ID allocation is not transactional.
