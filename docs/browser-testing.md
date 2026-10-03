# Browser PNG platform tests

Run from the repository root with the pinned Node/npm versions and workspace
dependencies installed:

```sh
npx vitest run --project core apps/editor/tests/browser-png-platform.test.ts
npx playwright install chromium
npm run test:browser
npx tsc -p apps/editor/tsconfig.json --noEmit --pretty false
```

On Linux CI, `npx playwright install --with-deps chromium` also installs the
required system libraries. The browser script prepares the generated validator.
If a core regression run cleans that output, run `npm run validator:prepare`
before editor typechecking.

The test-only Vite server binds to `127.0.0.1:4175` with a strict port;
Playwright never reuses an existing server. The single Chromium spec observes
fixture DOM output, exercising Web Crypto, a pinned valid PNG, real ImageBitmap
metadata, and corrupt-byte rejection at the existing verified decode boundary.
The fixture closes its own bitmaps; the platform leaves successful handles open
for their caller to own.

This is a browser platform harness, not a production editor entrypoint. It does
not wire an App, canvas renderer, browser session, or deployment. Production
composition and bitmap/cache lifetime policy remain separate future work.
