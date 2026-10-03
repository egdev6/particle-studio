# Read-only scene viewer and browser tests

Run from the repository root with Node 24.20.x, npm 12.0.2, workspace
dependencies installed, and Playwright's Chromium available. For a fresh browser
cache, provision it separately with `npx playwright install chromium`; on Linux
CI, `npx playwright install --with-deps chromium` also installs system libraries.

## Run the read-only viewer

```sh
npm run dev       # http://127.0.0.1:4173
npm run build     # apps/editor/dist
npm run preview   # http://127.0.0.1:4176 (build first)
```

Both servers bind to loopback with strict ports. The production entry is a
non-React **Read-only scene viewer**, not a full editor. The fixed IndexedDB slot
is database `particle-studio-browser-viewer`, document `browser-document`.
An existing draft reloads through the actual editor session, canonical verification
and PNG hydration pipeline, rendering at its own playback start on a 256×160
canvas. Empty or valid saved-only state shows `FIRST_SLICE_DOCUMENT` at 0 µs,
clearly labeled unpersisted, without fabricating a draft. Failures show a visible
error, preserve stored rows and never reset or fall back to sample success.
Schema initialization is permitted; durable content/pointer/asset writes are not.
There is no editing, animation, seeding or import UI. `pagehide` suppresses late
output and releases publication/cache only after owned startup work settles;
it neither cancels queued reload nor closes/deletes the production database.
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
  Core tests focus on delayed disposal, not a duplicate IDB matrix.
