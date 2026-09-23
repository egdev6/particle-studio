import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const testsDirectory = import.meta.dirname;
const packageRoot = resolve(testsDirectory, "..");
const repositoryRoot = resolve(packageRoot, "..", "..");
const manifestPath = resolve(packageRoot, "package.json");
const lockPath = resolve(repositoryRoot, "package-lock.json");
const generatedValidatorPath = resolve(
  packageRoot,
  "src/generated/scene-document-v1-validator.generated.mjs",
);
const generatorScriptPath = resolve(
  repositoryRoot,
  "packages/scene-document/scripts/generate-scene-document-v1-validator.ts",
);

const workspaceKey = "packages/scene-document";
const installedAjvKey = "node_modules/ajv";
const generatedRuntimeHelper = "ajv/dist/runtime/ucs2length";

interface WorkspaceManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface RootLockfile {
  packages: Record<
    string,
    {
      name?: string;
      version?: string;
      resolved?: string;
      dev?: boolean;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }
  >;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function prepareGeneratedValidator(): void {
  if (existsSync(generatedValidatorPath)) {
    return;
  }
  for (const mode of ["generate", "verify"] as const) {
    execFileSync(
      process.execPath,
      ["--experimental-strip-types", generatorScriptPath, mode],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );
  }
}

function owningPackageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    if (scope && name) {
      return `${scope}/${name}`;
    }
    return specifier;
  }
  return specifier.split("/")[0] ?? specifier;
}

function isExternalBareSpecifier(specifier: string): boolean {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("node:")
  ) {
    return false;
  }
  return !builtinModules.includes(owningPackageName(specifier));
}

function externalRuntimeImports(source: string): string[] {
  const specifiers = new Set<string>();
  const patterns: RegExp[] = [
    /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g,
    /\bimport\s+[^;'"]*?from\s*(['"])([^'"]+)\1/g,
    /\bimport\s*(['"])([^'"]+)\1/g,
    /\bimport\(\s*(['"])([^'"]+)\1\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[2];
      if (specifier && isExternalBareSpecifier(specifier)) {
        specifiers.add(specifier);
      }
    }
  }
  return [...specifiers].sort();
}

describe("generated validator production dependency closure", () => {
  it("declares every external runtime helper of the generated validator as a runtime dependency", () => {
    prepareGeneratedValidator();
    const manifest = readJson<WorkspaceManifest>(manifestPath);
    const validatorSource = readFileSync(generatedValidatorPath, "utf8");

    const runtimeImports = externalRuntimeImports(validatorSource);
    expect(runtimeImports).toEqual([generatedRuntimeHelper]);

    for (const specifier of runtimeImports) {
      const owner = owningPackageName(specifier);
      expect(
        manifest.dependencies?.[owner],
        `runtime helper ${specifier} requires ${owner} under dependencies`,
      ).toBeDefined();
      expect(
        manifest.devDependencies?.[owner],
        `${owner} must not stay in devDependencies now that it is a runtime dependency`,
      ).toBeUndefined();
    }

    expect(
      manifest.dependencies?.ajv,
      "ajv must be a runtime dependency of @particle-studio/scene-document, not a dev-only one",
    ).toBe("8.20.0");
  });

  it("keeps generator-only typebox out of the runtime dependency class", () => {
    prepareGeneratedValidator();
    const manifest = readJson<WorkspaceManifest>(manifestPath);
    const validatorSource = readFileSync(generatedValidatorPath, "utf8");

    expect(externalRuntimeImports(validatorSource)).not.toContain(
      "@sinclair/typebox",
    );

    expect(manifest.dependencies?.["@sinclair/typebox"]).toBeUndefined();
    expect(manifest.devDependencies?.["@sinclair/typebox"]).toBe("0.34.52");

    expect(manifest.dependencies?.["json-canonicalize"]).toBe("3.0.0");
  });

  it("records ajv 8.20.0 under the scene-document workspace dependencies in the root lockfile", () => {
    const lock = readJson<RootLockfile>(lockPath);
    const workspace = lock.packages[workspaceKey];

    expect(workspace?.name).toBe("@particle-studio/scene-document");
    expect(
      workspace?.dependencies?.ajv,
      "the root lockfile must record ajv as a runtime dependency of packages/scene-document",
    ).toBe("8.20.0");
    expect(workspace?.devDependencies?.ajv).toBeUndefined();

    expect(workspace?.dependencies?.["json-canonicalize"]).toBe("3.0.0");
    expect(workspace?.devDependencies?.["@sinclair/typebox"]).toBe("0.34.52");
  });

  it("keeps the installed ajv lock entry production-owned at exactly 8.20.0", () => {
    const lock = readJson<RootLockfile>(lockPath);
    const installed = lock.packages[installedAjvKey];

    expect(
      installed?.version,
      "the installed ajv lock entry must stay exactly 8.20.0",
    ).toBe("8.20.0");
    expect(
      installed?.dev,
      "the installed ajv lock entry must not be marked dev-only",
    ).not.toBe(true);
    expect(installed?.resolved).toMatch(/\/ajv\/-\/ajv-8\.20\.0\.tgz$/);
  });

  it("resolves the ucs2length runtime helper from the scene-document package context", () => {
    const requireFromPackage = createRequire(
      resolve(testsDirectory, "runtime-dependency-closure.test.ts"),
    );
    const resolvedHelper = requireFromPackage.resolve(generatedRuntimeHelper);

    expect(existsSync(resolvedHelper), `${resolvedHelper} must exist`).toBe(
      true,
    );
    expect(
      resolvedHelper.endsWith(
        `dist${sep}runtime${sep}ucs2length.js`,
      ),
      `the helper must resolve to ajv/dist/runtime/ucs2length.js, got ${resolvedHelper}`,
    ).toBe(true);

    const installedPackageRoot = resolve(resolvedHelper, "..", "..", "..");
    expect(
      installedPackageRoot.endsWith(`node_modules${sep}ajv`),
      `the helper must resolve inside an installed ajv package, got ${installedPackageRoot}`,
    ).toBe(true);
    const installedManifest = readJson<{ version?: string }>(
      resolve(installedPackageRoot, "package.json"),
    );
    expect(installedManifest.version).toBe("8.20.0");

    const helperModule = requireFromPackage(generatedRuntimeHelper) as {
      default: (value: string) => number;
    };
    expect(typeof helperModule.default).toBe("function");
    expect(helperModule.default("a")).toBe(1);
  });
});
