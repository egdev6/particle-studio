import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Static container contract tests. They read the real Dockerfile,
// .dockerignore, deployment documentation, workspace manifests, lockfile, and
// generated-validator paths from the repository and fail closed on any
// deviation from the accepted D1-3 headless image contract. No Docker daemon
// is required and no repository file is ever mutated as test setup.

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const readOptional = (relativePath: string): string | null => {
  const absolutePath = join(repositoryRoot, relativePath);
  return existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : null;
};

const readRequired = (relativePath: string): string => {
  const source = readOptional(relativePath);
  expect(source, `${relativePath} must exist`).not.toBeNull();
  return source as string;
};

const ACCEPTED_BASE_IMAGE =
  "node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const GENERATED_VALIDATOR_PATH =
  "packages/scene-document/src/generated/scene-document-v1-validator.generated.mjs";
const WORKSPACE_MANIFESTS = [
  "apps/editor/package.json",
  "apps/headless-mcp/package.json",
  "packages/commands/package.json",
  "packages/export/package.json",
  "packages/persistence/package.json",
  "packages/persistence-indexeddb/package.json",
  "packages/persistence-fs/package.json",
  "packages/renderer-canvas2d/package.json",
  "packages/runtime/package.json",
  "packages/scene-document/package.json",
  "packages/webmcp-adapter/package.json",
] as const;

interface IgnoreRule {
  readonly negate: boolean;
  readonly regex: RegExp;
}

// Small dockerignore-style matcher: patterns are anchored to the build
// context root, `*` never crosses `/`, `**` does, `?` matches one character,
// and later rules override earlier ones (`!` re-includes). A path whose
// ancestor directory is excluded stays excluded unless re-included exactly.
function compileIgnoreRules(source: string): IgnoreRule[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const negate = line.startsWith("!");
      let pattern = negate ? line.slice(1) : line;
      pattern = pattern.replace(/^\//, "").replace(/\/$/, "");
      const converted = pattern
        .replace(/\*\*\//g, "\u0000S")
        .replace(/\*\*/g, "\u0000G")
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .split("\u0000S")
        .join("(?:.*/)?")
        .split("\u0000G")
        .join(".*");
      return { negate, regex: new RegExp(`^${converted}$`) };
    });
}

function isContextPathExcluded(
  rules: IgnoreRule[],
  repositoryRelativePath: string,
): boolean {
  const segments = repositoryRelativePath.split("/");
  let excluded = false;
  for (let depth = 1; depth <= segments.length; depth++) {
    const prefix = segments.slice(0, depth).join("/");
    for (const rule of rules) {
      if (rule.regex.test(prefix)) excluded = !rule.negate;
    }
  }
  return excluded;
}

const splitLines = (source: string): string[] => source.split(/\r?\n/);

/** Stage sections: everything after each FROM line up to the next FROM. */
function stageSections(dockerfile: string): Array<{
  readonly name: string;
  readonly lines: string[];
}> {
  const lines = splitLines(dockerfile);
  const sections: Array<{ name: string; lines: string[] }> = [];
  let current: { name: string; lines: string[] } | null = null;
  for (const line of lines) {
    const from = line.match(/^FROM\s+\S+\s+AS\s+(\S+)/);
    if (from) {
      current = { name: from[1] as string, lines: [] };
      sections.push(current);
      continue;
    }
    current?.lines.push(line);
  }
  return sections;
}

function contractChecksForDockerfile(dockerfile: string): void {
  const fromLines = splitLines(dockerfile).filter((line) =>
    /^FROM\s/.test(line),
  );
  expect(fromLines, "exactly two stages are allowed").toHaveLength(2);

  const argLines = splitLines(dockerfile).filter((line) =>
    /^ARG\s+NODE_IMAGE=/.test(line),
  );
  expect(argLines, "one ARG must pin the base image").toHaveLength(1);
  expect(argLines[0]).toBe(`ARG NODE_IMAGE=${ACCEPTED_BASE_IMAGE}`);

  const builderSection = stageSections(dockerfile)[0];
  const runtimeSection = stageSections(dockerfile)[1];
  expect(builderSection?.name, "first stage must be the builder").toBe(
    "builder",
  );
  expect(runtimeSection?.name, "second stage must be the runtime").toBe(
    "runtime",
  );

  // Builder: exact-lock install, validator generation, production-only prune —
  // in that order — after copying the lockfile and every workspace manifest.
  const builderLines = builderSection?.lines ?? [];
  for (const manifest of ["package.json", "package-lock.json", ...WORKSPACE_MANIFESTS]) {
    expect(
      builderLines.some((line) =>
        new RegExp(`^COPY\\s+.*${manifest.replace(/\//g, "/")}(\\s|$)`).test(line),
      ),
      `builder must copy ${manifest}`,
    ).toBe(true);
  }
  const builderRuns = builderLines
    .filter((line) => /^RUN\s/.test(line))
    .map((line) => line.replace(/^RUN\s+/, "").trim());
  const npmPinIndex = builderRuns.indexOf(
    "npm install --global npm@12.0.2 --ignore-scripts --no-audit --no-fund",
  );
  const installIndex = builderRuns.indexOf(
    "npm ci --ignore-scripts --no-audit --no-fund",
  );
  const prepareIndex = builderRuns.indexOf("npm run validator:prepare");
  const productionIndex = builderRuns.indexOf(
    "npm ci --omit=dev --workspace=@particle-studio/headless-mcp --include-workspace-root=false --ignore-scripts --no-audit --no-fund",
  );
  expect(npmPinIndex, "builder must pin npm 12.0.2 before installing").toBeGreaterThan(-1);
  expect(installIndex, "builder must run exact-lock npm ci").toBeGreaterThan(-1);
  expect(prepareIndex, "builder must run validator:prepare").toBeGreaterThan(-1);
  expect(productionIndex, "builder must install the headless-only production tree").toBeGreaterThan(-1);
  expect(npmPinIndex, "the npm pin must precede the exact-lock install").toBeLessThan(installIndex);
  expect(installIndex, "install must precede validator generation").toBeLessThan(prepareIndex);
  expect(prepareIndex, "validator generation must precede the production install").toBeLessThan(productionIndex);

  // Builder source inputs: the app, the shared packages, and the root
  // tsconfig.base.json must be copied explicitly, before the steps that
  // consume them.
  const builderAppCopyIndex = builderLines.indexOf(
    "COPY apps/headless-mcp ./apps/headless-mcp",
  );
  const builderPackagesCopyIndex = builderLines.indexOf("COPY packages ./packages");
  expect(builderAppCopyIndex, "builder must explicitly copy the headless app").toBeGreaterThan(-1);
  expect(builderPackagesCopyIndex, "builder must explicitly copy shared packages").toBeGreaterThan(-1);
  const prepareLineIndex = builderLines.findIndex((line) =>
    /^RUN\s+npm run validator:prepare$/.test(line),
  );
  expect(builderAppCopyIndex, "the app copy must precede validator generation").toBeLessThan(
    prepareLineIndex,
  );
  expect(
    builderPackagesCopyIndex,
    "the packages copy must precede validator generation",
  ).toBeLessThan(prepareLineIndex);
  const tsconfigCopyIndex = builderLines.findIndex((line) =>
    /^COPY\s+tsconfig\.base\.json\b/.test(line),
  );
  expect(tsconfigCopyIndex, "builder must receive the root tsconfig.base.json").toBeGreaterThan(-1);
  const installLineIndex = builderLines.findIndex((line) =>
    /^RUN\s+npm ci --ignore-scripts --no-audit --no-fund$/.test(line),
  );
  expect(tsconfigCopyIndex, "the root tsconfig.base.json copy must precede the install").toBeLessThan(
    installLineIndex,
  );

  // Runtime: pruned node_modules, app, shared packages, and the builder-
  // generated validator must all come from the builder stage.
  const runtimeLines = runtimeSection?.lines ?? [];
  for (const required of [
    "COPY --from=builder /app/package.json /app/package-lock.json ./",
    "COPY --from=builder /app/tsconfig.base.json ./tsconfig.base.json",
    "COPY --from=builder /app/node_modules ./node_modules",
    "COPY --from=builder /app/apps/headless-mcp ./apps/headless-mcp",
    "COPY --from=builder /app/packages/commands ./packages/commands",
    "COPY --from=builder /app/packages/persistence ./packages/persistence",
    "COPY --from=builder /app/packages/persistence-fs ./packages/persistence-fs",
    "COPY --from=builder /app/packages/scene-document ./packages/scene-document",
  ]) {
    expect(runtimeLines, `runtime must contain: ${required}`).toContain(required);
  }
  // The shipped package tree is exactly the headless transitive local closure:
  // no editor-only workspace may ride along through a root-wide directory copy.
  const runtimePackageCopies = runtimeLines.filter((line) =>
    /^COPY --from=builder \/app\/packages\//.test(line),
  );
  expect(runtimePackageCopies).toEqual([
    "COPY --from=builder /app/packages/commands ./packages/commands",
    "COPY --from=builder /app/packages/persistence ./packages/persistence",
    "COPY --from=builder /app/packages/persistence-fs ./packages/persistence-fs",
    "COPY --from=builder /app/packages/scene-document ./packages/scene-document",
  ]);
  const packagesCopyIndex = runtimeLines.findIndex((line) =>
    line.startsWith("COPY --from=builder /app/packages"),
  );
  expect(packagesCopyIndex, "packages must be copied from the builder").toBeGreaterThan(-1);

  // Identity, environment, entry process, and signal are fixed.
  const runtimeLinesJoined = runtimeLines.join("\n");
  expect(runtimeLines, "runtime must set WORKDIR /app").toContain("WORKDIR /app");
  expect(runtimeLines, "runtime must run as the non-root node user").toContain(
    "USER node",
  );
  expect(runtimeLines, "runtime must set STOPSIGNAL SIGTERM").toContain(
    "STOPSIGNAL SIGTERM",
  );
  const envText = runtimeLinesJoined.replace(/\\\r?\n/g, "\n");
  const envTokens = envText
    .split(/\s+/)
    .filter((token) => /^[A-Z_][A-Z0-9_]*=/.test(token));
  for (const env of ["NODE_ENV=production", "HOME=/tmp", "TSX_DISABLE_CACHE=1"]) {
    expect(envTokens, `runtime ENV must set ${env}`).toContain(env);
  }
  const entrypointLines = runtimeLines.filter((line) => /^ENTRYPOINT/.test(line));
  expect(entrypointLines, "runtime must declare one ENTRYPOINT").toHaveLength(1);
  const entrypoint = (entrypointLines[0] as string).replace(/^ENTRYPOINT\s+/, "");
  expect(entrypoint, "the entry process must be exec-form, not a shell").toMatch(
    /^\[/,
  );
  expect(JSON.parse(entrypoint)).toEqual([
    "node",
    "--import",
    "tsx",
    "apps/headless-mcp/src/main.ts",
  ]);

  // Forbidden directives anywhere: no exposed network, health, volume, shell,
  // or runtime package installation; the editor never enters the image.
  const normalized = splitLines(dockerfile.replace(/\\\r?\n/g, "\n")).join("\n");
  expect(normalized).not.toMatch(/^\s*EXPOSE\b/m);
  expect(normalized).not.toMatch(/^\s*HEALTHCHECK\b/m);
  expect(normalized).not.toMatch(/^\s*VOLUME\b/m);
  expect(normalized).not.toMatch(/^\s*CMD\b/m);
  expect(normalized).not.toMatch(/\/bin\/sh|\/bin\/bash|sh -c/);
  const runtimeRuns = runtimeLines.filter((line) => /^RUN\s/.test(line));
  expect(runtimeRuns, "the runtime stage must not run commands").toEqual([]);
  expect(normalized).not.toMatch(/apt-get|apt install|apk add|yum install/);
  const editorSourceCopies = splitLines(dockerfile).filter((line) =>
    /^COPY\s/.test(line) && /apps\/editor/.test(line) &&
    !/apps\/editor\/package\.json/.test(line),
  );
  expect(editorSourceCopies, "editor source or dist must never be copied").toEqual([]);
}

function contractChecksForDockerignore(source: string): void {
  const rules = compileIgnoreRules(source);
  expect(rules.length, "the dockerignore must define rules").toBeGreaterThan(0);

  const mustBeExcluded = [
    ".git/config",
    ".pi/settings.json",
    "odd/tasks/d1-independent-deployments.md",
    "openspec/config.yaml",
    "node_modules/tsx/dist/cli.mjs",
    "apps/headless-mcp/node_modules/@modelcontextprotocol/server/package.json",
    "packages/scene-document/node_modules/ajv/package.json",
    "node_modules/.cache/particle-studio/scene-document-validator/x",
    "apps/headless-mcp/tests-integration/headless-container-contract.test.ts",
    "apps/headless-mcp/tests/workspace.test.ts",
    "packages/scene-document/tests/validator.test.ts",
    "apps/editor/e2e/deep-links.spec.ts",
    "apps/editor/src/App.tsx",
    "apps/editor/dist/assets/index-abc123.js",
    "packages/scene-document/src/generated/scene-document-v1-validator.generated.mjs",
    "apps/headless-mcp/Dockerfile",
    "test-results/headless-mcp-stdio/x",
    "apps/headless-mcp/node_modules/.cache/tsc/headless-mcp.tsbuildinfo",
    "tsconfig.base.tsbuildinfo",
  ];
  for (const path of mustBeExcluded) {
    expect(
      isContextPathExcluded(rules, path),
      `build context must exclude ${path}`,
    ).toBe(true);
  }

  const mustBeRetained = [
    "package.json",
    "package-lock.json",
    "apps/editor/package.json",
    "apps/headless-mcp/package.json",
    "packages/scene-document/package.json",
    "apps/headless-mcp/src/main.ts",
    "apps/headless-mcp/src/headless-draft-workspace.ts",
    "packages/commands/src/index.ts",
    "packages/persistence/src/index.ts",
    "packages/persistence-fs/src/revision-persistence.ts",
    "packages/persistence-fs/src/asset-persistence.ts",
    "packages/scene-document/src/index.ts",
    "packages/scene-document/src/validation/scene-document-v1-validator-contract.ts",
    "packages/scene-document/src/validation/validate-scene-document.ts",
    "packages/scene-document/src/schemas/scene-document-v1.ts",
    "packages/scene-document/scripts/generate-scene-document-v1-validator.ts",
    "packages/scene-document/src/generated/scene-document-v1-validator.generated.sha256",
    "packages/scene-document/src/generated/scene-document-v1-validator.generated.d.mts",
  ];
  for (const path of mustBeRetained) {
    expect(
      isContextPathExcluded(rules, path),
      `build context must retain ${path}`,
    ).toBe(false);
  }
}

function contractChecksForDeploymentDocs(docs: string): void {
  // Progressive disclosure, section 1: static editor on Netlify, separate.
  expect(docs).toContain("netlify.toml");
  expect(docs).toContain("apps/editor/dist");
  expect(docs.toLowerCase()).toMatch(/separate/);

  // Section 2: exact local image build command from the repository root.
  expect(docs).toContain("docker build -f apps/headless-mcp/Dockerfile");
  // The build installs the full exact lock, generates, then prunes.
  expect(docs.toLowerCase()).toMatch(/full exact lock/);
  expect(docs.toLowerCase()).toMatch(/prune/);

  // Section 3: three canonical pairwise-disjoint host roots, uid/gid 1000.
  expect(docs).toMatch(/pairwise[- ]disjoint/);
  expect(docs).toContain("1000:1000");
  expect(docs.toLowerCase()).toMatch(/read-only/);
  expect(docs.toLowerCase()).toMatch(/read-write|writable/);

  // The three absolute host roots must be defined before the run block.
  const runCommandIndex = docs.indexOf("docker run");
  expect(runCommandIndex, "documentation must contain the docker run command").toBeGreaterThan(-1);
  for (const hostVariable of ["DOCUMENTS", "WORKSPACE", "OUTPUTS"]) {
    const assignmentIndex = docs.indexOf(`${hostVariable}=`);
    expect(
      assignmentIndex,
      `documentation must define the absolute host ${hostVariable} before docker run`,
    ).toBeGreaterThan(-1);
    expect(
      assignmentIndex,
      `the ${hostVariable} assignment must precede docker run`,
    ).toBeLessThan(runCommandIndex);
  }


  // Section 4: exact hardened run with explicit mounts and all five variables.
  expect(docs).toMatch(/docker run\s+--rm -i/);
  expect(docs).toContain("--network=none");
  expect(docs).toContain("--read-only");
  expect(docs).toContain("--tmpfs /tmp:rw,nosuid,nodev,size=64m");
  expect(docs).toContain("--user 1000:1000");
  expect(docs).toMatch(/documents:ro/);
  expect(docs).toMatch(/workspace/);
  expect(docs).toMatch(/outputs/);
  for (const variable of [
    "PARTICLE_STUDIO_WORKSPACE_ROOT",
    "PARTICLE_STUDIO_DOCUMENTS_ROOT",
    "PARTICLE_STUDIO_OUTPUTS_ROOT",
    "PARTICLE_STUDIO_DOCUMENT_ID",
    "PARTICLE_STUDIO_SEED_PATH",
  ]) {
    expect(docs, `run documentation must set ${variable}`).toContain(variable);
  }
  expect(docs.toLowerCase()).toMatch(/relative to/);

  // Section 5: stdio lifecycle.
  expect(docs).toContain("initialize");
  expect(docs).toContain("tools/list");
  expect(docs).toContain("EOF");
  expect(docs).toContain("SIGTERM");
  expect(docs).toContain("stdin");
  expect(docs).toContain("stdout");
  expect(docs).toContain("stderr");
  expect(docs.toLowerCase()).toMatch(/protocol/);
  expect(docs.toLowerCase()).toMatch(/no (listening )?port/);
  expect(docs.toLowerCase()).toMatch(/health/);

  // Section 5 shutdown semantics: stdin must stay open until every expected
  // response has been read; closing it is a shutdown signal only.
  expect(docs.toLowerCase()).toMatch(/stdin must stay open until/);
  expect(docs.toLowerCase()).toMatch(/shutdown signal/);
  expect(docs.toLowerCase()).toMatch(/in-flight/);
  expect(docs.toLowerCase()).toMatch(/does not prove every\s+request was answered/);

  // Section 3: the first-run seed is documented with a verified working
  // example and fails closed on absence or schema violation.
  const seedExample = docs.match(/```json\n([\s\S]*?)```/);
  expect(
    seedExample,
    "the guide must embed the seed example as a json code block",
  ).not.toBeNull();
  const seedDocument = JSON.parse(seedExample?.[1] ?? "") as Record<
    string,
    unknown
  >;
  expect(seedDocument.schemaVersion, "the seed example must be a v1 scene document").toBe(1);
  expect(seedDocument.seed, "the seed example must set the required seed field").toBeTruthy();
  expect(seedDocument.rootIds, "the seed example must list rootIds").toBeTruthy();
  expect(docs).toContain("HEADLESS_WORKSPACE_SEED_UNAVAILABLE");
  expect(docs).toContain("HEADLESS_WORKSPACE_SEED_INVALID");

  // Section 6: threat model — flags are defense in depth only.
  expect(docs.toLowerCase()).toMatch(/defense in depth/);
  expect(docs.toLowerCase()).toMatch(/confinement/);
  expect(docs.toLowerCase()).toMatch(/authoritative/);

  // Section 7: no registry push or publish instructions.
  expect(docs).not.toMatch(/docker push/);
  expect(docs).not.toMatch(/docker login/);
  expect(docs).not.toMatch(/registry/);
  expect(docs).not.toMatch(/docker tag/);
}

describe("headless-mcp container static contract", () => {
  it("pins both stages to the accepted digest through a single ARG", () => {
    contractChecksForDockerfile(readRequired("apps/headless-mcp/Dockerfile"));
  });

  it("installs exactly, generates the validator, and prunes to production in the builder", () => {
    contractChecksForDockerfile(readRequired("apps/headless-mcp/Dockerfile"));
  });

  it("assembles a non-root runtime from the builder with the fixed stdio entry process", () => {
    contractChecksForDockerfile(readRequired("apps/headless-mcp/Dockerfile"));
  });

  it("keeps the image a sealed stdio process with no forbidden directives", () => {
    contractChecksForDockerfile(readRequired("apps/headless-mcp/Dockerfile"));
  });

  it("keeps runtime source in the context while excluding tests, editor, and the generated validator", () => {
    contractChecksForDockerignore(readRequired(".dockerignore"));
  });

  it("keeps the workspace manifests, lockfile, schema/generator inputs, and tracked validator files in the context", () => {
    contractChecksForDockerignore(readRequired(".dockerignore"));
  });

  it("documents the Netlify editor as a separate static surface", () => {
    contractChecksForDeploymentDocs(readRequired("docs/deployment.md"));
  });

  it("documents the exact local build and hardened run contract", () => {
    contractChecksForDeploymentDocs(readRequired("docs/deployment.md"));
  });

  it("documents the stdio lifecycle and the defense-in-depth threat model without any push path", () => {
    contractChecksForDeploymentDocs(readRequired("docs/deployment.md"));
  });

  it("keeps ajv as a scene-document production dependency with the exact tsx runtime pin", () => {
    const sceneDocumentPackage = JSON.parse(
      readRequired("packages/scene-document/package.json"),
    ) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(sceneDocumentPackage.dependencies.ajv).toBe("8.20.0");
    expect(sceneDocumentPackage.devDependencies?.ajv).toBeUndefined();

    const headlessPackage = JSON.parse(
      readRequired("apps/headless-mcp/package.json"),
    ) as { dependencies: Record<string, string> };
    expect(headlessPackage.dependencies.tsx).toBe("4.23.13");

    const rootPackage = JSON.parse(readRequired("package.json")) as {
      engines: Record<string, string>;
      packageManager: string;
    };
    expect(rootPackage.engines.node).toBe("24.20.x");
    expect(rootPackage.engines.npm).toBe("12.0.2");
    expect(rootPackage.packageManager).toBe("npm@12.0.2");
    expect(
      readRequired("apps/headless-mcp/Dockerfile"),
      "the builder must install the pinned npm before any install step",
    ).toContain(
      "RUN npm install --global npm@12.0.2 --ignore-scripts --no-audit --no-fund",
    );
  });

  it("records the production ajv closure and validator contract in the lockfile and tracked hash", () => {
    const lock = readRequired("package-lock.json");
    expect(lock).toContain('"node_modules/ajv"');
    expect(lock).toContain('"ajv": "8.20.0"');
    expect(lock).toContain('"node_modules/json-canonicalize"');

    const validatorHash = readRequired(
      "packages/scene-document/src/generated/scene-document-v1-validator.generated.sha256",
    ).trim();
    expect(validatorHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed when any critical contract token is mutated (in-memory triangulation)", () => {
    const dockerfile = readRequired("apps/headless-mcp/Dockerfile");
    const dockerignore = readRequired(".dockerignore");
    const docs = readRequired("docs/deployment.md");

    const dockerfileMutations: Array<[string, (source: string) => string]> = [
      [
        "wrong base digest",
        (source) =>
          source.replace(
            ACCEPTED_BASE_IMAGE,
            "node:24.20.0-bookworm-slim@sha256:0000000000000000000000000000000000000000000000000000000000000000",
          ),
      ],
      [
        "missing exact-lock install flags",
        (source) =>
          source.replace(
            "npm ci --ignore-scripts --no-audit --no-fund",
            "npm ci --ignore-scripts --no-audit",
          ),
      ],
      [
        "missing validator generation",
        (source) => source.replace("npm run validator:prepare\n", ""),
      ],
      [
        "missing builder npm pin",
        (source) =>
          source.replace(
            "RUN npm install --global npm@12.0.2 --ignore-scripts --no-audit --no-fund\n",
            "",
          ),
      ],
      [
        "wrong builder npm pin",
        (source) => source.replace("npm@12.0.2", "npm@11.19.0"),
      ],
      [
        "production install widened back to the whole workspace graph",
        (source) =>
          source.replace(
            "npm ci --omit=dev --workspace=@particle-studio/headless-mcp --include-workspace-root=false --ignore-scripts --no-audit --no-fund",
            "npm ci --omit=dev --ignore-scripts --no-audit --no-fund",
          ),
      ],
      [
        "editor-only workspace copied into the runtime",
        (source) =>
          source.replace(
            "COPY --from=builder /app/packages/scene-document ./packages/scene-document\n",
            "COPY --from=builder /app/packages/scene-document ./packages/scene-document\nCOPY --from=builder /app/packages/export ./packages/export\n",
          ),
      ],
      [
        "root user",
        (source) => source.replace("USER node", "USER root"),
      ],
      [
        "wrong entry process",
        (source) =>
          source.replace(
            '"apps/headless-mcp/src/main.ts"',
            '"apps/headless-mcp/src/main-other.ts"',
          ),
      ],
      [
        "shell entrypoint",
        (source) =>
          source.replace(
            "ENTRYPOINT [\"node\", \"--import\", \"tsx\", \"apps/headless-mcp/src/main.ts\"]",
            "ENTRYPOINT node --import tsx apps/headless-mcp/src/main.ts",
          ),
      ],
      [
        "missing stop signal",
        (source) => source.replace("STOPSIGNAL SIGTERM\n", ""),
      ],
      [
        "missing production environment",
        (source) => source.replace("NODE_ENV=production", "NODE_ENV=development"),
      ],
      [
        "missing tmp home",
        (source) => source.replace("HOME=/tmp", "HOME=/root"),
      ],
      [
        "missing tsx cache disable",
        (source) => source.replace("TSX_DISABLE_CACHE=1", "TSX_DISABLE_CACHE=0"),
      ],
      [
        "node_modules copied from the context instead of the builder",
        (source) =>
          source.replace(
            "COPY --from=builder /app/node_modules ./node_modules",
            "COPY node_modules ./node_modules",
          ),
      ],
      [
        "forbidden EXPOSE directive",
        (source) => `${source}\nEXPOSE 3000\n`,
      ],
      [
        "forbidden HEALTHCHECK directive",
        (source) => `${source}\nHEALTHCHECK CMD true\n`,
      ],
      [
        "forbidden VOLUME directive",
        (source) => `${source}\nVOLUME /data\n`,
      ],
      [
        "runtime-stage package install",
        (source) => source.replace("USER node", "RUN apt-get update && apt-get install -y curl\nUSER node"),
      ],
      [
        "editor source copied into the image",
        (source) => `${source}\nCOPY apps/editor/src apps/editor/src\n`,
      ],
      [
        "missing stage name",
        (source) => source.replace("FROM ${NODE_IMAGE} AS runtime", "FROM ${NODE_IMAGE}"),
      ],
      [
        "missing builder app copy",
        (source) => source.replace("COPY apps/headless-mcp ./apps/headless-mcp\n", ""),
      ],
      [
        "missing builder packages copy",
        (source) => source.replace("COPY packages ./packages\n", ""),
      ],
      [
        "builder source copies after validator generation",
        (source) =>
          source.replace(
            "COPY apps/headless-mcp ./apps/headless-mcp\nCOPY packages ./packages\nRUN npm run validator:prepare",
            "RUN npm run validator:prepare\nCOPY apps/headless-mcp ./apps/headless-mcp\nCOPY packages ./packages",
          ),
      ],
      [
        "missing builder tsconfig",
        (source) => source.replace("COPY tsconfig.base.json ./tsconfig.base.json\n", ""),
      ],
      [
        "runtime missing tsconfig",
        (source) =>
          source.replace(
            "COPY --from=builder /app/tsconfig.base.json ./tsconfig.base.json\n",
            "",
          ),
      ],
    ];

    for (const [name, mutate] of dockerfileMutations) {
      expect(() => contractChecksForDockerfile(mutate(dockerfile)), `mutation must fail: ${name}`).toThrow();
    }

    const dockerignoreMutations: Array<[string, (source: string) => string]> = [
      ["missing node_modules exclusion", (source) => source.replace("**/node_modules\n", "")],
      ["missing VCS exclusion", (source) => source.replace(".git\n", "")],
      ["missing ODD exclusion", (source) => source.replace("odd\n", "")],
      ["missing OpenSpec exclusion", (source) => source.replace("openspec\n", "")],
      ["missing Pi state exclusion", (source) => source.replace(".pi\n", "")],
      ["missing test exclusion", (source) => source.replace("**/tests\n", "")],
      [
        "missing editor source exclusion",
        (source) => source.replace("apps/editor/*\n", ""),
      ],
      [
        "editor manifest no longer retained",
        (source) => source.replace("!apps/editor/package.json\n", ""),
      ],
      [
        "generated validator shipped from the context",
        (source) =>
          source.replace(
            `${GENERATED_VALIDATOR_PATH}\n`,
            "",
          ),
      ],
      [
        "the Dockerfile re-ships in the image",
        (source) => source.replace("apps/headless-mcp/Dockerfile\n", ""),
      ],
      [
        "test results no longer excluded",
        (source) => source.replace("test-results\n", ""),
      ],
      [
        "tsbuildinfo no longer excluded",
        (source) => source.replace("**/*.tsbuildinfo\n", ""),
      ],
    ];

    for (const [name, mutate] of dockerignoreMutations) {
      expect(
        () => contractChecksForDockerignore(mutate(dockerignore)),
        `mutation must fail: ${name}`,
      ).toThrow();
    }

    const docsMutations: Array<[string, (source: string) => string]> = [
      [
        "missing hardened network flag",
        (source) => source.replace(/--network=none/g, "--network=bridge"),
      ],
      ["missing read-only root", (source) => source.replace(/--read-only/g, "")],
      [
        "missing tmpfs hardening",
        (source) =>
          source.replace(/--tmpfs \/tmp:rw,nosuid,nodev,size=64m/g, "--tmpfs /tmp"),
      ],
      ["missing non-root user flag", (source) => source.replace(/--user 1000:1000/g, "")],
      ["missing documents mount", (source) => source.replace(/documents:ro/g, "documents")],
      [
        "missing workspace variable",
        (source) =>
          source.replace(/PARTICLE_STUDIO_WORKSPACE_ROOT/g, "WORKSPACE_ROOT"),
      ],
      [
        "missing seed variable",
        (source) => source.replace(/PARTICLE_STUDIO_SEED_PATH/g, "SEED_PATH"),
      ],
      ["missing readiness proof", (source) => source.replace(/initialize/g, "init")],
      ["missing shutdown proof", (source) => source.replace(/SIGTERM/g, "")],
      ["missing threat-model note", (source) => source.replace(/defense in depth/gi, "optional")],
      ["push instruction introduced", (source) => `${source}\ndocker push example/headless:latest\n`],
      [
        "missing absolute host path assignments",
        (source) =>
          source
            .replace(/DOCUMENTS="\$HOME[^"]*"\n/, "")
            .replace(/WORKSPACE="\$HOME[^"]*"\n/, "")
            .replace(/OUTPUTS="\$HOME[^"]*"\n/, ""),
      ],
      [
        "host path assignments moved after the run block",
        (source) => {
          const stripped = source
            .replace(/DOCUMENTS="\$HOME[^"]*"\n/, "")
            .replace(/WORKSPACE="\$HOME[^"]*"\n/, "")
            .replace(/OUTPUTS="\$HOME[^"]*"\n/, "");
          return `${stripped}\nDOCUMENTS="$HOME/moved"\nWORKSPACE="$HOME/moved"\nOUTPUTS="$HOME/moved"\n`;
        },
      ],
      [
        "build sequence clarification removed",
        (source) => source.replace("full exact lock", "exact lock"),
      ],
      [
        "seed example removed",
        (source) => source.replace(/```json\n[\s\S]*?```/, ""),
      ],
      [
        "seed fail-closed codes removed",
        (source) =>
          source
            .replace(/HEADLESS_WORKSPACE_SEED_UNAVAILABLE/g, "SEED_UNAVAILABLE")
            .replace(/HEADLESS_WORKSPACE_SEED_INVALID/g, "SEED_INVALID"),
      ],
      [
        "seed rootIds field removed",
        (source) => source.replace('  "rootIds": ["shape-1"],\n', ""),
      ],
      [
        "stdin keep-open requirement removed",
        (source) =>
          source.replace(
            /stdin must stay open until[^;\n]*/,
            "close stdin immediately",
          ),
      ],
      [
        "shutdown semantics caveat removed",
        (source) =>
          source.replace(
            /Closing stdin is a shutdown signal[\s\S]*?request was answered\./,
            "Closing stdin ends the session.",
          ),
      ],
    ];

    for (const [name, mutate] of docsMutations) {
      expect(
        () => contractChecksForDeploymentDocs(mutate(docs)),
        `mutation must fail: ${name}`,
      ).toThrow();
    }
  });
});
