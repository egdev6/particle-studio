import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const script = resolve(
  root,
  "packages/scene-document/scripts/generate-scene-document-v1-validator.ts",
);
const generated = resolve(
  root,
  "packages/scene-document/src/generated/scene-document-v1-validator.generated.mjs",
);
const expectedHash = generated.replace(/\.mjs$/, ".sha256");
const declaration = generated.replace(/\.mjs$/, ".d.mts");
const expectedContract = resolve(
  root,
  "packages/scene-document/src/validation/scene-document-v1-validator-contract.ts",
);
const scratch = resolve(
  root,
  "node_modules/.cache/particle-studio/scene-document-validator",
);

function run(mode: string, environment: NodeJS.ProcessEnv = {}) {
  return execFileSync(
    process.execPath,
    ["--experimental-strip-types", script, mode],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...environment },
    },
  );
}

function fails(mode: string, environment?: NodeJS.ProcessEnv) {
  expect(() => run(mode, environment)).toThrow();
}

afterEach(() => {
  run("clean");
});

describe("standalone validator generation", () => {
  it("retains a runtime-neutral declaration after validator cleanup", () => {
    run("clean");
    expect(existsSync(generated)).toBe(false);
    expect(existsSync(declaration)).toBe(true);

    const source = readFileSync(declaration, "utf8");
    expect(source).toMatch(/\btype\s+StandaloneValidationIssue\s*=/);
    expect(source).toMatch(
      /\breadonly\s+errors\s*:\s*readonly\s+StandaloneValidationIssue\[\]\s*\|\s*null/,
    );
    expect(source).toMatch(
      /\(\s*\(?\s*value\s*:\s*unknown\s*,?\s*\)\s*=>\s*boolean/,
    );
    expect(source).toMatch(
      /\bSCENE_DOCUMENT_V1_VALIDATOR_CONTRACT\s*:\s*string\s*;/,
    );
    expect(source).not.toMatch(/\b(?:import|from)\s+[^\n]*\bajv\b/i);
  });

  it("fails closed when preparation has no installed validator", () => {
    run("clean");
    fails("verify");
    expect(existsSync(generated)).toBe(false);
  });

  it("generates two deterministic candidates and verifies their installed bytes", () => {
    run("generate");
    run("verify");
    expect(lstatSync(generated).isFile()).toBe(true);
    expect(readFileSync(generated, "utf8")).toMatch(
      /SCENE_DOCUMENT_V1_VALIDATOR_CONTRACT/,
    );
  });

  it("rejects a stale loadable contract before validation is exposed", async () => {
    run("generate");
    const staleValidator = Object.assign(() => true, { errors: null });
    vi.resetModules();
    vi.doMock(
      "../src/generated/scene-document-v1-validator.generated.mjs",
      () => ({
        default: staleValidator,
        SCENE_DOCUMENT_V1_VALIDATOR_CONTRACT: "sha256:stale",
      }),
    );
    try {
      await expect(
        import("../src/validation/validate-scene-document.ts?stale"),
      ).rejects.toThrow("VALIDATOR_CONTRACT_MISMATCH");
    } finally {
      vi.doUnmock("../src/generated/scene-document-v1-validator.generated.mjs");
    }
  });

  it("rejects malformed expected values, byte drift, unequal candidates, and symlinks", () => {
    const originalHash = readFileSync(expectedHash, "utf8");
    const originalContract = readFileSync(expectedContract, "utf8");
    writeFileSync(expectedHash, "not-a-sha\n");
    fails("generate");
    writeFileSync(expectedHash, originalHash);
    writeFileSync(
      expectedContract,
      'export const EXPECTED_SCENE_DOCUMENT_V1_VALIDATOR_CONTRACT = "invalid";\n',
    );
    fails("generate");
    writeFileSync(expectedContract, originalContract);

    run("generate");
    writeFileSync(generated, `${readFileSync(generated, "utf8")}// altered\n`);
    fails("verify");
    run("clean");
    fails("generate", { PARTICLE_STUDIO_TEST_ALTER_SECOND_CANDIDATE: "1" });

    symlinkSync(expectedHash, generated);
    fails("verify");
    expect(existsSync(scratch)).toBe(false);
  });
});
