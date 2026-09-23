import { describe, expect, it } from "vitest";
import {
  canonicalizeSceneDocument,
  validateSceneDocument,
} from "@particle-studio/scene-document";

function nestedDocument() {
  return {
    schemaVersion: 1,
    durationUs: 1_000_000,
    playbackRange: { startUs: 0, endUs: 1_000_000 },
    loop: true,
    seed: 42,
    rootIds: ["background", "group-1"],
    elements: [
      {
        id: "background",
        type: "shape",
        x: 0,
        y: 0,
        width: 320,
        height: 180,
        opacity: 1,
      },
      {
        id: "group-1",
        type: "group",
        childrenIds: ["line-1", "group-2"],
        transform: [1, 0, 0, 1, 10, 20],
        visible: false,
      },
      {
        id: "line-1",
        type: "line",
        x1: 0,
        y1: 0,
        x2: 120,
        y2: 80,
        opacity: 1,
      },
      {
        id: "group-2",
        type: "group",
        childrenIds: ["shape-1"],
      },
      {
        id: "shape-1",
        type: "shape",
        x: 16,
        y: 24,
        width: 120,
        height: 80,
        opacity: 0.75,
        transform: [1, 0, 0, 1, -4, 8],
        visible: true,
      },
    ],
    tracks: [
      {
        elementId: "shape-1",
        property: "opacity",
        interpolation: "linear",
        easing: "linear",
        keyframes: [
          { timeUs: 0, value: 0.25 },
          { timeUs: 1_000_000, value: 0.75 },
        ],
      },
    ],
  };
}

describe("SceneDocument hierarchy contract", () => {
  it("accepts nested groups and preserves hierarchy bytes across canonical reload", () => {
    const document = nestedDocument();
    const original = structuredClone(document);
    const validated = validateSceneDocument(document);

    expect(validated).toEqual({ ok: true, value: document });
    expect(document).toEqual(original);

    const first = canonicalizeSceneDocument(document).bytes;
    const reloaded = JSON.parse(new TextDecoder().decode(first));

    expect(validateSceneDocument(reloaded)).toEqual({
      ok: true,
      value: reloaded,
    });
    expect(canonicalizeSceneDocument(reloaded).bytes).toEqual(first);
    expect(reloaded.rootIds).toEqual(["background", "group-1"]);
    expect(reloaded.elements[1]).toMatchObject({
      id: "group-1",
      childrenIds: ["line-1", "group-2"],
    });
  });

  it("accepts particles with owned group membership and rejects invalid particle contracts", () => {
    const particle = {
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
    };
    const document: any = nestedDocument();
    document.elements[1].childrenIds = ["line-1", "group-2", "particle-1"];
    document.elements.push(particle);

    expect(validateSceneDocument(document)).toEqual({
      ok: true,
      value: document,
    });
    expect(
      validateSceneDocument({
        ...document,
        elements: [
          ...document.elements,
          { ...particle, id: "particle-2", count: 0 },
        ],
      }),
    ).toEqual({ ok: false, error: { code: "SCENE_DOCUMENT_INVALID" } });
    expect(
      validateSceneDocument({
        ...document,
        elements: [
          ...document.elements.slice(0, -1),
          { ...particle, spread: Infinity },
        ],
      }),
    ).toEqual({ ok: false, error: { code: "SCENE_DOCUMENT_INVALID" } });
    expect(
      validateSceneDocument({
        ...document,
        tracks: [{ ...document.tracks[0], elementId: "particle-1" }],
      }),
    ).toMatchObject({ ok: true });
    for (const invalid of [
      { ...particle, count: 1_001 },
      { ...particle, lifetimeSteps: 0 },
      { ...particle, velocityX: Infinity },
      { ...particle, size: 0 },
      { ...particle, opacity: 1.1 },
      { ...particle, unexpected: true },
    ])
      expect(
        validateSceneDocument({
          ...document,
          elements: [...document.elements.slice(0, -1), invalid],
        }),
      ).toEqual({ ok: false, error: { code: "SCENE_DOCUMENT_INVALID" } });
    const reloaded = JSON.parse(
      new TextDecoder().decode(canonicalizeSceneDocument(document).bytes),
    );
    expect(validateSceneDocument(reloaded)).toEqual({
      ok: true,
      value: reloaded,
    });
  });

  it("accepts text leaves while rejecting malformed text records", () => {
    const document: any = nestedDocument();
    const text = {
      id: "text-1",
      type: "text",
      text: "Hello Canvas",
      x: 4,
      y: 12,
      fontSize: 18,
      opacity: 0.5,
    };
    document.elements[1].childrenIds.push("text-1");
    document.elements.push(text);

    expect(validateSceneDocument(document)).toEqual({
      ok: true,
      value: document,
    });
    for (const invalid of [
      { ...text, text: "line\nbreak" },
      { ...text, text: "" },
      { ...text, x: Infinity },
      { ...text, fontSize: 0 },
      { ...text, opacity: 1.1 },
      { ...text, unexpected: true },
    ])
      expect(
        validateSceneDocument({
          ...document,
          elements: [...document.elements.slice(0, -1), invalid],
        }),
      ).toEqual({ ok: false, error: { code: "SCENE_DOCUMENT_INVALID" } });
    expect(
      validateSceneDocument({
        ...document,
        tracks: [{ ...document.tracks[0], elementId: "text-1" }],
      }),
    ).toMatchObject({ ok: true });
  });

  it("accepts immutable PNG image references without mutating their hierarchy data", () => {
    const document: any = nestedDocument();
    const image = {
      id: "image-1",
      type: "image",
      asset: {
        sha256:
          "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        mimeType: "image/png",
        byteLength: 12_345,
        intrinsicWidth: 64,
        intrinsicHeight: 32,
      },
      x: 8,
      y: 16,
      width: 128,
      height: 64,
      opacity: 0.5,
      transform: [1, 0, 0, 1, 4, 8],
      visible: true,
    };
    document.elements[1].childrenIds.push(image.id);
    document.elements.push(image);
    const original = structuredClone(document);

    expect(validateSceneDocument(document)).toEqual({
      ok: true,
      value: document,
    });
    expect(document).toEqual(original);

    const reloaded = JSON.parse(
      new TextDecoder().decode(canonicalizeSceneDocument(document).bytes),
    );
    expect(reloaded.rootIds).toEqual(["background", "group-1"]);
    expect(reloaded.elements[1]).toMatchObject({
      id: "group-1",
      childrenIds: ["line-1", "group-2", "image-1"],
    });
    expect(reloaded.elements.at(-1)).toEqual(image);
    expect(validateSceneDocument(reloaded)).toEqual({
      ok: true,
      value: reloaded,
    });
  });

  it("rejects malformed and mutable image boundaries", () => {
    const document: any = nestedDocument();
    const image = {
      id: "image-1",
      type: "image",
      asset: {
        sha256:
          "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        mimeType: "image/png",
        byteLength: 12_345,
        intrinsicWidth: 64,
        intrinsicHeight: 32,
      },
      x: 8,
      y: 16,
      width: 128,
      height: 64,
      opacity: 0.5,
    };
    document.elements[1].childrenIds.push(image.id);
    document.elements.push(image);

    for (const invalid of [
      { ...image, asset: { ...image.asset, sha256: "sha256:ABC" } },
      { ...image, asset: { ...image.asset, sha256: "sha512:0123" } },
      { ...image, asset: { ...image.asset, mimeType: "image/jpeg" } },
      { ...image, asset: { ...image.asset, byteLength: 0 } },
      {
        ...image,
        asset: { ...image.asset, byteLength: Number.MAX_SAFE_INTEGER + 1 },
      },
      { ...image, asset: { ...image.asset, intrinsicWidth: 0 } },
      {
        ...image,
        asset: { ...image.asset, intrinsicHeight: Number.MAX_SAFE_INTEGER + 1 },
      },
      { ...image, asset: { ...image.asset, originalFilename: "mutable.png" } },
      { ...image, width: 0 },
      { ...image, height: Infinity },
      { ...image, x: Infinity },
      { ...image, y: Infinity },
      { ...image, opacity: Infinity },
      { ...image, unexpected: true },
    ]) {
      expect(
        validateSceneDocument({
          ...document,
          elements: [...document.elements.slice(0, -1), invalid],
        }),
      ).toEqual({ ok: false, error: { code: "SCENE_DOCUMENT_INVALID" } });
    }

    expect(
      validateSceneDocument({
        ...document,
        tracks: [{ ...document.tracks[0], elementId: image.id }],
      }),
    ).toMatchObject({ ok: true });
  });

  it("preserves optional identity transform and visible defaults without materializing them", () => {
    const document = nestedDocument();
    const line = document.elements[2]!;
    const group = document.elements[3]!;

    expect(validateSceneDocument(document)).toEqual({
      ok: true,
      value: document,
    });
    expect(line).not.toHaveProperty("transform");
    expect(line).not.toHaveProperty("visible");

    const reloaded = JSON.parse(
      new TextDecoder().decode(canonicalizeSceneDocument(document).bytes),
    );
    expect(reloaded.elements[2]).not.toHaveProperty("transform");
    expect(reloaded.elements[2]).not.toHaveProperty("visible");
    expect(group).not.toHaveProperty("transform");
    expect(group).not.toHaveProperty("visible");
  });

  const invalidCases: Array<[string, (document: any) => void]> = [
    ["duplicate element IDs", (d) => (d.elements[2].id = "background")],
    ["duplicate roots", (d) => (d.rootIds = ["background", "background"])],
    ["missing roots", (d) => (d.rootIds[1] = "missing")],
    ["an unowned element", (d) => (d.elements[1].childrenIds = ["group-2"])],
    ["an element owned by a root and group", (d) => d.rootIds.push("line-1")],
    ["a group without children", (d) => delete d.elements[1].childrenIds],
    [
      "duplicate group children",
      (d) => (d.elements[1].childrenIds = ["line-1", "line-1"]),
    ],
    [
      "an unknown group child",
      (d) => (d.elements[1].childrenIds = ["missing"]),
    ],
    [
      "a self-parenting group",
      (d) => (d.elements[1].childrenIds = ["group-1"]),
    ],
    [
      "a group cycle",
      (d) => {
        d.rootIds = ["background"];
        d.elements[3].childrenIds = ["group-1"];
      },
    ],
    ["a group opacity track", (d) => (d.tracks[0].elementId = "group-1")],
    ["a forbidden parent ID", (d) => (d.elements[2].parentId = "group-1")],
    [
      "a short affine tuple",
      (d) => (d.elements[1].transform = [1, 0, 0, 1, 0]),
    ],
    [
      "a non-finite affine tuple",
      (d) => (d.elements[1].transform = [1, 0, 0, 1, Infinity, 0]),
    ],
    [
      "a particle payload",
      (d) => (d.elements[2] = { id: "line-1", type: "particle" }),
    ],
    [
      "an image payload",
      (d) => (d.elements[2] = { id: "line-1", type: "image" }),
    ],
  ];

  it.each(invalidCases)("rejects %s", (_name, mutate) => {
    const document: any = nestedDocument();
    mutate(document);

    expect(validateSceneDocument(document)).toEqual({
      ok: false,
      error: { code: "SCENE_DOCUMENT_INVALID" },
    });
  });
});
