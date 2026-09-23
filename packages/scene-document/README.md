# Scene document

`@particle-studio/scene-document` defines the versioned, editable SceneDocument v1 contract and its validation and canonical approval-snapshot APIs. Contributors can use the root entrypoint to reject invalid documents, produce deterministic JSON bytes, and construct approval evidence without importing the internal schema or generated validator directly.

## Quick path

From the repository root, after `npm ci`, run `npm run validator:prepare`. This generates the standalone v1 validator and verifies its installed bytes against the pinned contract and SHA-256. A mismatch fails closed; do not hand-edit the generated output or update its expected fingerprints as a routine workaround.

## Public contract

| Export | Purpose |
| --- | --- |
| `SceneDocumentV1` | Type for the `schemaVersion: 1` document. |
| `validateSceneDocument(value)` | Returns `{ ok: true, value }` or `{ ok: false, error: { code } }`; checks schema, hierarchy, playback range, and tracks. `validateSceneDocument.importEditableJson(json)` parses and returns a cloned validated document or an import error. |
| `canonicalizeSceneDocument(value)` | Validates and returns `{ identifier: "jcs-1", bytes }` (canonical JSON in UTF-8); throws on invalid input. `canonicalizeSceneDocument.exportEditableJson(value)` returns a copy of those bytes. |
| `createApprovalEnvelope(input)` | Async; accepts a document, nonempty `runtimeVersion`, and `verifiedAssetManifest`; returns canonical envelope bytes and a SHA-256 snapshot hash. |
| `validateCanonicalApprovalEnvelope(value)`, `readCanonicalApprovalEvidence(value)` | Check an in-process branded approval envelope and read construction-time evidence with copied byte arrays; serialized objects cannot recreate that authority. |
| `CANONICALIZATION_IDENTIFIER`, `APPROVAL_ENVELOPE_IDENTIFIER`, `APPROVAL_POLICY_IDENTIFIER`, `APPROVAL_HASH_IDENTIFIER` | Versioned identifiers for canonicalization and approval. Corresponding exported types include `CanonicalSceneDocument`, `ApprovalEnvelope`, `CanonicalApprovalEnvelope`, `ValidatedCanonicalApprovalEvidence`, and `VerifiedAssetManifestEntry`. |
| `FIRST_SLICE_DOCUMENT`, `FIRST_SLICE_CANONICAL_HEX`, `FIRST_SLICE_CANONICAL_SHA256` | Reference fixture and expected canonical bytes/hash for the first slice. |

See [`src/index.ts`](src/index.ts) for the exact entrypoint and [`src/schemas/scene-document-v1.ts`](src/schemas/scene-document-v1.ts) for the v1 fields. Unknown schema versions are not migrated: validation rejects them, and editable JSON import reports an unsupported-version error. Canonicalization uses the `jcs-1` identifier; approval envelopes separately carry policy, hash, schema, and runtime versions. Changing those contracts requires deliberate versioning, not just regenerating bytes.

## Generated validator and checks

The generator is [`scripts/generate-scene-document-v1-validator.ts`](scripts/generate-scene-document-v1-validator.ts). Its output is `src/generated/scene-document-v1-validator.generated.mjs`; the adjacent `.sha256` and `src/validation/scene-document-v1-validator-contract.ts` pin expected output and contract, while the `.d.mts` supplies its declaration. Keep generated output reproducible via `npm run validator:prepare`; review fingerprint changes alongside schema, generator, or dependency changes.

Intended focused checks from the repository root (not a claim that they have passed here):

```sh
npm run validator:prepare
npx vitest run --project core packages/scene-document/tests
npx tsc -p packages/scene-document/tsconfig.json --noEmit --pretty false
```

The focused tests live in [`tests/`](tests/). Root-wide `npm run typecheck`, product, browser, integration, and full-suite results require other product projects; run and report those separately when integrating the full change.
