// @vitest-environment node

import { describe, expect, it } from "vitest";

// apps/editor/tsconfig.json restricts "types" to vitest/globals, so @types/node
// is not part of this program and "node:*" module specifiers do not resolve.
// process.getBuiltinModule reaches the same Node built-ins at runtime without
// changing the editor compiler options.
type NodeFsModule = {
  readFileSync(path: string, encoding: "utf8"): string;
};

const nodeProcess = (
  globalThis as unknown as {
    process: { cwd(): string; getBuiltinModule(id: string): unknown };
  }
).process;
const nodeFs = nodeProcess.getBuiltinModule("node:fs") as NodeFsModule;
const repoRoot = nodeProcess.cwd() + "/";
const netlifyToml = nodeFs.readFileSync(`${repoRoot}netlify.toml`, "utf8");
const viteConfigSource = nodeFs.readFileSync(`${repoRoot}vite.config.ts`, "utf8");

/**
 * Single guard for the static, secret-free deployment contract, kept as one
 * function so the in-memory triangulation below exercises exactly the guard
 * the tracked file must satisfy.
 */
const assertStaticSecretFreeDeployment = (source: string): void => {
  expect(
    /secrets|functions|edge_functions|\bplugins\b|\bproxy\b|\bssr\b/i.test(
      source,
    ),
    "no secrets, functions, edge functions, plugins, proxies, or SSR",
  ).toBe(false);

  // The [build.environment] table is the exact shape a leaked secret would
  // take, so bound it to the two pinned versions: any additional key fails
  // closed, and so does a missing or duplicated section.
  //
  // TOML also makes these shapes legal, which exact-text checks miss:
  //  - whitespace around the dots of a dotted key ([build.environment . API]
  //    is equivalent to [build.environment.API]),
  //  - quoted keys ("KEY" or 'KEY') in key/value pairs,
  //  - dotted key paths (api.secret = "...") inside a table.
  // Normalize headers into dot-separated segments and keys into their quoted
  // path form before any comparison so none of these shapes evades the bound.
  const headerSegments = (header: string): string[] =>
    header.split(".").map((segment) => segment.trim());
  const keyOf = (line: string): string | undefined => {
    // Full (possibly dotted, possibly quoted) key path before the "=" of a
    // key/value line; comments, blank lines, and table headers never match.
    const match = line.match(
      /^\s*((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=/,
    );
    return match?.[1]
      ?.split(".")
      .map((segment) => segment.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1").trim())
      .join(".");
  };
  const keysOf = (section: TomlSection): string[] =>
    section.body
      .map(keyOf)
      .filter((key): key is string => key !== undefined);
  const isEnvironmentShaped = (segments: string[]): boolean =>
    segments.length >= 2 &&
    (segments[segments.length - 1] === "environment" ||
      segments[segments.length - 2] === "environment");
  const isBuildEnvironment = (segments: string[]): boolean =>
    segments[0] === "build" && segments[1] === "environment";

  const environment = tomlSection(source, "build.environment");
  expect(
    keysOf(environment).filter(
      (key) => key !== "NODE_VERSION" && key !== "NPM_VERSION",
    ),
    "[build.environment] must stay bounded to NODE_VERSION and NPM_VERSION",
  ).toEqual([]);

  // Every other environment-shaped table ([build.environment.*] with its
  // spaced dotted variants, [context.*.environment], and any deeper
  // *.environment.* table) shares the same allow-list bound: no key outside
  // NODE_VERSION/NPM_VERSION may be set there.
  const smugglers = tomlSections(source)
    .filter((section) => isEnvironmentShaped(headerSegments(section.header)))
    .filter((section) => {
      const keys = keysOf(section);
      return isBuildEnvironment(headerSegments(section.header))
        ? keys.some((key) => key !== "NODE_VERSION" && key !== "NPM_VERSION")
        : keys.length > 0;
    });
  expect(
    smugglers.map((section) => section.header),
    "no environment-shaped table outside [build.environment] may carry keys",
  ).toEqual([]);

  // Fail-closed document-wide bound: every assignment whose normalized dotted
  // key path contains an "environment" segment — via a section join
  // ([build.environment] bodies), a dotted key (build.environment.X = 1), or
  // an inline table (environment = { ... } under [build]) — must be exactly
  // one of the two pinned variable paths with its pinned quoted value. An
  // inline environment table therefore fails because its own path
  // (build.environment) is not the pinned path of an individual variable.
  // Additionally, inside an environment-shaped table, any line containing
  // "=" whose key cannot be resolved confidently (e.g. an escaped quote
  // inside a quoted key) fails closed instead of being skipped.
  const pinnedPaths = new Set([
    "build.environment.NODE_VERSION",
    "build.environment.NPM_VERSION",
  ]);
  const violations: string[] = [];
  let sectionSegments: string[] = [];
  let sectionPath = "";
  for (const line of source.split(/\r?\n/)) {
    const header = line.match(/^\s*\[+\s*([^\]]+?)\s*\]+\s*$/);
    if (header) {
      sectionSegments = headerSegments(header[1] ?? "").map((segment) =>
        segment.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1"),
      );
      sectionPath = sectionSegments.join(".");
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const key = keyOf(trimmed);
    if (key === undefined) {
      if (isEnvironmentShaped(sectionSegments)) {
        violations.push(`unparsed assignment in [${sectionPath}]: ${trimmed}`);
      }
      continue;
    }
    const fullPath = [sectionPath, key].filter(Boolean).join(".");
    if (!pinnedPaths.has(fullPath) && fullPath.split(".").includes("environment")) {
      violations.push(`${fullPath} is outside the pinned environment bound`);
    }
  }
  expect(
    violations,
    "every environment-keyed assignment must be one of the two pinned build.environment variables, and environment-shaped tables must fail closed on unparseable assignments",
  ).toEqual([]);

  // The environment bound is shape-based, so it cannot see a credential stored
  // in an ordinary key such as a command, a header value, or a comment. Reject
  // credential-shaped literals anywhere in the document, independent of the key
  // that holds them. The patterns stay narrow enough to accept ordinary Netlify
  // values such as "npm run build", "apps/editor/dist", "/*", "200", the
  // immutable cache-control value, and the pinned version strings.
  const credentialShapes: Array<[string, RegExp]> = [
    ["Stripe key", /(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{8,}/],
    [
      "GitHub token",
      /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/,
    ],
    ["AWS access key id", /AKIA[0-9A-Z]{16}/],
    ["npm token", /npm_[A-Za-z0-9]{36}/],
    ["Slack token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
    ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ];
  for (const [name, pattern] of credentialShapes) {
    expect(
      pattern.test(source),
      `no literal ${name} may be stored in the tracked deployment config`,
    ).toBe(false);
  }
};

type TomlSection = { header: string; body: string[] };

function tomlSections(source: string): TomlSection[] {
  const sections: TomlSection[] = [];
  for (const line of source.split(/\r?\n/)) {
    const header = line.match(/^\s*\[+\s*([^\]]+?)\s*\]+\s*$/);
    if (header) {
      sections.push({ header: header[1] ?? "", body: [] });
    } else if (sections.length > 0) {
      sections[sections.length - 1]?.body.push(line);
    }
  }
  return sections;
}

function tomlSection(source: string, header: string): TomlSection {
  const matches = tomlSections(source).filter(
    (section) => section.header === header,
  );
  expect(matches, `TOML section [${header}]`).toHaveLength(1);
  const section = matches[0];
  if (!section) throw new Error(`missing TOML section [${header}]`);
  return section;
}

function tomlValue(body: string[], key: string): string {
  // Whitespace around the separator, single or double quotes around the value,
  // and a trailing comment are all legitimate TOML style, so none of them may
  // change what a pinned key reads as.
  const assignment = new RegExp(`^\\s*${key}\\s*=`);
  const entries = body.filter((line) => assignment.test(line));
  expect(entries, `TOML key ${key}`).toHaveLength(1);
  const value = entries[0]?.split("=").slice(1).join("=");
  const withoutComment = (value ?? "").replace(/\s+#.*$/s, "").trim();
  const unquoted = withoutComment
    .replace(/^"(.*)"$/s, "$1")
    .replace(/^'(.*)'$/s, "$1");
  expect(unquoted, `TOML value for ${key}`).toBeTruthy();
  return unquoted;
}

describe("Netlify static deployment contract", () => {
  it("builds from the repository root and publishes the editor dist", () => {
    const build = tomlSection(netlifyToml, "build");
    expect(tomlValue(build.body, "command")).toBe("npm run build");
    expect(tomlValue(build.body, "publish")).toBe("apps/editor/dist");
  });

  it("pins the exact accepted build environment versions", () => {
    const environment = tomlSection(netlifyToml, "build.environment");
    expect(tomlValue(environment.body, "NODE_VERSION")).toBe("24.20.0");
    expect(tomlValue(environment.body, "NPM_VERSION")).toBe("12.0.2");
  });

  it("uses a non-forced SPA fallback to the editor entry with status 200", () => {
    const redirects = tomlSections(netlifyToml).filter(
      (section) => section.header === "redirects",
    );
    const fallback = redirects.find(
      (section) => tomlValue(section.body, "from") === "/*",
    );
    expect(fallback, "SPA fallback redirect").toBeTruthy();
    expect(tomlValue(fallback!.body, "to")).toBe("/index.html");
    expect(tomlValue(fallback!.body, "status")).toBe("200");
    expect(
      fallback!.body.some((line) => /^\s*force\s*=/.test(line)),
      "SPA fallback must not be forced so real files shadow it",
    ).toBe(false);
  });

  it("caches hashed assets immutably", () => {
    const sections = tomlSections(netlifyToml);
    const assetHeaderIndex = sections.findIndex(
      (section) =>
        section.header === "headers" &&
        tomlValue(section.body, "for") === "/assets/*",
    );
    expect(assetHeaderIndex, "/assets/* header section").toBeGreaterThan(-1);
    const values = sections[assetHeaderIndex + 1];
    expect(values?.header, "[headers.values] under /assets/*").toBe(
      "headers.values",
    );
    expect(tomlValue(values!.body, "Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("applies nosniff globally", () => {
    const sections = tomlSections(netlifyToml);
    const globalHeaderIndex = sections.findIndex(
      (section) =>
        section.header === "headers" &&
        tomlValue(section.body, "for") === "/*",
    );
    expect(globalHeaderIndex, "global header section").toBeGreaterThan(-1);
    const values = sections[globalHeaderIndex + 1];
    expect(values?.header, "[headers.values] under /*").toBe(
      "headers.values",
    );
    expect(tomlValue(values!.body, "X-Content-Type-Options")).toBe("nosniff");
  });

  it("keeps the deployment static and secret-free", () => {
    assertStaticSecretFreeDeployment(netlifyToml);
  });

  it("rejects a secret key smuggled into [build.environment] (in-memory triangulation)", () => {
    // The tracked file must satisfy the guard unchanged...
    expect(() => assertStaticSecretFreeDeployment(netlifyToml)).not.toThrow();
    // ...and the guard must reject the shape a leaked secret would take: any
    // additional key in the [build.environment] table.
    const synthetic = netlifyToml.replace(
      "NPM_VERSION",
      'STRIPE_API_KEY = "sk_live_replace_me"\n  NPM_VERSION',
    );
    expect(synthetic, "synthetic mutation must apply").not.toBe(netlifyToml);
    expect(
      () => assertStaticSecretFreeDeployment(synthetic),
      "a secret key added to [build.environment] must fail the guard",
    ).toThrow();
  });

  it("rejects normalized TOML shapes that smuggle secrets (in-memory triangulation)", () => {
    // The tracked file must satisfy the guard unchanged...
    expect(() => assertStaticSecretFreeDeployment(netlifyToml)).not.toThrow();

    const secretLine = '  STRIPE_API_KEY = "sk_live_replace_me"';
    // Each shape is legal TOML that an exact-text header/key check misses:
    // whitespace around dotted-key separators, quoted keys, and context
    // environment tables. Soft expects report every bypass, not just the first.
    const bypasses: Array<[string, string]> = [
      [
        "spaced dotted table [build.environment . API]",
        `${netlifyToml}\n[build.environment . API]\n${secretLine}`,
      ],
      [
        "double-quoted key in [build.environment]",
        netlifyToml.replace(
          'NPM_VERSION = "12.0.2"',
          `  "STRIPE_API_KEY" = "sk_live_replace_me"\n  NPM_VERSION = "12.0.2"`,
        ),
      ],
      [
        "single-quoted key in [build.environment]",
        netlifyToml.replace(
          'NPM_VERSION = "12.0.2"',
          `  'STRIPE_API_KEY' = "sk_live_replace_me"\n  NPM_VERSION = "12.0.2"`,
        ),
      ],
      [
        "context environment table [context.production.environment]",
        `${netlifyToml}\n[context.production.environment]\n${secretLine}`,
      ],
    ];
    for (const [name, synthetic] of bypasses) {
      expect(synthetic, `${name}: mutation must apply`).not.toBe(netlifyToml);
      expect
        .soft(
          () => assertStaticSecretFreeDeployment(synthetic),
          `${name} must fail the guard`,
        )
        .toThrow();
    }
  });

  it("fails closed on inline environment tables and escaped-quote keys (in-memory triangulation)", () => {
    // The tracked file must satisfy the guard unchanged...
    expect(() => assertStaticSecretFreeDeployment(netlifyToml)).not.toThrow();

    // Each shape is legal TOML that the section-body scan misses:
    //  - an inline table assigned to a key named "environment" under [build]
    //    is an environment-shaped dotted path assigned as a value, so the
    //    [build.environment] section-body scan never sees its keys,
    //  - a key containing an escaped quote ("STRI\"PE_API_KEY") defeats the
    //    key regex, so the assignment line is silently skipped.
    // Soft expects report every bypass, not just the first.
    const bypasses: Array<[string, string]> = [
      [
        "inline environment table under [build]",
        netlifyToml.replace(
          "[build.environment]",
          '  environment = { STRIPE_API_KEY = "sk_live_replace_me" }\n\n[build.environment]',
        ),
      ],
      [
        "escaped quote inside a [build.environment] key",
        netlifyToml.replace(
          'NPM_VERSION = "12.0.2"',
          '  "STRI\\"PE_API_KEY" = "sk_live_replace_me"\n  NPM_VERSION = "12.0.2"',
        ),
      ],
    ];
    for (const [name, synthetic] of bypasses) {
      expect(synthetic, `${name}: mutation must apply`).not.toBe(netlifyToml);
      expect
        .soft(
          () => assertStaticSecretFreeDeployment(synthetic),
          `${name} must fail the guard`,
        )
        .toThrow();
    }
  });

  it("accepts legitimate TOML style and rejects literal secrets anywhere (in-memory triangulation)", () => {
    // The tracked file must satisfy the guard unchanged...
    expect(() => assertStaticSecretFreeDeployment(netlifyToml)).not.toThrow();

    // The environment bound is shape-based, so quoting, comments, whitespace,
    // indentation, and declaration order stay free: legitimate, Netlify-valid
    // style must never be rejected by it.
    const legitimate: Array<[string, string]> = [
      [
        "single-quoted pinned values",
        netlifyToml
          .replace('NODE_VERSION = "24.20.0"', "NODE_VERSION = '24.20.0'")
          .replace('NPM_VERSION = "12.0.2"', "NPM_VERSION = '12.0.2'"),
      ],
      [
        "trailing comment on a pinned value",
        netlifyToml.replace(
          'NPM_VERSION = "12.0.2"',
          'NPM_VERSION = "12.0.2" # build toolchain pin',
        ),
      ],
      [
        "extra whitespace around the separator",
        netlifyToml.replace(
          'NPM_VERSION = "12.0.2"',
          'NPM_VERSION   =   "12.0.2"',
        ),
      ],
      [
        "swapped pin order with tab indentation",
        netlifyToml.replace(
          '  NODE_VERSION = "24.20.0"\n  NPM_VERSION = "12.0.2"',
          '\tNPM_VERSION = "12.0.2"\n\tNODE_VERSION = "24.20.0"',
        ),
      ],
    ];
    for (const [name, synthetic] of legitimate) {
      expect(synthetic, `${name}: mutation must apply`).not.toBe(netlifyToml);
      expect
        .soft(
          () => assertStaticSecretFreeDeployment(synthetic),
          `${name} must stay accepted`,
        )
        .not.toThrow();
    }

    // A literal credential is rejected wherever it appears, independent of the
    // key that holds it: the environment bound alone cannot see a secret stored
    // in a command, in a header value, or in a comment.
    const leaks: Array<[string, string]> = [
      [
        "secret in the build command",
        netlifyToml.replace(
          'command = "npm run build"',
          'command = "STRIPE_API_KEY=sk_live_replace_me npm run build"',
        ),
      ],
      [
        "secret in a context command",
        `${netlifyToml}\n[context.production]\n  command = "sk_live_replace_me"\n`,
      ],
      [
        "secret in an extra header value",
        netlifyToml.replace(
          'X-Content-Type-Options = "nosniff"',
          'X-Content-Type-Options = "nosniff"\n    X-Api-Key = "sk_live_replace_me"',
        ),
      ],
      [
        "secret in a comment only",
        `${netlifyToml}\n# ghp_${"A".repeat(36)}\n`,
      ],
    ];
    for (const [name, synthetic] of leaks) {
      expect(synthetic, `${name}: mutation must apply`).not.toBe(netlifyToml);
      expect
        .soft(
          () => assertStaticSecretFreeDeployment(synthetic),
          `${name} must fail the guard`,
        )
        .toThrow();
    }

    // The sibling value reader tolerates the same legitimate style, so a pinned
    // value carrying a trailing comment or single quotes still reads as the pin.
    expect(
      tomlValue(["NPM_VERSION  =  '12.0.2' # toolchain pin"], "NPM_VERSION"),
    ).toBe("12.0.2");
    expect(
      tomlValue(['NODE_VERSION = "24.20.0" # runtime'], "NODE_VERSION"),
    ).toBe("24.20.0");
  });

  it("serves editor assets from root-absolute paths for deep fallback routes", () => {
    expect(viteConfigSource).toContain('base: "/"');
    expect(viteConfigSource).not.toContain('base: "./"');
  });
});
