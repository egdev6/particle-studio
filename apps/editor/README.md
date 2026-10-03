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

The production entry is a read-only durable viewer. `browser-editor-session.ts`
composes the actual IndexedDB adapter, browser SHA-256/PNG primitives and editor
session for the fixed local database `particle-studio-browser-viewer` and document
`browser-document`. Identity and unused ID/time/geometry sources are captured at
construction; startup owns one flight. Empty and valid saved-only slots show an
explicitly **unpersisted sample**, without creating a draft. Existing drafts reload
verified canonical content and PNGs, then render at their own playback start.
Failures are visible and preserve actual stored rows: no reset, deletion, seed,
fallback success, import controls, editing or animation. Schema initialization is
allowed; startup never writes document, revision, pointer or asset records.
On `pagehide`, a disposed flag suppresses late frames/status/publication use.
Cleanup awaits owned work, releases current and clears cache once. It does not
cancel the workspace queue or close/delete the adapter's database.

Run `npm run validator:prepare` before
`npx vitest run --project core apps/editor/tests/editor-frame.test.ts`.
Use `npm run build`, `npm run dev`, and `npm run preview` for the read-only viewer.
`npm run test:browser` covers PNG adapters, frame pixels, and production preview.
`npx vitest run --project core apps/editor/tests/browser-editor-session.test.ts`
checks delayed startup/disposal lifetime; native Chromium owns the durable matrix.
