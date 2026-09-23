import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const editorPrecompiledRuntimeSource =
  "globalThis.ParticleStudio = Object.freeze({ mount() { return Object.freeze({ ready: Promise.resolve(), renderAt() {}, destroy() {} }); } });\n";

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        test: {
          name: "core",
          // Validator-generation mutates a shared module required by runtime bundling.
          fileParallelism: false,
          environment: "node",
          include: [
            "packages/scene-document/tests/**/*.test.ts",
            "packages/commands/tests/**/*.test.ts",
            "packages/webmcp-adapter/tests/**/*.test.ts",
            "packages/persistence/tests/**/*.test.ts",
            "packages/persistence-indexeddb/tests/**/*.test.ts",
            "packages/persistence-fs/tests/**/*.test.ts",
            "apps/headless-mcp/tests/**/*.test.ts",
            "packages/runtime/tests/**/*.test.ts",
            "packages/export/tests/**/*.test.ts",
            "apps/editor/tests/**/*.test.ts",
          ],
        },
      },
      {
        define: {
          __PARTICLE_STUDIO_SELF_CONTAINED_RUNTIME_SOURCE__: JSON.stringify(
            editorPrecompiledRuntimeSource,
          ),
        },
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["apps/editor/tests/**/*.test.tsx"],
          setupFiles: ["apps/editor/test-setup.ts"],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: [
            "packages/renderer-canvas2d/tests/**/*.test.ts",
            "apps/headless-mcp/tests-integration/**/*.test.ts",
          ],
        },
      },
    ],
  },
});
