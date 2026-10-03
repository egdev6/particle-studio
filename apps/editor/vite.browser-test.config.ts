import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Test-only server: no production entrypoint, aliases, or editor session wiring.
export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  server: { host: "127.0.0.1", port: 4175, strictPort: true },
});
