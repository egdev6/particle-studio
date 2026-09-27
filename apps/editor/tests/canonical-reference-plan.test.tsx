import { describe, expect, it, vi } from "vitest";
import {
  canonicalizeSceneDocument,
  FIRST_SLICE_DOCUMENT,
  validateSceneDocument,
} from "@particle-studio/scene-document";
import { createCanonicalReferencePlan } from "../src/canonical-reference-plan.js";

const PNG_SHA256 =
  "sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
const OTHER_SHA256 = `sha256:${"f".repeat(64)}`;
const PNG_BYTES = new Uint8Array([1, 2, 3]);

function imageDocument(
  images: ReadonlyArray<{
    readonly id: string;
    readonly sha256?: string;
    readonly intrinsicWidth?: number;
  }>,
) {
  return {
    ...FIRST_SLICE_DOCUMENT,
    rootIds: images.map((image) => image.id),
    elements: images.map((image) => ({
      id: image.id,
      type: "image" as const,
      asset: {
        sha256: image.sha256 ?? PNG_SHA256,
        mimeType: "image/png" as const,
        byteLength: PNG_BYTES.byteLength,
        intrinsicWidth: image.intrinsicWidth ?? 20,
        intrinsicHeight: 10,
      },
      x: 0,
      y: 0,
      width: 20,
      height: 10,
      opacity: 1,
    })),
    tracks: [],
  };
}

describe("canonical editable JSON reference plan", () => {
  it("plans a valid no-reference document with frozen isolated canonical output", () => {
    const source = structuredClone(FIRST_SLICE_DOCUMENT);
    const input = JSON.stringify(source);
    const result = createCanonicalReferencePlan(input);
    (source.elements[0] as { id: string }).id = "caller-mutated";

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.references).toEqual([]);
    expect(result.value.canonicalEditableJson).toBe(
      new TextDecoder().decode(
        canonicalizeSceneDocument.exportEditableJson(FIRST_SLICE_DOCUMENT),
      ),
    );
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.document)).toBe(true);
    expect(Object.isFrozen(result.value.references)).toBe(true);
    expect(result.value.document).toMatchObject(FIRST_SLICE_DOCUMENT);

    const roundTrip = createCanonicalReferencePlan(
      result.value.canonicalEditableJson,
    );
    expect(roundTrip).toEqual(result);
  });

  it("enumerates image assets in document order and deduplicates equal declarations", () => {
    const result = createCanonicalReferencePlan(
      JSON.stringify(
        imageDocument([
          { id: "image-b" },
          { id: "image-b-repeat" },
          { id: "image-a", sha256: OTHER_SHA256 },
        ]),
      ),
    );

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.references).toEqual([
      {
        elementId: "image-b",
        sha256: PNG_SHA256,
        mimeType: "image/png",
        byteLength: PNG_BYTES.byteLength,
        intrinsicWidth: 20,
        intrinsicHeight: 10,
      },
      {
        elementId: "image-a",
        sha256: OTHER_SHA256,
        mimeType: "image/png",
        byteLength: PNG_BYTES.byteLength,
        intrinsicWidth: 20,
        intrinsicHeight: 10,
      },
    ]);
    expect(Object.isFrozen(result.value.references[0])).toBe(true);
    expect(() => {
      (result.value.references[0] as { elementId: string }).elementId =
        "changed";
    }).toThrow(TypeError);
    expect(
      createCanonicalReferencePlan(result.value.canonicalEditableJson),
    ).toEqual(result);
  });

  it("rejects conflicting metadata for one content declaration with a stable error", () => {
    const result = createCanonicalReferencePlan(
      JSON.stringify(
        imageDocument([
          { id: "image-a" },
          { id: "image-b", intrinsicWidth: 21 },
        ]),
      ),
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "SCENE_DOCUMENT_REFERENCE_METADATA_CONFLICT" },
    });
  });

  it("preserves accepted editable JSON import failures without planning references", () => {
    const imports = [
      "not JSON",
      JSON.stringify({ ...FIRST_SLICE_DOCUMENT, schemaVersion: 2 }),
      JSON.stringify({ ...FIRST_SLICE_DOCUMENT, unknown: true }),
    ];

    for (const editableJson of imports) {
      const expected = validateSceneDocument.importEditableJson(editableJson);
      const exportEditableJson = vi.fn(() => new Uint8Array());
      expect(
        createCanonicalReferencePlan(editableJson, {
          importEditableJson: validateSceneDocument.importEditableJson,
          exportEditableJson,
        }),
      ).toEqual(expected);
      expect(exportEditableJson).not.toHaveBeenCalled();
    }
  });
});
