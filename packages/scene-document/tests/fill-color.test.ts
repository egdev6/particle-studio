import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  FIRST_SLICE_CANONICAL_HEX,
  FIRST_SLICE_CANONICAL_SHA256,
  FIRST_SLICE_DOCUMENT,
  canonicalizeSceneDocument,
  createApprovalEnvelope,
  readCanonicalApprovalEvidence,
  validateCanonicalApprovalEnvelope,
  validateSceneDocument,
} from "../src/index.js";

type JsonRecord = Record<string, unknown>;

// Reviewed literal shape is exactly "#" plus six hex digits; letter case is
// authored data and must survive validation and canonicalization untouched.
const ACCEPTED_FILL_COLORS = ["#3fa9f5", "#3FA9F5", "#3fA9f5"] as const;

function acceptedDocument(value: unknown): JsonRecord {
  const result = validateSceneDocument(value);
  if (!result.ok) {
    throw new Error(`expected acceptance, received ${result.error.code}`);
  }
  return result.value as unknown as JsonRecord;
}

function rejectionCode(value: unknown): string {
  const result = validateSceneDocument(value);
  return result.ok ? "ACCEPTED" : result.error.code;
}

function canonicalJson(value: unknown): string {
  return new TextDecoder().decode(canonicalizeSceneDocument(value).bytes);
}

// The legacy first slice stays the single reviewed shape baseline.
function firstSliceDocument(): JsonRecord {
  return structuredClone(FIRST_SLICE_DOCUMENT) as unknown as JsonRecord;
}

function authoredShape(document: JsonRecord): JsonRecord {
  return (document.elements as JsonRecord[])[0]!;
}

function singleElementDocument(element: JsonRecord): JsonRecord {
  return {
    schemaVersion: 1,
    durationUs: 1_000_000,
    playbackRange: { startUs: 0, endUs: 1_000_000 },
    loop: true,
    seed: 7,
    rootIds: [element.id],
    elements: [element],
    tracks: [],
  };
}

// Each entry is a complete, valid non-shape element for the v1 baseline.
const NON_SHAPE_ELEMENTS: Array<[string, JsonRecord]> = [
  [
    "line",
    {
      id: "line-1",
      type: "line",
      x1: 0,
      y1: 0,
      x2: 120,
      y2: 80,
      opacity: 1,
    },
  ],
  ["group", { id: "group-1", type: "group", childrenIds: [] }],
  [
    "particle",
    {
      id: "particle-1",
      type: "particle",
      count: 2,
      x: 4,
      y: 8,
      velocityX: 12,
      velocityY: -6,
      spread: 3,
      size: 2,
      opacity: 0.5,
      lifetimeSteps: 3,
    },
  ],
  [
    "text",
    {
      id: "text-1",
      type: "text",
      text: "Hello Canvas",
      x: 4,
      y: 8,
      fontSize: 16,
      opacity: 0.5,
    },
  ],
  [
    "image",
    {
      id: "image-1",
      type: "image",
      x: 8,
      y: 16,
      width: 128,
      height: 64,
      opacity: 0.5,
      asset: {
        sha256: `sha256:${"0".repeat(64)}`,
        mimeType: "image/png",
        byteLength: 12_345,
        intrinsicWidth: 64,
        intrinsicHeight: 32,
      },
    },
  ],
];

describe("shape fillColor acceptance", () => {
  it.each(ACCEPTED_FILL_COLORS)(
    "accepts and preserves the seven-character literal %s",
    (fillColor) => {
      const document = firstSliceDocument();
      authoredShape(document).fillColor = fillColor;

      const validated = acceptedDocument(document);

      expect(authoredShape(validated).fillColor).toBe(fillColor);
      expect(authoredShape(validated).fillColor).toHaveLength(7);
      expect(canonicalJson(document)).toContain(`"fillColor":"${fillColor}"`);
    },
  );

  it("round-trips one authored shape without normalizing, inserting defaults, or mutating the caller", () => {
    const document = firstSliceDocument();
    Object.assign(authoredShape(document), {
      fillColor: "#3Fa9F5",
      transform: [1, 0, 0, 1, 4, 8],
      visible: true,
    });
    const authoredCopy = structuredClone(document);

    const reloaded = JSON.parse(canonicalJson(document)) as JsonRecord;

    expect(document).toEqual(authoredCopy);
    expect(reloaded.schemaVersion).toBe(1);
    expect(authoredShape(reloaded)).toEqual(authoredShape(document));
    expect(Object.keys(authoredShape(document))).toHaveLength(10);
    expect(authoredShape(document)).not.toHaveProperty("fillAlpha");
    expect(canonicalJson(reloaded)).toBe(canonicalJson(document));
  });

  it("keeps the legacy first-slice golden bytes, hash, and seven-key shape unchanged", () => {
    const document = firstSliceDocument();
    const canonical = canonicalizeSceneDocument(document);

    expect(acceptedDocument(document)).toEqual(FIRST_SLICE_DOCUMENT);
    expect(canonical.identifier).toBe("jcs-1");
    expect(Buffer.from(canonical.bytes).toString("hex")).toBe(
      FIRST_SLICE_CANONICAL_HEX,
    );
    expect(createHash("sha256").update(canonical.bytes).digest("hex")).toBe(
      FIRST_SLICE_CANONICAL_SHA256,
    );
    expect(Object.keys(authoredShape(document))).toHaveLength(7);
    expect(FIRST_SLICE_DOCUMENT.elements[0]).not.toHaveProperty("fillColor");
  });

  it("changes the approval snapshot hash when only the color literal changes", async () => {
    const lower = firstSliceDocument();
    authoredShape(lower).fillColor = "#3fa9f5";
    const upper = firstSliceDocument();
    authoredShape(upper).fillColor = "#3FA9F5";

    const approved = await createApprovalEnvelope({
      document: lower,
      runtimeVersion: "runtime-v1",
      verifiedAssetManifest: [],
    });
    const reapproved = await createApprovalEnvelope({
      document: upper,
      runtimeVersion: "runtime-v1",
      verifiedAssetManifest: [],
    });

    expect(validateCanonicalApprovalEnvelope(approved)).toBe(approved);
    expect(approved.envelope.document).toEqual(lower);
    expect(approved.snapshotHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(reapproved.snapshotHash).not.toBe(approved.snapshotHash);
    expect(
      readCanonicalApprovalEvidence(approved).canonicalDocumentBytes,
    ).toEqual(canonicalizeSceneDocument(lower).bytes);
  });

  it("imports an owned clone without mutating the caller's source or later imports", () => {
    const document = firstSliceDocument();
    authoredShape(document).fillColor = "#3Fa9F5";
    const source = JSON.stringify(document);

    const imported = validateSceneDocument.importEditableJson(source);
    if (!imported.ok) {
      throw new Error(`expected import success, received ${imported.error.code}`);
    }
    const importedValue = imported.value as unknown as JsonRecord;

    expect(importedValue).toEqual(document);
    expect(importedValue).not.toBe(document);
    authoredShape(importedValue).fillColor = "#000000";
    expect(validateSceneDocument.importEditableJson(source)).toEqual({
      ok: true,
      value: document,
    });
    expect(document).toEqual(JSON.parse(source));
  });

  it("exposes no public paint, color, or fill entrypoint for this slice", async () => {
    const keys = Object.keys(await import("../src/index.js"));
    expect(keys.filter((key) => /fill|color|paint/i.test(key))).toEqual([]);
  });
});

describe("shape fillColor rejection", () => {
  const rejectedFillColors: Array<[string, unknown]> = [
    ["a three-digit hex shorthand", "#3a9"],
    ["an eight-digit hex literal with alpha", "#3fa9f5ff"],
    ["a named color", "rebeccapurple"],
    ["leading whitespace", " #3fa9f5"],
    ["trailing whitespace", "#3fa9f5 "],
    ["a trailing newline", "#3fa9f5\n"],
    ["an embedded newline", "#3fa\n9f5"],
    ["a non-hex character", "#3fa9fg"],
    ["a bare hex literal without the marker", "3fa9f5"],
    ["a number", 0x3fa9f5],
    ["null", null],
    ["an array", ["#3fa9f5"]],
    ["an object", { hex: "#3fa9f5" }],
    ["a CSS function", "rgb(63, 169, 245)"],
  ];

  it.each(rejectedFillColors)("rejects %s", (_label, fillColor) => {
    const document = firstSliceDocument();
    authoredShape(document).fillColor = fillColor;

    expect(rejectionCode(document)).toBe("SCENE_DOCUMENT_INVALID");
  });

  it.each(NON_SHAPE_ELEMENTS)(
    "rejects fillColor on an otherwise valid %s element",
    (_type, element) => {
      const baseline = singleElementDocument(element);
      const withColor = singleElementDocument({
        ...element,
        fillColor: "#3fa9f5",
      });

      expect(acceptedDocument(baseline)).toEqual(baseline);
      expect(rejectionCode(withColor)).toBe("SCENE_DOCUMENT_INVALID");
    },
  );
});
