import { describe, expect, it } from "vitest";
import {
  canonicalizeSceneDocument,
  validateSceneDocument,
} from "@particle-studio/scene-document";

function validDocument() {
  return {
    schemaVersion: 1,
    durationUs: 1_000_000,
    playbackRange: { startUs: 0, endUs: 1_000_000 },
    loop: true,
    seed: 42,
    rootIds: ["shape-1"],
    elements: [
      {
        id: "shape-1",
        type: "shape",
        x: 0,
        y: 0,
        width: 120,
        height: 80,
        opacity: 1,
      },
    ],
    tracks: [
      {
        elementId: "shape-1",
        property: "opacity",
        interpolation: "linear",
        easing: "easeInOutQuad",
        keyframes: [
          { timeUs: 0, value: 0 },
          { timeUs: 1_000_000, value: 1 },
        ],
      },
    ],
  };
}

function expectInvalid(value: unknown, code: string) {
  expect(validateSceneDocument(value)).toEqual({ ok: false, error: { code } });
}

describe("validateSceneDocument", () => {
  it("accepts the selected shape slice through the package root", () => {
    const document: any = validDocument();

    expect(validateSceneDocument(document)).toEqual({
      ok: true,
      value: document,
    });
  });

  it.each(["linear", "easeInQuad", "easeOutQuad", "easeInOutQuad"])(
    "accepts the defined %s easing for a line",
    (easing) => {
      const document: any = validDocument();
      document.elements = [
        {
          id: "shape-1",
          type: "line",
          x1: 0,
          y1: 0,
          x2: 120,
          y2: 80,
          opacity: 1,
        },
      ];
      document.tracks[0].easing = easing;

      expect(validateSceneDocument(document)).toEqual({
        ok: true,
        value: document,
      });
    },
  );

  const invalidCases: Array<[string, (document: any) => void, string]> = [
    [
      "an absent version",
      (d) => delete d.schemaVersion,
      "SCENE_DOCUMENT_SCHEMA_VERSION_MISSING",
    ],
    [
      "an unsupported version",
      (d) => (d.schemaVersion = 2),
      "SCENE_DOCUMENT_SCHEMA_VERSION_UNSUPPORTED",
    ],
    ["an unknown field", (d) => (d.extra = true), "SCENE_DOCUMENT_INVALID"],
    [
      "a non-finite number",
      (d) => (d.elements[0].opacity = Infinity),
      "SCENE_DOCUMENT_INVALID",
    ],
    [
      "an unsafe duration",
      (d) => (d.durationUs = Number.MAX_SAFE_INTEGER + 1),
      "SCENE_DOCUMENT_INVALID",
    ],
    [
      "a non-positive duration",
      (d) => (d.durationUs = 0),
      "SCENE_DOCUMENT_INVALID",
    ],
    [
      "an invalid playback range",
      (d) => (d.playbackRange.startUs = d.playbackRange.endUs),
      "SCENE_DOCUMENT_INVALID",
    ],
    [
      "a range past duration",
      (d) => (d.playbackRange.endUs = d.durationUs + 1),
      "SCENE_DOCUMENT_INVALID",
    ],
    [
      "an invalid uint32 seed",
      (d) => (d.seed = 0x1_0000_0000),
      "SCENE_DOCUMENT_INVALID",
    ],
    [
      "an invalid stable ID",
      (d) => (d.elements[0].id = "bad id"),
      "SCENE_DOCUMENT_INVALID",
    ],
    [
      "duplicate primitive IDs",
      (d) => d.elements.push({ ...d.elements[0] }),
      "SCENE_DOCUMENT_INVALID",
    ],
    [
      "an unsupported primitive",
      (d) => (d.elements[0].type = "particleSystem"),
      "SCENE_DOCUMENT_INVALID",
    ],
    [
      "a second track",
      (d) => d.tracks.push(structuredClone(d.tracks[0])),
      "SCENE_DOCUMENT_INVALID",
    ],
    [
      "an unsupported property",
      (d) => (d.tracks[0].property = "x"),
      "SCENE_DOCUMENT_INVALID",
    ],
    [
      "an unsupported easing",
      (d) => (d.tracks[0].easing = "easeInCubic"),
      "SCENE_DOCUMENT_INVALID",
    ],
    [
      "a keyframe after duration",
      (d) => (d.tracks[0].keyframes[1].timeUs = d.durationUs + 1),
      "SCENE_DOCUMENT_INVALID",
    ],
    [
      "duplicate keyframe times",
      (d) => (d.tracks[0].keyframes[1].timeUs = 0),
      "SCENE_DOCUMENT_INVALID",
    ],
  ];

  it.each(invalidCases)("rejects %s", (_name, mutate, code) => {
    const document: any = validDocument();
    mutate(document);

    expectInvalid(document, code);
  });

  it("accepts multiple ordered opacity and text step tracks", () => {
    const document: any = validDocument();
    document.elements.push({
      id: "text-1",
      type: "text",
      text: "before",
      x: 4,
      y: 8,
      fontSize: 16,
      opacity: 1,
    });
    document.rootIds.push("text-1");
    document.tracks = [
      {
        ...document.tracks[0],
        keyframes: [
          { timeUs: 0, value: 0 },
          { timeUs: 250_000, value: 0.5 },
          { timeUs: 1_000_000, value: 1 },
        ],
      },
      {
        elementId: "text-1",
        property: "text.text",
        interpolation: "step",
        keyframes: [
          { timeUs: 0, value: "before" },
          { timeUs: 500_000, value: "after" },
        ],
      },
    ];

    expect(validateSceneDocument(document)).toEqual({
      ok: true,
      value: document,
    });
  });
});

describe("editable JSON capabilities", () => {
  it("rejects malformed JSON with a stable error", () => {
    expect(
      validateSceneDocument.importEditableJson('{"schemaVersion":'),
    ).toEqual({
      ok: false,
      error: { code: "SCENE_DOCUMENT_IMPORT_INVALID_JSON" },
    });
  });

  it("imports a valid v1 document as an isolated value", () => {
    const source = JSON.stringify(validDocument());
    const imported = validateSceneDocument.importEditableJson(source);

    expect(imported).toEqual({ ok: true, value: validDocument() });
    if (imported.ok) {
      imported.value.elements[0]!.opacity = 0;
    }
    expect(validateSceneDocument.importEditableJson(source)).toEqual({
      ok: true,
      value: validDocument(),
    });
  });

  it.each([
    ["a non-object", "[]"],
    ["a missing version", JSON.stringify({ durationUs: 1 })],
    [
      "a schema-invalid v1",
      JSON.stringify({ ...validDocument(), loop: "yes" }),
    ],
  ])("reports %s as a validation failure", (_name, json) => {
    expect(validateSceneDocument.importEditableJson(json)).toEqual({
      ok: false,
      error: { code: "SCENE_DOCUMENT_IMPORT_VALIDATION_FAILED" },
    });
  });

  it.each([2, 0, "1"])(
    "rejects schema version %s without a historical migrator",
    (schemaVersion) => {
      expect(
        validateSceneDocument.importEditableJson(
          JSON.stringify({ ...validDocument(), schemaVersion }),
        ),
      ).toEqual({
        ok: false,
        error: { code: "SCENE_DOCUMENT_IMPORT_SCHEMA_VERSION_UNSUPPORTED" },
      });
    },
  );

  it("exports canonical bytes through an import/export round trip", () => {
    const document = validDocument();
    const exported = canonicalizeSceneDocument.exportEditableJson(document);
    const reimported = validateSceneDocument.importEditableJson(
      new TextDecoder().decode(exported),
    );

    expect(new TextDecoder().decode(exported)).toBe(
      new TextDecoder().decode(
        canonicalizeSceneDocument.exportEditableJson(document),
      ),
    );
    expect(reimported).toEqual({ ok: true, value: document });
    exported[0] = 0;
    expect(
      new TextDecoder().decode(
        canonicalizeSceneDocument.exportEditableJson(document),
      ),
    ).toBe(
      new TextDecoder().decode(
        canonicalizeSceneDocument.exportEditableJson(validDocument()),
      ),
    );
  });
});
