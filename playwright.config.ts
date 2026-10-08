import { defineConfig, devices } from "@playwright/test";

declare const process: {
  readonly env: Readonly<Record<string, string | undefined>>;
};

export default defineConfig({
  testDir: "./apps/editor/e2e",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: "sh scripts/start-playwright-preview.sh",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: !process.env.CI,
    },
    {
      command:
        "vite --config vite.browser-agent-fixture.config.ts --host 127.0.0.1 --port 4274",
      url: "http://127.0.0.1:4274",
      reuseExistingServer: false,
    },
  ],
  projects: [
    {
      name: "chromium",
      testIgnore: "**/*.performance.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium-performance",
      testMatch: "**/*.performance.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        // The reference canvas is a fixed 1920x1080 backing store; a smaller
        // default viewport would clip the measurement page.
        viewport: { width: 1920, height: 1080 },
      },
    },
  ],
});
