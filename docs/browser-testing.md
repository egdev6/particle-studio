# JSON scene editor and browser tests

Run from the repository root with Node 24.20.x, npm 12.0.2, workspace
dependencies installed, and Playwright's Chromium available. For a fresh browser
cache, provision it separately with `npx playwright install chromium`; on Linux
CI, `npx playwright install --with-deps chromium` also installs system libraries.

Para el flujo de QA reproducible, el aislamiento de contexto y la plantilla de
evidencia usa el [runbook de QA](qa-agent-runbook.md); este documento conserva el
detalle técnico e histórico de specs. Los conteos citados más abajo son
**descripciones históricas de cobertura**, incluidos los antiguos seis holds de
dimensiones y los siete holds distintos de opacidad, no recibos de ejecución;
no hay benchmark ni proyecto de performance en el árbol.

## Run the JSON editor

```sh
npm run dev       # http://127.0.0.1:4173
npm run build     # apps/editor/dist
npm run preview   # http://127.0.0.1:4176 (build first)
```

Both servers bind to loopback with strict ports. The production entry is a
non-React **JSON scene editor**, with independent JSON and PNG import controls. The fixed IndexedDB slot
is database `particle-studio-browser-viewer`, document `browser-document`.
An existing draft reloads through the actual editor session, canonical verification
and PNG hydration pipeline, rendering at its own playback start on a 256×160
canvas. Empty or valid saved-only state shows `FIRST_SLICE_DOCUMENT` at 0 µs,
clearly labeled unpersisted, without fabricating a draft. Failures show a visible
error, preserve stored rows and never reset or fall back to sample success.
Startup permits schema initialization but never writes durable content records.
After successful startup, submit **Editable JSON** to publish a durable draft;
referenced PNG assets must already exist locally. Controls disable during import,
with visible success or actionable failure. Saved-only imports advance above the
startup-known saved sequence without discarding it. Failures preserve the prior
frame/publication; stale competing-tab attempts never retry or rebase.
**Create blank scene** publishes a genuine draft without JSON/File input after
healthy empty/saved-only startup. One empty structural group renders a blank frame;
refresh retains its revision/pointer identity. Existing current, corrupt startup,
missing context and disposed state block creation; this is not a reset action.
Creation reuses the JSON sequence floor and flight, preserving saved-only 41→42.
To insert a PNG, create a blank scene, import JSON or restore a current draft,
then select **PNG file** and placement in scene units. Visible
x/y/width/height defaults are 0/0/64/64 with opacity 1; positions must be finite,
sizes positive/finite. File and rectangle are captured before preparation. Both
imports and creation disable in the shared pending lane, including same-turn submissions;
PNG needs no textarea JSON and JSON needs no File. Empty/saved-only state blocks
PNG with **Create a scene or import JSON**, never silently creating a draft from the sample.
PNG verification/decode/stale-source errors preserve documents/pointers/current
and frame, but may leave immutable asset bytes already written. No universal
all-stores rollback, cleanup or garbage collection is promised.
**Add rectangle** needs a genuine current, with editable root scene coordinates
x/y/width/height defaulting to 16/24/120/80 and fixed opacity 1. Positions must be
finite and sizes positive/finite; empty inputs fail visibly. No JSON or File is
needed after explicit creation. JSON, creation, PNG, rectangle, position, dimensions
and opacity share one owned action lane and UI activity. Rectangle dispatch is human-UI `create-element` through
a fresh durable bridge, command revision 0 and captured source.sequence+1, with
`expectedSource` and fresh native CAS. It never reloads/retries/rebases automatically.
Fields, groups, tracks, playback and image references remain intact. No asset bytes
are written; canonical PNG reread/redecode may close new duplicates once while
retained handles stay alive until owner settlement. Named rectangle feedback does
not replace the primary unnamed status on failure.
There are no animation controls, autosave or seeding. `pagehide` suppresses late
output and releases publication/cache only after owned startup/import work settles;
it neither cancels queued publication nor closes/deletes the production database.
Vite builds the entry but does not typecheck it; use the separate check below.

## Inspect a published element

Choose **Scene element** after creating/importing/restoring a genuine draft.
**Published element JSON** shows exact authored fields for every element variant,
including structural groups and image asset metadata, never resource handles,
evaluated track values or unsent Editable JSON. There is no automatic selection. Document/revision identity changes and page refresh clear selection;
rejected same-source actions retain it. Empty/saved-only, pending startup, corrupt,
missing-context and disposed states disable inspection. Shared pending actions
identify retained detail's source; settlement refreshes actual current even when
publication committed but rendering failed. Inspection itself performs no resource,
persistence, runtime or canvas work; existing owners still handle bitmap cleanup.

## Edit a selected shape position

Select a shape, edit **Position X/Y**, then **Apply position**. Coordinates are
atomic authored/local values, including under group transforms; blank/nonfinite
fields fail, negative/fractional values are valid. Nonshape variants stay inspectable
but cannot apply. The source-bound human command preserves stable ID and all other
fields; stale selection or competing-tab publication never triggers a rebase.
Equal coordinates publish an ordinary new revision/sequence/pointer and clear
selection. Explicitly reselect after success; same-source rejection retains input.
Named **Position status** reports committed-but-render-failed warnings truthfully,
while inspection refreshes from actual current. All seven actions share the lane.
All three edit controllers dispose before inspection; existing owners await settlement.

## Edit selected shape dimensions and verify production UI

Select a published shape, edit **Dimension width/height**, then **Apply dimensions**.
Prefill includes genuine authored zero/negative sizes; both new values must be
nonempty, finite and positive. Root/nested edits preserve stable IDs and all unrelated
fields/assets/history. Equal pairs publish normally and clear selection; explicitly
reselect after any new source. Same-source rejection retains typed input. Named
**Dimension status** distinguishes rejection from committed rendering failure.

Run `npx playwright test --project chromium-preview set-shape-dimensions.spec.ts`.
The registered production spec uses the real built entry at `127.0.0.1:4176`, not
an API fixture. Its 17 cases cover full native rows/history/pointers/assets, browser
SHA/PNG, recursively key-sorted canonical JSON with array order preserved, independent
root/nested pixel bounds, fractions/equal pairs and cold reload. Six real owned holds
force other clicks/submits/selection/input changes; genuine readonly pointer-result
barriers never override conditional readwrite CAS. UUID spies capture actual candidates
for competing winners before/during preparation. Individual native bitmaps remain
drawable or close once, including legitimate prehydration duplicates. Cross-position
edits and both controllers' own result/render-warning statuses exercise shared END.
Both pagehide outcomes freeze fields/status/DOM/pixels before settlement-aware cleanup.
`element-inspector.spec.ts` adds dimension-disabled startup assertions, missing-asset
and restored-render failure cases, retaining earlier startup checks and assertions.
Coverage descriptions are not test-run receipts; run focused and full checks below.

## Browser dimensions API proof (separate fixture)

`set-shape-dimensions-api.spec.ts` runs in the `chromium` fixture project at
`http://127.0.0.1:4175/apps/editor/tests/browser/fixtures/browser-dimensions-api.fixture.html`.
Run `npx playwright test --project chromium set-shape-dimensions-api.spec.ts` for
focused proof, or `npm run test:browser` for both projects; Playwright still starts
both configured servers. Core facade tests use the existing core command below.
The test-only harness uses the real facade, native IndexedDB, browser SHA/PNG and
canvas. Recursive key-sorted JSON preserves array order as an independent oracle.
Root/nested and equal publications check complete rows/history/pointers/assets/IDs;
source/pair/sequence guards, reused IDs, six-action holds and actual competing-tab
winners preserve authoritative CAS. Holds delay genuine readonly pointer results,
never conditional readwrite requests. Saved-pointer mutations require public reload.
Per-handle drawable usefulness and close counts cover resolving/rejecting disposal;
fixture rendering suppresses late DOM/frame/notifications and distinguishes committed
publication from rendering failure. This API fixture adds no production renderer hooks.
Local browser selection includes this spec; CI's develop/main branch filters remain
unchanged and do not authorize child-branch routing changes.

## Browser opacity API proof (issue #122, chain PR3)

`set-shape-opacity-api.spec.ts` is registered in the existing `chromium` playground
at `http://127.0.0.1:4175/apps/editor/tests/browser/fixtures/browser-opacity-api.fixture.html`.
Run `npx playwright test --project=chromium set-shape-opacity-api.spec.ts` for focused
coverage; the configured servers and branch routing are unchanged. The separate
HTML/TS harness uses the real facade/session, native IndexedDB, SHA/PNG and canvas,
not the production opacity controls, which have separate built-entry coverage below.
Healthy JSON/PNG publication, sequence/current metadata and useful pixels precede
the API assertion. Root/nested untracked black shapes check authored 0/fraction/1
alpha and equal publication; separately tracked scenes check evaluated override
truth while preserving authored edits and schema-valid initial -0.25/2 values.
Independent recursive key-sorted canonical JSON retains array order. Comparisons
cover full native revision documents/bytes/identifier/length, all history/pointers,
saved revisions and asset metadata/bytes with independent SHA. Zero shape opacity
retains useful PNG pixels/handles. Out-of-band saved-pointer setup explicitly uses
public reload before prior-source comparisons; cold public reload checks persistence.
Seven genuine origin holds exclude all seven direct owned calls through I/O settlement.
Barriers delay only readonly pointer results, leaving conditional readwrite CAS
intact. Before/during-preparation competing durable winners survive; actual eager
candidate UUIDs are observed, stale candidate rows stay absent, with no retry,
retarget, rebase or implicit reload. External `renderEditorFrame` failure after commit
reports the durable winner truthfully; rerender uses the same actual current without
rollback. Resolving and rejecting disposal await held work, suppress late frame/DOM/
notifications and close each owned bitmap identity once, including prior duplicates.
The facade grants borrowed current no release/cache authority and owns no renderer.
These descriptions specify coverage, not a passing-run or native approval receipt.

## Edit selected shape opacity and verify production UI (issue #122, chain PR5)

Choose a published root/nested shape, edit **Shape opacity**, then **Apply opacity**.
Matching authored metadata prefills even schema-valid -0.25/2; new requests alone
require trimmed-nonempty finite [0, 1], accepting 0/-0, fractions, 1 and equal values.
There is no clamping, migration or track deletion. Tracks can override authored
opacity at playback start; successful publication need not change rendered pixels.
Nonshapes stay inspectable/read-only. New document/revision identity clears selection,
even for stable IDs/equal edits; explicitly reselect. Same-source rejection retains
selection and typed input. Named **Opacity status** preserves the primary unnamed
canvas status. All seven actual actions exclude forced/same-turn buttons, forms,
selection and input events through both shared activity and the backend owned lane.
All three controllers preserve their own results/render warnings through BEGIN/END;
both other edit controllers refresh guidance from actual current after source changes.
Committed render failure never claims rollback, retry, rebase or retargeting.

Run `npx playwright test apps/editor/tests/browser/set-shape-opacity.spec.ts --project=chromium-preview`.
Its 24 cases use the real built preview at `127.0.0.1:4176`, actual JSON/PNG UI and
native IndexedDB, not the opacity API harness. Healthy root/nested canonical source,
useful PNG and primary-frame pixels precede the opacity affordance assertions.
Independent recursive key sorting retains array order and compares full revision
content/bytes/identifier/length, all historic/saved rows, pointers and asset metadata/
bytes with independent SHA. Untracked black shapes check 0/-0/fraction/1/equal alpha
and cold public reload, including zero and fractional publications; useful PNG
pixels and retained per-identity handles survive transparent shape edits.
Separate finite-wide authored sources preserve tracks: independently evaluated
linear opacity at production playback start 500,000 µs is 0.5/alpha128, not time-zero
0.25/alpha64. Saved-pointer fixture setup publicly reloads before prior-source checks.
Seven genuine native holds challenge forced and same-task actions; only readonly
pointer results are delayed, never conditional readwrite CAS. Actual eager candidate
UUIDs precede preparation settlement; before/during external winners retain complete
durable rows with stale candidates absent and no implicit retry/reload.
Three-controller rejection/success/cross-edit/render-warning cases follow genuine
source identity. Pending JSON-import/opacity pagehide covers both resolve and reject:
all three controllers dispose before Inspector's null notification, late DOM/status/
frame stays frozen, and each native bitmap closes once, including hydration duplicates.
Existing inspector startup cases add opacity-disabled checks for sample/saved-only,
pending/corrupt/missing-assets/context/restored-render failures without seeding/promoting.
These are coverage descriptions, not GREEN, native approval or remote CI receipts.
Existing servers, both-project registration and develop/main CI filters are unchanged;
issue #122 closure and final authorized integration/review remain separate.

## Verify browser behavior

```sh
npm run test:browser
npx vitest run --project core apps/editor/tests/browser-png-platform.test.ts apps/editor/tests/browser-editor-session.test.ts
npm run validator:prepare
npx vitest run --project ui apps/editor/tests/editor-element-inspector.test.tsx apps/editor/tests/editor-position-controls.test.tsx apps/editor/tests/editor-dimension-controls.test.tsx apps/editor/tests/editor-opacity-controls.test.tsx
npx tsc -p apps/editor/tsconfig.json --noEmit --pretty false
```

The dev, build, preview, and browser scripts prepare the generated validator.
Core regression tests can clean that output; prepare it again before typechecking
or importing runtime.

`test:browser` runs both Chromium projects with Playwright-managed servers and
never reuses existing servers:

- `chromium`: the separate test-only Vite fixture on `127.0.0.1:4175` checks Web
  Crypto, the pinned valid PNG, real ImageBitmap metadata, and corrupt-byte
  rejection, plus real image-frame pixels and rejected/replacement frame ordering.
  The fixture closes its bitmaps; successful platform handles remain
  caller-owned. This harness is not the production entry.
- `chromium-preview`: runs `npm run build && npm run preview` on
  `127.0.0.1:4176`. Native-IDB tests snapshot all actual durable rows before/after
  empty, valid saved-only, canonical shape/PNG draft at nonzero playback start,
  dangling/corrupt pointers/content, missing/hash-failed assets, genuine PNG decode
  failure (invalid PNG bytes with their valid stored hash), and native pointer/asset
  read faults. Independently expected shape/image pixels prove hydration and time.
  Read faults patch browser IDB APIs, not production globals. The shared
  `tests/raw-indexeddb-seed.ts` helper reconstructs typed fields in its self-contained
  evaluate closure; plain JCS fixture rows avoid Node importing the generated
  validator's CommonJS helper. The real production reload validates their format.
  Sample pixels, context-unavailable errors and absence of uncaught page errors
  remain covered. Delaying actual ImageBitmap decode across repeated `pagehide`
  proves no late frame/status and exactly one handle close after settlement.
  `durable-import.spec.ts` also proves first/replacement user imports, nonzero-time
  genuine PNG rendering, revision/pointer identity and refresh restoration, saved-only
  sequence 41→42 with saved retention, malformed/missing-asset preservation,
  competing-tab winners before/during preparation and import disposal on resolution
  or rejection. `static-viewer.spec.ts` retains the complete startup regression matrix.
  `png-import.spec.ts` uses real `setInputFiles` after user JSON: captured placement,
  independent metadata/IDs/pixels and durable refresh, no-current prerequisites,
  MIME/content/File-read/decode/asset-reread/placement failures with exact asset
  effects, stale winners before/during preparation, and delayed PNG pagehide on
  resolution/rejection. Fault injection patches browser APIs only, not a product
  seed/global/fixture entry. Explicit blank creation also proves canonical content,
  all-canvas blank alpha, saved retention, refresh identity and real PNG insertion.
  Native pointer-read gates cover winners before/during preparation, failures and
  pagehide resolution/rejection without image decoding. Existing cases remain selected.
  `rectangle-create.spec.ts` proves actual blank/PNG-current shape publication,
  independently expected geometry/canonical rows/pixels, unchanged asset rows and
  same-identity refresh. Native readonly result barriers leave readwrite CAS fresh:
  winners before/during preparation survive without rebase. Geometry/preparation/
  image faults and absent/saved-only/corrupt/context gates remain non-destructive.
  Pagehide resolution/rejection freezes DOM/frame/aria-busy while owned work settles,
  then closes each retained/duplicate bitmap exactly once. It is selected alongside
  every existing preview spec; CI also explicitly selects the new rectangle UI test.
  Core tests focus on owned workflow settlement; distinct jsdom controls tests check
  readiness, input capture, single flight and listener removal without React.
  `element-inspector.spec.ts` adds genuine blank/rectangle/nested variants/PNG
  publication checks with independently expected canonical JSON and full native
  row/cardinality, pixel and per-bitmap comparisons. Inspection-only instrumentation
  requires zero I/O, lookup, decode/close, evaluation or painting; legitimate
  publication prehydration is outside that window. Real readonly pointer-result
  barriers leave readwrite CAS unchanged while covering pending actions, rejection,
  post-CAS before-clear rendering failure, both pagehide outcomes and startup gates.
  CI explicitly selects the inspector UI test and preview spec without dropping
  any previous selection.
  `set-shape-position.spec.ts` adds visible root/transformed nested edits with
  independent pixels, complete canonical/native history and cold-reload checks.
  Real PNG rows and individual bitmap identities remain covered through replacement;
  readonly pointer barriers exercise native CAS winners without altering readwrite
  requests. Five-action programmatic exclusion, equal publication/selection reset,
  retained rejected input, committed render warnings and both pagehide outcomes
  use the built entry. Existing inspector startup gates also require position
  controls to remain disabled. CI selects the position UI test and native spec
  without removing any previous core/UI/browser selections.
