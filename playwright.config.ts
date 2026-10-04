import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/editor/tests/browser",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  use: { headless: true },
  projects: [
    {
      name: "chromium",
      testMatch: ["browser-platform.spec.ts", "editor-frame.spec.ts", "set-shape-dimensions-api.spec.ts"],
      use: { browserName: "chromium", baseURL: "http://127.0.0.1:4175" },
    },
    {
      name: "chromium-preview",
      testMatch: ["static-viewer.spec.ts", "durable-import.spec.ts", "png-import.spec.ts", "rectangle-create.spec.ts", "element-inspector.spec.ts", "set-shape-position.spec.ts"],
      use: { browserName: "chromium", baseURL: "http://127.0.0.1:4176" },
    },
  ],
  webServer: [
    {
      command: "npx vite --config apps/editor/vite.browser-test.config.ts",
      url: "http://127.0.0.1:4175/apps/editor/tests/browser/fixtures/browser-png-platform.html",
      timeout: 30_000,
      reuseExistingServer: false,
    },
    {
      command: "npm run build && npm run preview",
      url: "http://127.0.0.1:4176",
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
