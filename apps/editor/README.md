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
startup owns a bounded flight; JSON, creation, PNG, rectangle and position actions share one owned flight. Empty and valid saved-only slots show an
explicitly **unpersisted sample**, without creating a draft. Existing drafts reload
verified canonical content and PNGs, then render at their own playback start.
Startup failures block import: no reset, deletion, seed or fallback success.
Accessible independent JSON/PNG/rectangle/position controls capture input once; all disable during shared work.
User imports publish through the existing workflow, hydrate locally stored PNG
references and render the current publication at its playback start. A startup-known
sequence floor permits saved-only imports while retaining saved rows; only JSON
sequencing uses it. Malformed JSON, missing assets and stale competing-tab writes
preserve the previous usable frame/publication. Errors require another explicit
activation, never a retry/reload/rebase. There is no animation or autosave.
**Create blank scene** is an explicit no-input action after healthy empty/saved-only
startup. It publishes immutable editor-local JSON through the existing JSON flight:
1,000,000 µs, range 0–1,000,000, loop true, seed 42, no tracks, and one empty
structural root group (no drawable geometry). Saved sequence 41 advances to draft
42 while retaining saved records. It does not promote the sample or replace a
current publication; both the button and facade guard existing current state.
Creation shares JSON/PNG activity, status and settlement-aware disposal.
PNG insertion requires a genuine current editable publication: **Create a scene or import JSON**
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
**Add rectangle** requires a genuine current in the configured document, never the
sample. Editable x/y/width/height default to 16/24/120/80, with fixed opacity 1;
empty/nonfinite positions or nonpositive/nonfinite sizes fail visibly. Coordinates
are root scene units, not a group's local coordinates. No JSON text or File is needed.
The narrow `EditorSession.addRectangle(geometry): Promise<void>` constructs a fresh
`createEditorDurableEditing` bridge per activation and dispatches one human-UI
`create-element` shape at command revision 0, independently of the durable sequence.
It captures geometry, source, IDs and timestamp before awaiting; rejected dispatch
fails the action. Publication binds `expectedSource` and advances source.sequence+1,
rejecting overflow. It appends without rebuilding existing fields, groups, tracks,
playback, seed or image references. Subsequent imports use the live sequence;
JSON retains its startup floor. Rectangle creation writes no asset bytes, but
canonical prehydration still rereads/redecodes referenced PNGs: duplicate handles
close once while retained handles stay renderable through publication replacement.
Named rectangle status preserves the unique unnamed primary canvas status.
All five actions share the facade's authoritative lane and UI activity. Preparation,
image hydration and stale-source failures preserve the prior publication/frame and
appropriate durable rows; there is no automatic retry/rebase or native-draw rollback.
Schema initialization is allowed; startup never writes durable content records.
On `pagehide`, a disposed flag suppresses late frames/status/publication use.
Cleanup awaits owned work, releases current and clears cache once. It does not
cancel the workspace queue or close/delete the adapter's database.

## Inspect published elements

After creating, importing or restoring a genuine draft, choose **Scene element**.
The dropdown lists every actual element in document order, including root/nested
groups and shape, line, text, particle and image variants. It starts with a
placeholder; creating an object never automatically selects it.
**Published element JSON** is a read-only view of that authored element, not the
Editable JSON textarea, animated track values or evaluated geometry. Groups retain
actual childrenIds/optional transform/visible; images expose declared asset metadata,
not bitmap handles or byte buffers. Safe DOM text preserves literal text content.

Selection is ephemeral: a new documentId/revisionId clears it even if an ID is
reused; same-source refresh or rejected work retains a still-valid selection.
Reload restores the durable scene/pixels but clears selection. Healthy ready startup
and a genuine current are required; empty/saved-only users must Create blank scene
or import JSON. Pending, failed startup, unavailable context and disposal disable it.
All five actions disable selection in their shared lane; named inspector
feedback identifies retained detail's previous publication while pending. Settlement
refreshes actual current even after publication succeeded but rendering failed.
The inspector borrows metadata only: its frozen `getSelection()` token contains
only documentId/revisionId/elementId, retaining valid identity while busy but no
action permission. Optional notifications signal meaningful selection/source
changes, not every busy refresh. Inspection performs no persistence,
asset I/O, runtime evaluation, painting, bitmap lookup/decode/close or resource
ownership. Pagehide removes its sole change listener once and freezes late updates.
No canvas picking/highlights, drag editing, undo or timeline controls are added.

`editor-element-inspector.test.tsx` covers the DOM/identity/lifetime contract;
`browser/element-inspector.spec.ts` exercises real production publications and
inspection-only native-row, pixel and per-bitmap zero-effect comparisons.

## Edit selected shape position

Choose a published **shape**, then edit **Position X** and **Position Y** and use
**Apply position**. Values are authored/local even for transformed nested shapes,
not world coordinates, evaluated tracks or unsent Editable JSON. Both axes apply
atomically; trimmed-empty/nonfinite values fail, while negative/fractional values
are valid. Every other element variant remains inspectable with disabled fields.

`EditorSession.setShapePosition({documentId, revisionId, elementId, x, y})` and its
browser mirror capture source and values once. Live source, shape, finite axes and
sequence room are checked before IDs/time/I/O. A fresh human-UI bridge dispatches
`set-shape-position` at command revision 0 with no element-ID allocation. Durable
publication uses selected expectedSource, source.sequence+1 and the existing CAS.
It preserves all fields except X/Y and does not write asset bytes or rebase.

Equal coordinates still publish a new durable revision/sequence/pointer. Any new
publication clears selection even with a stable element ID: explicitly reselect
to edit again. Same-source rejection retains selection and typed input. Named
**Position status** distinguishes publication followed by rendering failure from
rejected editing; settlement refreshes inspection from actual current either way.
Position controls dispose before the inspector; late DOM work stays inert while
the existing browser owner waits for work before releasing image resources.

`editor-position-controls.test.tsx` covers metadata/input/callback contracts;
`browser/set-shape-position.spec.ts` covers production root/nested pixels, canonical
history/reload, real PNG handle ownership, five-action exclusion, native CAS
winners and resolving/rejecting pagehide. Startup gates remain in the inspector spec.

## Shape dimensions SDK (issue #116, chain PR1)

`EditorSession.setShapeDimensions({documentId, revisionId, elementId, width, height})`
is the source-bound durable SDK action introduced in PR1, mirrored by the browser
facade in PR2 without visible dimensions UI. It captures all five scalars once before callbacks/awaits;
a genuine live matching publication, root/nested shape and sequence room are required.
Both new dimensions must be finite positive numbers (fractions are valid), checked
before IDs/time or asset/persistence I/O. Existing schema-valid zero/negative source
sizes remain importable. A fresh human-UI bridge dispatches `set-shape-dimensions`
at command revision 0 without element-ID allocation, preserving stable ID and every
field except width/height. Selected expectedSource and existing CAS prevent rebasing;
equal pairs still publish a new durable revision, sequence and pointer. Bounded
`EDITOR_SHAPE_DIMENSIONS_*` failures preserve current/history and any durable winner.
PNG prehydration retains useful handles and closes duplicates once; the existing
owner awaits settlement before cleanup. Core session tests use the real workspace
and IndexedDB adapter with fake-indexeddb, not native Chromium dimension proof.

## Browser dimensions API (issue #116, chain PR2)

`createBrowserEditorSession().setShapeDimensions(request)` mirrors the SDK request.
It rejects disposed/not-ready/busy/no-current state before reading caller getters,
then reads and freezes exactly five scalars before entering the owned lane or SDK
callbacks. Throwing getters/malformed requests reject with bounded input errors.
JSON, blank, PNG, rectangle, position and dimensions now share six-action exclusion,
including direct API calls. SDK source/type/pair/sequence guards remain authoritative;
there is no retry, rebase or element-ID allocation. Schema-valid zero/negative
source sizes remain importable; both requested sizes must be finite and positive.
Success returns actual current as borrowed rendering data, never release authority.
Rendering belongs to the caller: a postcommit render failure cannot undo publication.
Disposal returns null current immediately, awaits resolving/rejecting owned work,
then releases publication/cache once; callers must suppress late frame/DOM updates.
The native API fixture proves dimensions independently of a production controller;
visible dimensions controls and built-entry proof remain later chain units.

## Standalone dimensions controls (issue #116, chain PR3)

`mountEditorDimensionControls` accepts caller-supplied form, width/height inputs,
button, named **Dimension status**, shared activity, `getSelection`/`getCurrent`,
`setShapeDimensions` and `onPublished`. It creates no production markup or renderer.
Only matching published shape metadata enables editing; root/nested values are
original authored dimensions, including schema-valid zero/negative initial sizes.
Both new values must be nonempty, finite and positive; fractions and equal pairs
are valid. Each raw input and the frozen five-scalar intent are captured before
activity callbacks. Ready/own/shared busy gates honor six-action exclusion.
New document/revision identity clears selection through the inspector and requires
explicit reselection; same-source rejection preserves typed values and selection.
Own success or committed-but-render-failed feedback survives shared settlement;
external changed-source settlement refreshes guidance from actual current.
Dispose controls before the inspector: listener removal and late-output suppression
are idempotent, without cancellation or resource release. The browser remains owner.
`editor-dimension-controls.test.tsx` supplies standalone DOM contract proof;
production wiring and built-entry/native UI proof remain PR4, not exposed here.

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
`editor-rectangle-controls.test.tsx` covers capture/shared activity/disposal;
`browser/rectangle-create.spec.ts` uses the built entry, native IDB, real PNGs and
per-bitmap lifetimes to cover pixels/refresh, winners and both pagehide outcomes.
