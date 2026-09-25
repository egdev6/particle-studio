import { rolldown } from "rolldown";

import type {
  PortableRuntimeGraph,
  PortableRuntimeGraphProvider,
} from "../src/index.js";

async function hash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function module(path: string, source: string) {
  const bytes = new TextEncoder().encode(source);
  return { path, bytes, sha256: await hash(bytes) };
}

/** Test-only exact Rolldown authority for the shared runtime and Canvas2D renderer. */
export async function buildGenuineCanvasRuntimeProvider(): Promise<PortableRuntimeGraphProvider> {
  const bridgeId = "virtual:particle-studio-web-component-bridge";
  const build = async (): Promise<PortableRuntimeGraph> => {
    const bundle = await rolldown({
      input: { entry: bridgeId },
      external: [],
      treeshake: false,
      plugins: [
        {
          name: "particle-studio-web-component-bridge",
          resolveId(source) {
            return source === bridgeId ? bridgeId : null;
          },
          load(identifier) {
            return identifier === bridgeId
              ? "export { evaluateScene } from '@particle-studio/runtime';\nexport { renderCommands } from '@particle-studio/renderer-canvas2d';\n"
              : null;
          },
        },
      ],
    });
    try {
      const generated = await bundle.generate({
        format: "es",
        preserveModules: true,
        entryFileNames: "entry.js",
        chunkFileNames: "chunks/[name]-[hash].js",
        sourcemap: false,
      });
      const files = await Promise.all(
        generated.output.map(async (output) => {
          if (output.type !== "chunk" || !output.fileName.endsWith(".js")) {
            throw new Error("unexpected Rolldown output");
          }
          return module(`runtime/${output.fileName}`, output.code);
        }),
      );
      return {
        entryPath: "runtime/entry.js",
        files: files.sort((left, right) => left.path.localeCompare(right.path)),
      };
    } finally {
      await bundle.close();
    }
  };
  const [first, second] = await Promise.all([build(), build()]);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error("unstable genuine runtime graph");
  }
  let calls = 0;
  return { provide: async () => (calls++ === 0 ? first : second) };
}
