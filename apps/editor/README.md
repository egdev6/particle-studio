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

The production entry is a vanilla durable JSON editor. `browser-editor-session.ts`
composes the actual IndexedDB adapter, browser SHA-256/PNG primitives and editor
session for the fixed local database `particle-studio-browser-viewer` and document
`browser-document`. Dependencies are captured at construction without I/O;
startup and explicit JSON imports each own a bounded flight. Empty and valid saved-only slots show an
explicitly **unpersisted sample**, without creating a draft. Existing drafts reload
verified canonical content and PNGs, then render at their own playback start.
Startup failures block import: no reset, deletion, seed or fallback success.
Accessible JSON controls capture input once and disable during startup/import.
User imports publish through the existing workflow, hydrate locally stored PNG
references and render the current publication at its playback start. A startup-known
sequence floor permits saved-only imports while retaining saved rows; only JSON
sequencing uses it. Malformed JSON, missing assets and stale competing-tab writes
preserve the previous usable frame/publication. Errors require another explicit
activation, never a retry/reload/rebase. There is no PNG upload, animation or autosave.
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
