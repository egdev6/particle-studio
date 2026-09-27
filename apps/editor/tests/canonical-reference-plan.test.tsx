import { describe, expect, it, vi } from "vitest";
import {
  canonicalizeSceneDocument,
  FIRST_SLICE_DOCUMENT,
  validateSceneDocument,
} from "@particle-studio/scene-document";
import {
  createCanonicalReferencePlan,
  type CanonicalReferencePlanDependencies,
} from "../src/canonical-reference-plan.js";

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

const HOSTILE_PLANNER_FAILURE = {
  ok: false as const,
  error: { code: "SCENE_DOCUMENT_REFERENCE_PLAN_DEPENDENCY_FAILED" },
};

function hostilePlanDependencies(
  dependencies: Record<string, unknown>,
): CanonicalReferencePlanDependencies {
  return dependencies as unknown as CanonicalReferencePlanDependencies;
}

function expectStableHostilePlannerFailure(
  dependencies: CanonicalReferencePlanDependencies,
  privateDetail: string,
): void {
  const result = createCanonicalReferencePlan("ignored", dependencies);

  expect(result).toEqual(HOSTILE_PLANNER_FAILURE);
  expect(JSON.stringify(result)).not.toContain(privateDetail);
}

describe("hostile canonical reference planner dependencies", () => {
  it("returns fresh frozen dependency failures that cannot poison later calls", () => {
    const dependencies = hostilePlanDependencies({
      importEditableJson: () => ({ ok: true, value: FIRST_SLICE_DOCUMENT }),
      exportEditableJson: () => "invalid",
    });
    const first = createCanonicalReferencePlan("ignored", dependencies);
    if (first.ok) throw new Error("expected dependency failure");
    expect(Object.isFrozen(first) && Object.isFrozen(first.error)).toBe(true);
    expect(() => {
      (first.error as { code: string }).code = "poisoned";
    }).toThrow(TypeError);
    const next = createCanonicalReferencePlan("ignored", dependencies);
    expect(next).toEqual(HOSTILE_PLANNER_FAILURE);
    expect(next).not.toBe(first);
  });

  it.each([
    [
      "throwing importer call",
      "private importer call",
      () => ({
        importEditableJson() {
          throw new Error("private importer call");
        },
        exportEditableJson: canonicalizeSceneDocument.exportEditableJson,
      }),
    ],
    [
      "throwing importer dependency getter",
      "private importer getter",
      () =>
        Object.defineProperty(
          { exportEditableJson: canonicalizeSceneDocument.exportEditableJson },
          "importEditableJson",
          {
            get() {
              throw new Error("private importer getter");
            },
          },
        ),
    ],
    [
      "revoked importer dependency proxy",
      "private revoked importer",
      () => {
        const revoked = Proxy.revocable(
          {
            importEditableJson: validateSceneDocument.importEditableJson,
            exportEditableJson: canonicalizeSceneDocument.exportEditableJson,
          },
          {},
        );
        revoked.revoke();
        return revoked.proxy;
      },
    ],
    [
      "malformed success result",
      "private malformed success",
      () => ({
        importEditableJson: () => ({ ok: true }),
        exportEditableJson: canonicalizeSceneDocument.exportEditableJson,
      }),
    ],
    [
      "throwing importer result discriminant",
      "private result getter",
      () => ({
        importEditableJson: () =>
          Object.defineProperty({}, "ok", {
            get() {
              throw new Error("private result getter");
            },
          }),
        exportEditableJson: canonicalizeSceneDocument.exportEditableJson,
      }),
    ],
    [
      "throwing imported value getter",
      "private value getter",
      () => ({
        importEditableJson: () =>
          Object.defineProperties(
            { ok: true },
            {
              value: {
                get() {
                  throw new Error("private value getter");
                },
              },
            },
          ),
        exportEditableJson: canonicalizeSceneDocument.exportEditableJson,
      }),
    ],
    [
      "malformed image-elements iterable",
      "private elements iterable",
      () => ({
        importEditableJson: () => ({
          ok: true,
          value: { elements: { [Symbol.iterator]: 3 } },
        }),
        exportEditableJson: canonicalizeSceneDocument.exportEditableJson,
      }),
    ],
    [
      "throwing planned element getter",
      "private element getter",
      () => ({
        importEditableJson: () => ({
          ok: true,
          value: {
            elements: [
              Object.defineProperty({}, "type", {
                get() {
                  throw new Error("private element getter");
                },
              }),
            ],
          },
        }),
        exportEditableJson: canonicalizeSceneDocument.exportEditableJson,
      }),
    ],
    [
      "throwing planned asset getter",
      "private asset getter",
      () => {
        const document = imageDocument([{ id: "image-a" }]);
        Object.defineProperty(document.elements[0]!, "asset", {
          get() {
            throw new Error("private asset getter");
          },
        });
        return {
          importEditableJson: () => ({ ok: true, value: document }),
          exportEditableJson: canonicalizeSceneDocument.exportEditableJson,
        };
      },
    ],
    [
      "throwing canonical exporter",
      "private exporter call",
      () => ({
        importEditableJson: () => ({ ok: true, value: FIRST_SLICE_DOCUMENT }),
        exportEditableJson() {
          throw new Error("private exporter call");
        },
      }),
    ],
    [
      "throwing exporter dependency getter",
      "private exporter getter",
      () =>
        Object.defineProperty(
          {
            importEditableJson: () => ({
              ok: true,
              value: FIRST_SLICE_DOCUMENT,
            }),
          },
          "exportEditableJson",
          {
            get() {
              throw new Error("private exporter getter");
            },
          },
        ),
    ],
    [
      "non-byte canonical exporter output",
      "private exporter output",
      () => ({
        importEditableJson: () => ({ ok: true, value: FIRST_SLICE_DOCUMENT }),
        exportEditableJson: () => "private exporter output",
      }),
    ],
    [
      "ArrayBuffer canonical exporter output",
      "private exporter output",
      () => ({
        importEditableJson: () => ({ ok: true, value: FIRST_SLICE_DOCUMENT }),
        exportEditableJson: () => new ArrayBuffer(0),
      }),
    ],
    [
      "DataView canonical exporter output",
      "private exporter output",
      () => ({
        importEditableJson: () => ({ ok: true, value: FIRST_SLICE_DOCUMENT }),
        exportEditableJson: () => new DataView(new ArrayBuffer(0)),
      }),
    ],
  ])(
    "normalizes %s without leaking injected details",
    (_label, privateDetail, createDependencies) => {
      expectStableHostilePlannerFailure(
        hostilePlanDependencies(createDependencies()),
        privateDetail,
      );
    },
  );

  it("returns an accepted P2a import failure exactly and never exports", () => {
    const acceptedFailure = {
      ok: false as const,
      error: { code: "P2A_IMPORT_FAILED", message: "ordinary P2a error" },
    };
    const exportEditableJson = vi.fn();

    const result = createCanonicalReferencePlan(
      "ignored",
      hostilePlanDependencies({
        importEditableJson: () => acceptedFailure,
        exportEditableJson,
      }),
    );

    expect(result).toBe(acceptedFailure);
    expect(result).toEqual(acceptedFailure);
    expect(exportEditableJson).not.toHaveBeenCalled();
  });
});
