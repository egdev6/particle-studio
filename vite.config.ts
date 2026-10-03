import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./apps/editor", import.meta.url)),
  build: { outDir: "dist" },
  // Prebundle the generated validator's CommonJS helper for dev ESM serving.
  optimizeDeps: { include: ["@particle-studio/scene-document"] },
  server: { host: "127.0.0.1", port: 4173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4176, strictPort: true },
});
