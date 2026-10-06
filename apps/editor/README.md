# Editor frame rendering

Para operar la UI, sigue el [manual funcional](../../docs/functional-guide.md).
La [matriz de fronteras](../../docs/boundary-matrix.md) separa dominio, SDK y prueba nativa;
este README conserva los contratos técnicos y descripciones históricas de cobertura.

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
startup owns a bounded flight; JSON, creation, PNG, rectangle, position, dimensions
and opacity share one owned flight. Empty and valid saved-only slots show an
explicitly **unpersisted sample**, without creating a draft. Existing drafts reload
verified canonical content and PNGs, then render at their own playback start.
Startup failures block import: no reset, deletion, seed or fallback success.
Accessible independent JSON/PNG/rectangle/position/dimension/opacity controls capture input once;
all seven actions, including blank creation, disable during shared work.
User imports publish through the existing workflow, hydrate locally stored PNG
references and render the current publication at its playback start. A startup-known
sequence floor permits saved-only imports while retaining saved rows; only JSON
sequencing uses it. Malformed JSON, missing assets and stale competing-tab writes
preserve the previous usable frame/publication. Errors require another explicit
activation, never a retry/reload/rebase. There are no animation controls or autosave.
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
All seven production actions share UI activity and the facade's authoritative
owned lane, excluding forced/same-turn clicks, submits and selection/input events.
Preparation,
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
All seven actions disable selection in their shared lane; named inspector
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
facade in PR2 before production wiring. It captures all five scalars once before callbacks/awaits;
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
JSON, blank, PNG, rectangle, position, dimensions and opacity share seven-action
exclusion, including direct API calls. SDK source/type/pair/sequence guards remain authoritative;
there is no retry, rebase or element-ID allocation. Schema-valid zero/negative
source sizes remain importable; both requested sizes must be finite and positive.
Success returns actual current as borrowed rendering data, never release authority.
Rendering belongs to the caller: a postcommit render failure cannot undo publication.
Disposal returns null current immediately, awaits resolving/rejecting owned work,
then releases publication/cache once; callers must suppress late frame/DOM updates.
The native API fixture proves dimensions independently of the production controller;
the built-entry controls have their own production-preview proof below.

## Standalone dimensions controls (issue #116, chain PR3)

`mountEditorDimensionControls` accepts caller-supplied form, width/height inputs,
button, named **Dimension status**, shared activity, `getSelection`/`getCurrent`,
`setShapeDimensions` and `onPublished`. It creates no production markup or renderer.
Only matching published shape metadata enables editing; root/nested values are
original authored dimensions, including schema-valid zero/negative initial sizes.
Both new values must be nonempty, finite and positive; fractions and equal pairs
are valid. Each raw input and the frozen five-scalar intent are captured before
activity callbacks. Ready/own/shared busy gates honor the shared seven-action lane.
New document/revision identity clears selection through the inspector and requires
explicit reselection; same-source rejection preserves typed values and selection.
Own success or committed-but-render-failed feedback survives shared settlement;
external changed-source settlement refreshes guidance from actual current.
Dispose controls before the inspector: listener removal and late-output suppression
are idempotent, without cancellation or resource release. The browser remains owner.
`editor-dimension-controls.test.tsx` supplies standalone DOM contract proof;
PR4 mounts this existing controller in the production entry as described below.

## Edit selected shape dimensions (issue #116, chain PR4)

Choose a published shape, edit **Dimension width** and **Dimension height**, then
**Apply dimensions**. Prefill is genuine authored/local metadata, including initial
schema-valid zero/negative sizes, not animated geometry, DOM option text or unsent
JSON. Both requested values must be trimmed-nonempty, finite and strictly positive;
fractions and equal pairs are valid. Groups and all other variants remain read-only.
The controller captures the frozen document/revision/element token and both values
before shared activity; SDK guards and native CAS retain source authority.
Root/nested shapes keep stable IDs and every field except width/height, including
coordinates, opacity, transforms, hierarchy/order, tracks, scene configuration and
PNG references. Assets and saved history remain intact; equal pairs still advance
the durable revision/sequence/pointer. Any new source requires explicit reselection;
same-source rejection keeps selection and typed input, with no silent retarget/retry.
All seven actions exclude forced submits/clicks/selection/input changes during owned work.
All three edit controllers preserve their own success, rejection and committed-render warning
across shared settlement; external publication refreshes guidance from actual current.
Named **Dimension status** leaves the sole unnamed primary canvas status distinct.
Startup sample/saved-only/pending/failure states cannot enable dimensions or seed a
draft. Pagehide disposes all three edit controllers before inspector null notification;
late DOM/frame updates stop while the existing owner awaits work and releases PNGs.
`browser/set-shape-dimensions.spec.ts` supplies 17 production-preview cases for full
native history, independent canonical bytes/pixels/SHA, six holds, competing winners,
cross-position edits, truthful render warnings and both pagehide settlements.
The inspector spec extends disabled startup assertions and adds missing-asset and
restored-render failure cases. These are test coverage, not an execution receipt.

## Shape opacity SDK (issue #122, chain PR2)

`EditorSession.setShapeOpacity(request): Promise<void>` accepts readonly
`ShapeOpacityRequest` fields: documentId, revisionId, elementId and opacity.
It reads each scalar once into a frozen intent before callbacks/awaits. A live
matching source, root/nested shape and safe source.sequence+1 are required before
IDs/time or digest/decode/cache/persistence effects. New opacity must be a finite
number in [0, 1], including 0/-0, fractions and 1; schema-valid wider source values
remain importable. This edits authored base opacity only, not tracks or their overrides.
A fresh human-UI bridge dispatches `set-shape-opacity` at command revision 0,
with captured command/revision IDs and timestamp and no element-ID allocation.
Selected expectedSource, the queued source guard and existing native pointer CAS
reject stale/released sources and competitors without retry, rebase or retargeting.
Equal values still create a new durable revision/sequence/pointer, preserving all
unrelated fields, saved history and PNG asset metadata/bytes. PNG prehydration keeps
useful retained handles and closes duplicates once; release/cache ownership is unchanged.
Bounded `EDITOR_SHAPE_OPACITY_*` failures preserve the appropriate prior or durable winner.
SDK coverage uses the real workspace and fake-indexeddb adapter; the browser facade
and native API coverage follow below; the standalone controller is mounted in production as described below.

## Browser opacity API (issue #122, chain PR3)

`createBrowserEditorSession().setShapeOpacity(request)` mirrors the readonly SDK
request. Disposed/not-ready/busy/no-current guards reject before caller getters;
null, nonobject, array or throwing-getter requests fail with bounded input errors.
Exactly four scalars are read once and frozen before the owned SDK callback.
JSON, blank, PNG, rectangle, position, dimensions and opacity exclude each other
through the actual shared flight, including direct calls and SDK callback reentry.
SDK source/shape/range/sequence checks and fresh human-UI expectedSource/CAS remain
unchanged: no retarget, retry, rebase or element-ID allocation.
New requests accept finite [0, 1], including 0/-0, fractions and 1. Existing authored
values such as -0.25/2 remain importable without migration or clamping. Equal values
publish an ordinary revision/sequence/pointer. Only authored opacity changes;
preserved tracks can override it, so success need not change every evaluated pixel.
Saved history and referenced PNG assets remain intact, even at shape opacity zero.
Returned actual current is borrowed: no release/cache authority, renderer or DOM.
The existing owner awaits resolving/rejecting work before cleanup; callers suppress
late frame/status updates. A committed external render failure cannot undo publication.
`browser-editor-session.test.ts` covers capture, seven-origin guards and settlement;
`browser/set-shape-opacity-api.spec.ts` covers native rows, independent canonical
bytes/SHA, root/nested alpha, PNG usefulness, tracks, reload, genuine CAS winners
and per-bitmap cleanup. These are coverage descriptions, not execution receipts.
Production opacity wiring and its separate built-entry native coverage are described below.

## Standalone opacity controls (issue #122, chain PR4)

`mountEditorOpacityControls` accepts a form, **Shape opacity** input, **Apply opacity**
button, named **Opacity status**, activity, source/selection providers, SDK action
and publication callback. Ready, matching published root/nested shape metadata enables
editing; five other variants stay inspectable/read-only. Prefill is authored truth,
including finite-wide -0.25/2, never tracks, option text or unsent JSON. Only new requests
require trimmed-nonempty finite [0, 1], including 0/-0, fractions, 1 and equal values;
there is no clamp or migration. Preserved tracks may override authored opacity at playback.
Raw input is read once; four frozen source/value scalars and local reentry exclusion
precede activity callbacks. Shared activity and authoritative SDK guards support all
seven origins, including forced events. Own BEGIN/END preserves success, rejection and
committed-render warnings; external position/dimension settlement refreshes actual-source
guidance. Changed document/revision requires reselection even with equal values/stable IDs;
same-source rejection preserves selection and typed input. Dispose before inspector null
notification: listener removal is idempotent and late output is suppressed, without
rendering, cancellation or bitmap/cache/database ownership. `editor-opacity-controls.test.tsx`
describes standalone DOM, fault and settlement coverage, not a production UI execution receipt.

## Edit selected shape opacity (issue #122, chain PR5)

Select a genuinely published root/nested shape, edit **Shape opacity**, then
**Apply opacity**. Prefill comes from matching document/revision/element metadata,
including authored -0.25/2, not evaluated tracks, option text or unsent JSON.
Only new requests require trimmed-nonempty finite [0, 1]; 0/-0, fractions, 1 and
equal values are valid. No clamp or migration is added. Only authored opacity
changes: IDs, position/dimensions, transforms, hierarchy, tracks, configuration,
saved history and PNG metadata/bytes remain intact. Tracks may override the base
value at the document's playback start, so success does not promise changed pixels.

The entry mounts the existing `mountEditorOpacityControls` with the inspector's
selection, actual-current metadata and narrow browser action. All seven origins
share frontend activity and the authoritative owned backend lane. All three edit
controllers retain their own success/rejection/committed-render warning across
BEGIN/END; both other controllers follow changed-source guidance. Every new source,
including stable IDs/equal values, requires reselection; same-source rejection
retains typed input. Named **Opacity status** leaves the sole unnamed canvas status
unchanged. A committed rendering failure is not rollback, retry or retargeting.
Startup sample/saved-only/pending/corrupt/missing-asset/context/render failures keep
opacity disabled without seeding/promoting a draft. Pagehide disposes all three
edit controllers before inspector null notification, then the existing browser
owner awaits resolving/rejecting work and closes each owned bitmap once.

`browser/set-shape-opacity.spec.ts` adds 24 production-preview cases using actual
JSON/PNG UI, native rows, independent canonical/history/assets/SHA and canvas alpha,
including zero-opacity PNG retention, track overrides, cold reload, seven forced
holds, genuine CAS winners, three-controller feedback and both pagehide outcomes.
The inspector spec extends existing startup-disabled checks without removing old
assertions. These describe coverage, not passing execution or native approval.
Issue #122 remains open; final authorized integration/review is separate.

## Shape fill color SDK (issue #141)

`EditorSession.setShapeFillColor(request): Promise<void>` acepta los cuatro campos
readonly de `ShapeFillColorRequest`: documentId, revisionId, elementId y fillColor.
Lee cada escalar una vez en una intención congelada antes de callbacks/awaits.
`createBrowserEditorSession().setShapeFillColor(request)` replica la misma petición.
Exige un color RGB de seis dígitos `#RRGGBB` (ambas cajas, sin recorte ni alfa) y
reutiliza la publicación durable condicional y la política de actor existentes.
La API existe en sesión y navegador; el control de Inspector y la recarga fría
nativa se describen en la sección de producción siguiente.

## Shape fill color en el Inspector

La entrada monta `mountEditorFillColorControls` con el formulario **Shape fill color**,
la entrada de texto `#shape-fill-color-value`, el botón **Apply fill color** y el
estado **Fill color status**. Solo una shape publicada seleccionada habilita el
control; otros elementos permanecen de solo lectura y la ausencia de color deja la
entrada vacía con guía de negro por defecto. La captura usa metadatos reales de
documento/revisión/elemento, no JSON sin enviar ni texto de opción. El color exige
`#RRGGBB` estricto (sin alfa, recorte ni plegado) y conserva la caja autorada sin
insertar propiedades ni normalizar. La publicación reutiliza el CAS durable y la
actividad compartida; todo cambio de fuente exige reselección. Los casos de
preview nativo (raíz/anidada, PNG, IndexedDB real, recarga fría) viven en
`browser/set-shape-opacity.spec.ts`; describen cobertura, no ejecución ni
aprobación nativa. No se añade capacidad de agente ni matriz SDK nativa aparte.

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
