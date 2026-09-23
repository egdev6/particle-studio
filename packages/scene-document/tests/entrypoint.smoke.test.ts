import { describe, expect, it } from "vitest";

describe("scene-document package entrypoint", () => {
  it("exposes only the approved root validation and canonicalization APIs", async () => {
    const entrypoint = await import("../src/index.js");

    expect(Object.keys(entrypoint)).toEqual([
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
    expect(entrypoint.validateSceneDocument({})).toEqual({
      ok: false,
      error: { code: "SCENE_DOCUMENT_SCHEMA_VERSION_MISSING" },
    });
  });
});
