# JSON scene editor and browser tests

Run from the repository root with Node 24.20.x, npm 12.0.2, workspace
dependencies installed, and Playwright's Chromium available. For a fresh browser
cache, provision it separately with `npx playwright install chromium`; on Linux
CI, `npx playwright install --with-deps chromium` also installs system libraries.

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
needed after explicit creation. JSON, creation, PNG and rectangle share one owned
action lane and UI activity. Rectangle dispatch is human-UI `create-element` through
a fresh durable bridge, command revision 0 and captured source.sequence+1, with
`expectedSource` and fresh native CAS. It never reloads/retries/rebases automatically.
Fields, groups, tracks, playback and image references remain intact. No asset bytes
are written; canonical PNG reread/redecode may close new duplicates once while
retained handles stay alive until owner settlement. Named rectangle feedback does
not replace the primary unnamed status on failure.
There is no animation, autosave or seeding. `pagehide` suppresses late
output and releases publication/cache only after owned startup/import work settles;
it neither cancels queued publication nor closes/deletes the production database.
Vite builds the entry but does not typecheck it; use the separate check below.

## Verify browser behavior

```sh
npm run test:browser
npx vitest run --project core apps/editor/tests/browser-png-platform.test.ts apps/editor/tests/browser-editor-session.test.ts
npm run validator:prepare
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
