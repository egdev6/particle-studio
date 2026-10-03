# Editor frame rendering

`src/editor-frame.ts` composes the existing runtime and Canvas2D renderer.
`createRuntimeImageResolver(images)` maps cached PNG hashes to borrowed handles,
MIME type, byte length, and intrinsic dimensions. Unknown hashes resolve to
`undefined`; runtime validation rejects unresolved or mismatched references.
The readonly input is a rendering view, not publication authority or byte verification.
The caller owns image lifetimes: keep handles open during rendering and release
or close them through their owner afterward. These helpers never adopt or close them.

`renderEditorFrame(context, document, images, timeUs, viewport)` evaluates the
whole scene before any context operation, clears the caller-supplied viewport,
and draws ordered commands. It returns the runtime evaluation. Rejected evaluation
leaves existing pixels untouched; a valid replacement clears old geometry.
The caller owns context state and viewport dimensions. Mid-draw exceptions and
unsupported native handles have no transactional rollback guarantee.

The production entry is a vanilla durable JSON editor with PNG insertion. `browser-editor-session.ts`
composes the actual IndexedDB adapter, browser SHA-256/PNG primitives and editor
session for the fixed local database `particle-studio-browser-viewer` and document
`browser-document`. Dependencies are captured at construction without I/O;
startup owns a bounded flight; JSON and PNG imports share one owned flight. Empty and valid saved-only slots show an
explicitly **unpersisted sample**, without creating a draft. Existing drafts reload
verified canonical content and PNGs, then render at their own playback start.
Startup failures block import: no reset, deletion, seed or fallback success.
Accessible independent JSON/PNG controls capture input once; both disable during shared work.
User imports publish through the existing workflow, hydrate locally stored PNG
references and render the current publication at its playback start. A startup-known
sequence floor permits saved-only imports while retaining saved rows; only JSON
sequencing uses it. Malformed JSON, missing assets and stale competing-tab writes
preserve the previous usable frame/publication. Errors require another explicit
activation, never a retry/reload/rebase. There is no animation or autosave.
PNG insertion requires a genuine current editable publication: **Import JSON first**
in empty/saved-only state. The sample is never converted or seeded. Choose a File
and visible x/y/width/height in scene units (defaults 0/0/64/64, opacity 1).
Positions must be finite and sizes positive/finite. The facade captures placement;
the existing image workflow snapshots source/IDs before file I/O, then writes,
rereads, hashes, decodes, caches and publishes an image through the command path.
Import staging and publication prehydration decode independently: the cache keeps
the staged handle and closes the unowned duplicate. Disposal closes the retained
handle after settlement; each distinct decoded handle is closed exactly once.
Dedicated PNG status reports errors without replacing the canvas/JSON status.
PNG failures preserve document/pointer/current/frame, **not necessarily assets**:
immutable bytes may already be written before verification, decode or stale-source
rejection. No rollback, garbage collection or asset cleanup is added.
Schema initialization is allowed; startup never writes durable content records.
On `pagehide`, a disposed flag suppresses late frames/status/publication use.
Cleanup awaits owned work, releases current and clears cache once. It does not
cancel the workspace queue or close/delete the adapter's database.

Run `npm run validator:prepare` before
`npx vitest run --project core apps/editor/tests/editor-frame.test.ts`.
Use `npm run build`, `npm run dev`, and `npm run preview` for the JSON editor.
`npm run test:browser` covers PNG adapters, frame pixels, and production preview.
`npx vitest run --project core apps/editor/tests/browser-editor-session.test.ts`
checks owned startup/import settlement and idempotent disposal; native Chromium
owns the durable matrix. The facade exposes borrowed rendering data, not release
or cache authority. `editor-json-import-controls.test.tsx` separately checks vanilla
readiness, captured input, single flight, actionable errors and listener cleanup.
`editor-png-import-controls.test.tsx` tests shared cross-action activity and captured
File/geometry; `browser/png-import.spec.ts` proves built-entry pixels, durable
identity/refresh, exact permitted failed asset writes and settlement-aware disposal.
