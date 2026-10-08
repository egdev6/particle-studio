import { defineConfig } from "vite";

const repositoryRoot = new URL(".", import.meta.url).pathname;

export default defineConfig({
  root: new URL("./apps/editor/e2e/browser-agent-fixture", import.meta.url)
    .pathname,
  optimizeDeps: {
    include: ["@particle-studio/scene-document"],
  },
  server: {
    host: "127.0.0.1",
    port: 4274,
    strictPort: true,
    fs: { allow: [repositoryRoot] },
  },
});
