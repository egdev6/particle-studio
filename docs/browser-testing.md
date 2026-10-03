# Static example viewer and browser tests

Run from the repository root with Node 24.20.x, npm 12.0.2, workspace
dependencies installed, and Playwright's Chromium available. For a fresh browser
cache, provision it separately with `npx playwright install chromium`; on Linux
CI, `npx playwright install --with-deps chromium` also installs system libraries.

## Run the static viewer

```sh
npm run dev       # http://127.0.0.1:4173
npm run build     # apps/editor/dist
npm run preview   # http://127.0.0.1:4176 (build first)
```

Both servers bind to loopback with strict ports. The production entry is a
non-React **Static example viewer**, not a full editor: it evaluates
`FIRST_SLICE_DOCUMENT` at playback start (0 µs) through the runtime and Canvas2D
renderer on a 256×160 canvas. It shows loading, rendered, or error status. There
is no editing, animation, persistence, import UI, or browser session wiring.
Vite builds the entry but does not typecheck it; use the separate check below.

## Verify browser behavior

```sh
npm run test:browser
npx vitest run --project core apps/editor/tests/browser-png-platform.test.ts
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
  rejection. The fixture closes its bitmaps; successful platform handles remain
  caller-owned. This harness is not the production entry.
- `chromium-preview`: runs `npm run build && npm run preview` on
  `127.0.0.1:4176`. It checks the built viewer's status and actual pixels: black
  inside the sample shape at 25% alpha, transparent outside. A context-unavailable
  case must show a visible error rather than rendered success. Both cases check
  for uncaught page errors.
