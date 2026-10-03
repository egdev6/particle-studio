import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/editor/tests/browser",
  testMatch: "browser-platform.spec.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  use: { baseURL: "http://127.0.0.1:4175", headless: true },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "npx vite --config apps/editor/vite.browser-test.config.ts",
    url: "http://127.0.0.1:4175/apps/editor/tests/browser/fixtures/browser-png-platform.html",
    timeout: 30_000,
    reuseExistingServer: false,
  },
});
