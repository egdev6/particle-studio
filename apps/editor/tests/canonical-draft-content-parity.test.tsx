import { describe, expect, it } from "vitest";
import { canonicalizeSceneDocument, FIRST_SLICE_DOCUMENT } from "@particle-studio/scene-document";
import { createCompleteRevision } from "@particle-studio/persistence";
import { createCanonicalReferencePlan } from "../src/canonical-reference-plan.js";
import { readCanonicalDraftContentParity } from "../src/canonical-draft-content-parity.js";
import type { ReferencedRevisionEnvelope } from "../src/referenced-revision-envelope.js";

const stored = () => createCompleteRevision({ documentId: "doc", revisionId: "rev", sequence: 3, document: FIRST_SLICE_DOCUMENT });
const envelope = (): ReferencedRevisionEnvelope => {
  const revision = stored();
  return { documentId: revision.documentId, revisionId: revision.revisionId,
    sequence: revision.sequence, document: revision.document,
    canonicalization: revision.canonicalization, canonicalBytes: revision.canonicalBytes };
};
const withCanonicalBytes = (canonicalBytes: Uint8Array): ReferencedRevisionEnvelope => {
  const original = envelope();
  return { ...original, canonicalBytes,
    canonicalization: { ...original.canonicalization, byteLength: canonicalBytes.byteLength } };
};
const failure = "EDITOR_REFERENCED_REVISION_RELOAD_FAILED";

describe("canonical draft content parity", () => {
  it("returns an isolated frozen plan and genuine revision without persistence access", () => {
    const input = envelope();
    const result = readCanonicalDraftContentParity(input);
    expect(result.plan.document).toEqual(FIRST_SLICE_DOCUMENT);
    expect(result.revision.document).toEqual(FIRST_SLICE_DOCUMENT);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(Object.isFrozen(result.plan.document)).toBe(true);
    const initial = result.revision.canonicalBytes[0];
    result.revision.canonicalBytes[0] = 0;
    expect(result.revision.canonicalBytes[0]).toBe(initial);
    input.canonicalBytes[0] = 0;
    expect(result.revision.canonicalBytes[0]).toBe(initial);
  });

  it("retains a validated image reference without hydrating any asset", () => {
    const sha256 = `sha256:${"f".repeat(64)}`;
    const document = { ...FIRST_SLICE_DOCUMENT, rootIds: ["image-1"], tracks: [],
      elements: [{ id: "image-1", type: "image" as const,
        asset: { sha256, mimeType: "image/png" as const, byteLength: 3, intrinsicWidth: 20, intrinsicHeight: 10 },
        x: 0, y: 0, width: 20, height: 10, opacity: 1 }] };
    const revision = createCompleteRevision({ documentId: "doc", revisionId: "rev", sequence: 3, document });
    const result = readCanonicalDraftContentParity({ documentId: "doc", revisionId: "rev", sequence: 3,
      document: revision.document, canonicalization: revision.canonicalization, canonicalBytes: revision.canonicalBytes });
    expect(result.plan.references).toEqual([{ elementId: "image-1", sha256, mimeType: "image/png",
      byteLength: 3, intrinsicWidth: 20, intrinsicHeight: 10 }]);
    expect(Object.isFrozen(result.plan.references)).toBe(true);
  });

  it("snapshots bytes through the envelope getter exactly once", () => {
    const input = envelope();
    const bytes = input.canonicalBytes;
    let reads = 0;
    Object.defineProperty(input, "canonicalBytes", { get() { reads++; return reads === 1 ? bytes : new Uint8Array(); } });
    expect(readCanonicalDraftContentParity(input).plan.document).toEqual(FIRST_SLICE_DOCUMENT);
    expect(reads).toBe(1);
  });

  it.each([
    ["invalid UTF-8", () => withCanonicalBytes(new Uint8Array([0xff]))],
    ["invalid schema", () => withCanonicalBytes(new TextEncoder().encode("{}"))],
    ["noncanonical whitespace", () => withCanonicalBytes(new TextEncoder().encode(` ${new TextDecoder().decode(stored().canonicalBytes)}`))],
    ["BOM", () => withCanonicalBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...stored().canonicalBytes]))],
    ["document divergence", () => ({ ...envelope(), document: { ...FIRST_SLICE_DOCUMENT, seed: FIRST_SLICE_DOCUMENT.seed + 1 } })],
    ["plan failure", () => {
      const sha256 = `sha256:${"f".repeat(64)}`;
      const image = (id: string, byteLength: number) => ({ id, type: "image" as const,
        asset: { sha256, mimeType: "image/png" as const, byteLength, intrinsicWidth: 20, intrinsicHeight: 10 },
        x: 0, y: 0, width: 20, height: 10, opacity: 1 });
      const document = { ...FIRST_SLICE_DOCUMENT, rootIds: ["a", "b"], tracks: [],
        elements: [image("a", 3), image("b", 4)] };
      const canonicalBytes = canonicalizeSceneDocument(document).bytes;
      expect(createCanonicalReferencePlan(new TextDecoder().decode(canonicalBytes))).toEqual({
        ok: false, error: { code: "SCENE_DOCUMENT_REFERENCE_METADATA_CONFLICT" },
      });
      return { ...withCanonicalBytes(canonicalBytes), document };
    }],
  ] as const)("rejects %s with one public error", (_name, make) => {
    const input = make();
    try {
      readCanonicalDraftContentParity(input);
      throw Error("expected rejection");
    } catch (error) {
      expect((error as Error).message).toBe(failure);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });

  it("maps malformed envelopes and hostile byte accessors to the same error", () => {
    for (const input of [null, Object.defineProperty(envelope(), "canonicalBytes", {
      get() { throw Error("private detail"); },
    })]) {
      expect(() => readCanonicalDraftContentParity(input as ReferencedRevisionEnvelope)).toThrow(failure);
    }
  });

  it("preserves the planner's canonical text", () => {
    const result = readCanonicalDraftContentParity(envelope());
    const planned = createCanonicalReferencePlan(new TextDecoder().decode(stored().canonicalBytes));
    expect(planned.ok).toBe(true);
    if (planned.ok) expect(result.plan.canonicalEditableJson).toBe(planned.value.canonicalEditableJson);
  });
});
