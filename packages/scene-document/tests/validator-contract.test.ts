import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as sceneDocument from "@particle-studio/scene-document";

const root = resolve(import.meta.dirname, "../../..");

describe("standalone validator contract", () => {
  it("keeps package exports at the root and rejects generated subpaths", () => {
    const manifest = JSON.parse(
      readFileSync(
        resolve(root, "packages/scene-document/package.json"),
        "utf8",
      ),
    ) as { exports: unknown };
    expect(manifest.exports).toEqual({ ".": "./src/index.ts" });
    expect(Object.keys(sceneDocument)).toEqual([
      "validateSceneDocument",
      "APPROVAL_ENVELOPE_IDENTIFIER",
      "APPROVAL_HASH_IDENTIFIER",
      "APPROVAL_POLICY_IDENTIFIER",
      "CANONICALIZATION_IDENTIFIER",
      "canonicalizeSceneDocument",
      "createApprovalEnvelope",
      "readCanonicalApprovalEvidence",
      "validateCanonicalApprovalEnvelope",
      "FIRST_SLICE_CANONICAL_HEX",
      "FIRST_SLICE_CANONICAL_SHA256",
      "FIRST_SLICE_DOCUMENT",
    ]);
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          "import('@particle-studio/scene-document/src/generated/scene-document-v1-validator.generated.mjs')",
        ],
        { cwd: root, encoding: "utf8" },
      ),
    ).toThrow(/ERR_PACKAGE_PATH_NOT_EXPORTED/);
  });
});
