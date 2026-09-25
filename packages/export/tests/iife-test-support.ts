import { rolldown } from "rolldown";
import { expect } from "vitest";

import type {
  PortableIifeBundle,
  PortableIifeBundleInput,
  PortableIifeBundleProvider,
  PortableSelfContainedRuntimeProvider,
} from "../src/index.js";

async function hash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function resolveVirtualModule(importer: string, specifier: string): string {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    throw new Error("non-virtual dependency");
  }
  const segments = importer.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) throw new Error("virtual path escape");
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

/** Test-only exact Rolldown 1.2.7 authority: it resolves and loads only supplied virtual modules. */
/** Test-only exact Rolldown authority for the fixed generic browser delivery runtime. */
export function genuineSelfContainedRuntimeProvider(
  source: string,
): PortableSelfContainedRuntimeProvider {
  const entry = "virtual:particle-studio-self-contained-runtime";
  const output = (async (): Promise<PortableIifeBundle> => {
    const bundle = await rolldown({
      input: entry,
      external: [],
      treeshake: true,
      plugins: [
        {
          name: "particle-studio-self-contained-runtime-authority",
          resolveId(identifier) {
            return identifier === entry ? entry : null;
          },
          load(identifier) {
            return identifier === entry ? source : null;
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
        throw new Error("expected exactly one classic chunk");
      }
      const bytes = new TextEncoder().encode(generated.output[0].code);
      return {
        path: "particle-studio.iife.js",
        bytes,
        sha256: await hash(bytes),
        globalName: "ParticleStudio",
      };
    } finally {
      await bundle.close();
    }
  })();
  return {
    async provide(): Promise<PortableIifeBundle> {
      const bundle = await output;
      return { ...bundle, bytes: bundle.bytes.slice() };
    },
  };
}

/** Test-only exact Rolldown 1.2.7 authority: it resolves and loads only supplied virtual modules. */
export const genuineIifeProvider = (): PortableIifeBundleProvider => ({
  async provide(input: PortableIifeBundleInput): Promise<PortableIifeBundle> {
    expect(input.entryPath).toBe("generated/approved-iife-entry.js");
    expect(input.globalName).toBe("ParticleStudio");
    expect(input.files.map((file) => file.path)).toEqual(
      [...input.files.map((file) => file.path)].sort(),
    );
    const supplied = new Map(
      input.files.map((file) => [
        file.path,
        new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
      ]),
    );
    const bundle = await rolldown({
      input: input.entryPath,
      external: [],
      treeshake: false,
      plugins: [
        {
          name: "particle-studio-iife-virtual-authority",
          resolveId(source, importer) {
            if (importer === undefined) {
              if (source !== input.entryPath)
                throw new Error("unexpected entry");
              return source;
            }
            const resolved = resolveVirtualModule(importer, source);
            if (!supplied.has(resolved)) {
              throw new Error("unknown virtual module");
            }
            return resolved;
          },
          load(identifier) {
            const source = supplied.get(identifier);
            if (source === undefined) throw new Error("unknown virtual module");
            return source;
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
        throw new Error("expected exactly one classic chunk");
      }
      const bytes = new TextEncoder().encode(generated.output[0].code);
      return {
        path: "particle-studio.iife.js",
        bytes,
        sha256: await hash(bytes),
        globalName: "ParticleStudio",
      };
    } finally {
      await bundle.close();
    }
  },
});
