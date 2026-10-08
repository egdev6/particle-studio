import { fileURLToPath } from "node:url";

import { rolldown } from "rolldown";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { selfContainedRuntimeEntrySource } from "./packages/export/src/self-contained-runtime-entry.ts";

// Multi-page build: the frozen performance harness is a second standalone
// entry emitted next to index.html by the same production build.
const editorRoot = fileURLToPath(new URL("./apps/editor", import.meta.url));

const SELF_CONTAINED_RUNTIME_ENTRY =
  "virtual:particle-studio-self-contained-runtime";

async function buildSelfContainedRuntimeSource(): Promise<string> {
  const bundle = await rolldown({
    input: SELF_CONTAINED_RUNTIME_ENTRY,
    external: [],
    treeshake: true,
    plugins: [
      {
        name: "particle-studio-self-contained-runtime-entry",
        resolveId(source) {
          return source === SELF_CONTAINED_RUNTIME_ENTRY ? source : null;
        },
        load(identifier) {
          return identifier === SELF_CONTAINED_RUNTIME_ENTRY
            ? selfContainedRuntimeEntrySource()
            : null;
        },
      },
    ],
  });
  try {
    const generated = await bundle.generate({
      format: "iife",
      sourcemap: false,
    });
    if (
      generated.output.length !== 1 ||
      generated.output[0]?.type !== "chunk"
    ) {
      throw new Error("SELF_CONTAINED_RUNTIME_BUILD_INVALID");
    }
    return generated.output[0].code;
  } finally {
    await bundle.close();
  }
}

const selfContainedRuntimeSource = await buildSelfContainedRuntimeSource();

export default defineConfig({
  base: "/",
  build: {
    rollupOptions: {
      input: {
        index: `${editorRoot}/index.html`,
        performance: `${editorRoot}/performance.html`,
      },
    },
  },
  define: {
    __PARTICLE_STUDIO_SELF_CONTAINED_RUNTIME_SOURCE__: JSON.stringify(
      selfContainedRuntimeSource,
    ),
  },
  plugins: [react()],
  root: "apps/editor",
});
