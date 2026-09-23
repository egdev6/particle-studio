import { describe, expect, it } from "vitest";

import {
  canonicalizeSceneDocument,
  FIRST_SLICE_DOCUMENT,
  type SceneDocumentV1,
  validateSceneDocument,
} from "@particle-studio/scene-document";
import {
  createTimelineTransport,
  deriveCompletedStep,
  evaluateScene,
  RUNTIME_VERSION,
} from "@particle-studio/runtime";

function documentWithTrack(
  easing: "linear" | "easeInQuad" | "easeOutQuad" | "easeInOutQuad",
  keyframes = [
    { timeUs: 0, value: 0.25 },
    { timeUs: 1_000_000, value: 0.75 },
  ],
): SceneDocumentV1 {
  return {
    ...FIRST_SLICE_DOCUMENT,
    elements: FIRST_SLICE_DOCUMENT.elements.map((element) => ({ ...element })),
    tracks: [{ ...FIRST_SLICE_DOCUMENT.tracks[0], easing, keyframes }],
  } as SceneDocumentV1;
}

function reload(document: SceneDocumentV1): SceneDocumentV1 {
  const bytes = canonicalizeSceneDocument(document).bytes;
  const result = validateSceneDocument(
    JSON.parse(new TextDecoder().decode(bytes)),
  );
  if (!result.ok) throw new Error("fixture reload must validate");
  return result.value;
}

describe("runtime first-slice evaluator", () => {
  it("exposes only the stable DOM-free runtime contract", async () => {
    const entrypoint = await import("@particle-studio/runtime");

    expect(Object.keys(entrypoint)).toEqual([
      "RUNTIME_VERSION",
      "deriveCompletedStep",
      "createTimelineTransport",
      "evaluateScene",
    ]);
    expect(RUNTIME_VERSION).toBe("particle-studio-runtime-v1");
  });

  it("evaluates fixture opacity at explicit microsecond samples", () => {
    const samples = [0, 250_000, 500_000, 750_000, 1_000_000];

    expect(
      samples.map(
        (timeUs) =>
          evaluateScene(FIRST_SLICE_DOCUMENT, timeUs).state.elements[0]
            ?.opacity,
      ),
    ).toEqual([0.25, 0.3125, 0.5, 0.6875, 0.75]);
  });

  it("derives rational 60 Hz completed steps without accumulated floating time", () => {
    expect(deriveCompletedStep(16_666)).toBe(0);
    expect(deriveCompletedStep(16_667)).toBe(1);
    expect(deriveCompletedStep(1_000_000)).toBe(60);
    expect(deriveCompletedStep(9_007_199_254_733_333)).toBe(540_431_955_283);
  });

  it("rejects invalid explicit seek times with one stable error", () => {
    for (const timeUs of [-1, 0.5, 1_000_001]) {
      expect(() => evaluateScene(FIRST_SLICE_DOCUMENT, timeUs)).toThrow(
        "RUNTIME_TIME_US_INVALID",
      );
    }
  });

  it("produces finite evaluated state and exact ordered shape commands", () => {
    expect(evaluateScene(FIRST_SLICE_DOCUMENT, 500_000)).toEqual({
      state: {
        timeUs: 500_000,
        completedStep: 30,
        elements: [
          {
            id: "shape-1",
            type: "shape",
            x: 16,
            y: 24,
            width: 120,
            height: 80,
            opacity: 0.5,
          },
        ],
      },
      commands: [
        {
          kind: "draw-shape",
          sourceId: "shape-1",
          x: 16,
          y: 24,
          width: 120,
          height: 80,
          opacity: 0.5,
        },
      ],
    });
  });

  it("applies every accepted easing and holds numeric endpoints", () => {
    expect(
      ["linear", "easeInQuad", "easeOutQuad", "easeInOutQuad"].map(
        (easing) =>
          evaluateScene(documentWithTrack(easing as "linear"), 500_000).state
            .elements[0]?.opacity,
      ),
    ).toEqual([0.5, 0.375, 0.625, 0.5]);

    const held = documentWithTrack("linear", [
      { timeUs: 250_000, value: 0.2 },
      { timeUs: 750_000, value: 0.8 },
    ]);
    expect(evaluateScene(held, 0).state.elements[0]?.opacity).toBe(0.2);
    expect(evaluateScene(held, 1_000_000).state.elements[0]?.opacity).toBe(0.8);
  });

  it("emits the matching deterministic command for the accepted line alternative", () => {
    const line = {
      ...documentWithTrack("linear"),
      rootIds: ["line-1"],
      elements: [
        { id: "line-1", type: "line", x1: 1, y1: 2, x2: 3, y2: 4, opacity: 1 },
      ],
      tracks: [
        {
          ...FIRST_SLICE_DOCUMENT.tracks[0],
          elementId: "line-1",
          easing: "linear",
        },
      ],
    } as SceneDocumentV1;

    expect(evaluateScene(line, 500_000).commands).toEqual([
      {
        kind: "draw-line",
        sourceId: "line-1",
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        opacity: 0.5,
      },
    ]);
  });

  it("remains equal after arbitrary evaluation history and canonical reload", () => {
    const target = evaluateScene(FIRST_SLICE_DOCUMENT, 750_000);
    for (const timeUs of [1_000_000, 0, 500_000, 250_000]) {
      evaluateScene(FIRST_SLICE_DOCUMENT, timeUs);
    }
    expect(evaluateScene(FIRST_SLICE_DOCUMENT, 750_000)).toEqual(target);

    const reloaded = reload(FIRST_SLICE_DOCUMENT);
    for (const timeUs of [0, 250_000, 500_000, 750_000, 1_000_000]) {
      expect(evaluateScene(reloaded, timeUs)).toEqual(
        evaluateScene(FIRST_SLICE_DOCUMENT, timeUs),
      );
    }
  });

  it("traverses nested groups in document order with composed effective transforms", () => {
    const groupedDocument = {
      ...FIRST_SLICE_DOCUMENT,
      rootIds: ["background", "group-1"],
      elements: [
        {
          id: "background",
          type: "shape",
          x: 0,
          y: 0,
          width: 2,
          height: 3,
          opacity: 1,
        },
        {
          id: "group-1",
          type: "group",
          childrenIds: ["line-1", "group-2"],
          transform: [1, 0, 0, 1, 10, 20],
        },
        {
          id: "line-1",
          type: "line",
          x1: 0,
          y1: 0,
          x2: 4,
          y2: 5,
          opacity: 1,
        },
        {
          id: "group-2",
          type: "group",
          childrenIds: ["shape-1"],
          transform: [2, 0, 0, 3, 1, 2],
        },
        {
          ...FIRST_SLICE_DOCUMENT.elements[0],
          transform: [1, 0, 0, 1, -4, 8],
        },
      ],
    } as SceneDocumentV1;

    const evaluated = evaluateScene(groupedDocument, 500_000);
    expect(evaluateScene(reload(groupedDocument), 500_000)).toEqual(evaluated);
    expect(evaluated.commands).toEqual([
      {
        kind: "draw-shape",
        sourceId: "background",
        x: 0,
        y: 0,
        width: 2,
        height: 3,
        opacity: 1,
      },
      {
        kind: "draw-line",
        sourceId: "line-1",
        x1: 0,
        y1: 0,
        x2: 4,
        y2: 5,
        opacity: 1,
        transform: [1, 0, 0, 1, 10, 20],
      },
      {
        kind: "draw-shape",
        sourceId: "shape-1",
        x: 16,
        y: 24,
        width: 120,
        height: 80,
        opacity: 0.5,
        transform: [2, 0, 0, 3, 3, 46],
      },
    ]);
  });

  it("omits every descendant of an invisible group", () => {
    const invisibleGroupDocument = {
      ...FIRST_SLICE_DOCUMENT,
      rootIds: ["group-1"],
      elements: [
        {
          id: "group-1",
          type: "group",
          childrenIds: ["shape-1"],
          visible: false,
        },
        { ...FIRST_SLICE_DOCUMENT.elements[0] },
      ],
    } as SceneDocumentV1;

    expect(evaluateScene(invisibleGroupDocument, 500_000)).toMatchObject({
      state: { elements: [] },
      commands: [],
    });
  });

  it("evaluates counter-addressed particles independently across steps, seeds, reloads, and history", () => {
    const particles = {
      ...FIRST_SLICE_DOCUMENT,
      rootIds: ["group-1"],
      seed: 7,
      elements: [
        {
          id: "group-1",
          type: "group",
          childrenIds: ["particle-1", "shape-1"],
          transform: [1, 0, 0, 1, 10, 20],
        },
        {
          id: "particle-1",
          type: "particle",
          count: 2,
          x: 4,
          y: 8,
          velocityX: 60,
          velocityY: -30,
          spread: 3,
          size: 2,
          opacity: 0.5,
          lifetimeSteps: 3,
        },
        { ...FIRST_SLICE_DOCUMENT.elements[0] },
      ],
      tracks: [{ ...FIRST_SLICE_DOCUMENT.tracks[0] }],
    } as SceneDocumentV1;
    const zero = evaluateScene(particles, 0);
    const beforeCycle = evaluateScene(particles, 49_999);
    const target = evaluateScene(particles, 50_000);

    expect([16_666, 16_667, 49_999, 50_000].map(deriveCompletedStep)).toEqual([
      0, 1, 2, 3,
    ]);
    const zeroParticle = zero.state.elements[0];
    if (!zeroParticle || zeroParticle.type !== "particle")
      throw new Error("particle fixture");
    const beforeParticle = beforeCycle.state.elements[0];
    const cycleParticle = target.state.elements[0];
    if (
      !beforeParticle ||
      beforeParticle.type !== "particle" ||
      !cycleParticle ||
      cycleParticle.type !== "particle"
    )
      throw new Error("particle fixture");
    expect(beforeParticle.points[0]).toEqual({
      x: zeroParticle.points[0]!.x + 2,
      y: zeroParticle.points[0]!.y - 1,
    });
    expect(cycleParticle.points[0]).toEqual({
      x: 2.05911384196952,
      y: 8.947435815818608,
    });
    expect(cycleParticle).not.toEqual(beforeParticle);
    expect(
      evaluateScene(
        {
          ...particles,
          elements: [
            { ...particles.elements[0], visible: false },
            ...particles.elements.slice(1),
          ],
        },
        50_000,
      ).commands,
    ).toEqual([]);
    expect(() =>
      evaluateScene(
        {
          ...particles,
          elements: [
            particles.elements[0],
            {
              ...particles.elements[1],
              x: Number.MAX_VALUE,
              velocityX: Number.MAX_VALUE,
            },
            particles.elements[2],
          ],
        },
        16_667,
      ),
    ).toThrow("RUNTIME_EVALUATION_NON_FINITE");
    for (const timeUs of [1_000_000, 0, 33_334])
      evaluateScene(particles, timeUs);
    expect(evaluateScene(particles, 50_000)).toEqual(target);
    expect(evaluateScene(reload(particles), 50_000)).toEqual(target);
    expect(evaluateScene({ ...particles, seed: 8 }, 50_000)).not.toEqual(
      target,
    );
    expect(target.commands[0]).toMatchObject({
      kind: "draw-particles",
      sourceId: "particle-1",
      size: 2,
      opacity: 0.5,
      transform: [1, 0, 0, 1, 10, 20],
    });
    expect(target.state.elements[0]).toMatchObject({
      type: "particle",
      points: [
        { x: expect.any(Number), y: expect.any(Number) },
        { x: expect.any(Number), y: expect.any(Number) },
      ],
    });
  });

  it("emits visible grouped text in DFS order and preserves it after reload", () => {
    const textDocument = {
      ...FIRST_SLICE_DOCUMENT,
      rootIds: ["group-1"],
      elements: [
        {
          id: "group-1",
          type: "group",
          childrenIds: ["shape-1", "text-1"],
          transform: [1, 0, 0, 1, 10, 20],
        },
        { ...FIRST_SLICE_DOCUMENT.elements[0] },
        {
          id: "text-1",
          type: "text",
          text: "Hello Canvas",
          x: 4,
          y: 12,
          fontSize: 18,
          opacity: 0.5,
          transform: [2, 0, 0, 2, 1, 2],
        },
      ],
    } as SceneDocumentV1;
    const evaluated = evaluateScene(textDocument, 500_000);

    expect(evaluated.commands[1]).toEqual({
      kind: "draw-text",
      sourceId: "text-1",
      text: "Hello Canvas",
      x: 4,
      y: 12,
      fontSize: 18,
      opacity: 0.5,
      transform: [2, 0, 0, 2, 11, 22],
    });
    expect(evaluateScene(reload(textDocument), 500_000)).toEqual(evaluated);
    expect(
      evaluateScene(
        {
          ...textDocument,
          elements: [
            { ...textDocument.elements[0], visible: false },
            ...textDocument.elements.slice(1),
          ],
        },
        500_000,
      ).commands,
    ).toEqual([]);
    expect(() =>
      evaluateScene(
        {
          ...textDocument,
          elements: [
            {
              ...textDocument.elements[0],
              transform: [Number.MAX_VALUE, 0, 0, 1, 0, 0],
            },
            textDocument.elements[1],
            {
              ...textDocument.elements[2],
              transform: [Number.MAX_VALUE, 0, 0, 1, 0, 0],
            },
          ],
        },
        500_000,
      ),
    ).toThrow("RUNTIME_EVALUATION_NON_FINITE");
  });

  it("evaluates a resolved image into ordered DOM-free IR", () => {
    const imageDocument = {
      ...FIRST_SLICE_DOCUMENT,
      rootIds: ["group-1"],
      elements: [
        {
          id: "group-1",
          type: "group",
          childrenIds: ["image-1", "shape-1"],
          transform: [1, 0, 0, 1, 10, 20],
        },
        {
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
        },
        { ...FIRST_SLICE_DOCUMENT.elements[0] },
      ],
      tracks: [{ ...FIRST_SLICE_DOCUMENT.tracks[0] }],
    } as SceneDocumentV1;
    const handle = { fixture: "resolved-image" };
    const resolver = {
      resolve: (asset: (typeof imageDocument.elements)[1]["asset"]) => ({
        handle,
        ...asset,
      }),
    };

    const evaluated = evaluateScene(imageDocument, 500_000, {
      imageResolver: resolver,
    });
    expect(evaluated.state.elements[0]).toEqual({
      id: "image-1",
      type: "image",
      resolved: handle,
      x: 8,
      y: 16,
      width: 128,
      height: 64,
      opacity: 0.5,
      transform: [1, 0, 0, 1, 10, 20],
    });
    expect(evaluated.commands[0]).toEqual({
      kind: "draw-image",
      sourceId: "image-1",
      resolved: handle,
      x: 8,
      y: 16,
      width: 128,
      height: 64,
      opacity: 0.5,
      transform: [1, 0, 0, 1, 10, 20],
    });
    expect(
      evaluateScene(imageDocument, 500_000, { imageResolver: resolver }),
    ).toEqual(evaluated);
    expect(
      evaluateScene(reload(imageDocument), 500_000, {
        imageResolver: resolver,
      }),
    ).toEqual(evaluated);

    const originalDocument = structuredClone(imageDocument);
    expect(() => createTimelineTransport(imageDocument).snapshot()).toThrow(
      "RUNTIME_IMAGE_RESOLVER_MISSING",
    );

    const transport = createTimelineTransport(imageDocument, {
      imageResolver: resolver,
    });
    expect(transport.snapshot().evaluation.commands[0]).toEqual(
      evaluated.commands[0],
    );
    expect(transport.seek(500_000).commands[0]).toEqual(evaluated.commands[0]);
    expect(transport.play().evaluation.commands[0]).toEqual(
      evaluated.commands[0],
    );
    expect(transport.pause().evaluation.commands[0]).toEqual(
      evaluated.commands[0],
    );
    transport.play();
    expect(transport.advance(250_000).commands[0]).toEqual(
      evaluated.commands[0],
    );
    expect(imageDocument).toEqual(originalDocument);
  });

  it("preserves one-argument transport evaluation for documents without images", () => {
    const transport = createTimelineTransport(FIRST_SLICE_DOCUMENT);

    expect(transport.snapshot()).toMatchObject({
      playheadUs: 0,
      playing: false,
      evaluation: { commands: [{ kind: "draw-shape", sourceId: "shape-1" }] },
    });
    transport.play();
    expect(transport.advance(250_000).state.timeUs).toBe(250_000);
  });

  it("reports image resolver failures and skips invisible image paths", () => {
    const imageDocument = {
      ...FIRST_SLICE_DOCUMENT,
      rootIds: ["group-1"],
      elements: [
        {
          id: "group-1",
          type: "group",
          childrenIds: ["image-1", "shape-1"],
        },
        {
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
        },
        { ...FIRST_SLICE_DOCUMENT.elements[0] },
      ],
      tracks: [{ ...FIRST_SLICE_DOCUMENT.tracks[0] }],
    } as SceneDocumentV1;
    const image = imageDocument.elements[1];
    if (!image || image.type !== "image") throw new Error("image fixture");
    const resolved = {
      handle: { fixture: "resolved-image" },
      ...image.asset,
    };

    expect(() => evaluateScene(imageDocument, 500_000)).toThrow(
      "RUNTIME_IMAGE_RESOLVER_MISSING",
    );
    expect(() =>
      evaluateScene(imageDocument, 500_000, {
        imageResolver: { resolve: () => undefined },
      }),
    ).toThrow("RUNTIME_IMAGE_ASSET_UNRESOLVED");
    for (const [resolvedImage, error] of [
      [
        { ...resolved, sha256: "sha256:wrong" },
        "RUNTIME_IMAGE_ASSET_HASH_MISMATCH",
      ],
      [
        { ...resolved, mimeType: "image/jpeg" },
        "RUNTIME_IMAGE_ASSET_METADATA_MISMATCH",
      ],
      [{ ...resolved, byteLength: 1 }, "RUNTIME_IMAGE_ASSET_METADATA_MISMATCH"],
      [
        { ...resolved, intrinsicWidth: 1 },
        "RUNTIME_IMAGE_ASSET_METADATA_MISMATCH",
      ],
      [
        { ...resolved, intrinsicHeight: 1 },
        "RUNTIME_IMAGE_ASSET_METADATA_MISMATCH",
      ],
      [
        { ...resolved, intrinsicWidth: Infinity },
        "RUNTIME_EVALUATION_NON_FINITE",
      ],
    ] as const) {
      expect(() =>
        evaluateScene(imageDocument, 500_000, {
          imageResolver: { resolve: () => resolvedImage },
        }),
      ).toThrow(error);
    }

    let calls = 0;
    expect(
      evaluateScene(
        {
          ...imageDocument,
          elements: [
            { ...imageDocument.elements[0], visible: false },
            ...imageDocument.elements.slice(1),
          ],
        },
        500_000,
        {
          imageResolver: {
            resolve: () => {
              calls += 1;
              return resolved;
            },
          },
        },
      ).commands,
    ).toEqual([]);
    expect(calls).toBe(0);
    expect(
      evaluateScene(
        {
          ...imageDocument,
          elements: [
            imageDocument.elements[0],
            { ...image, visible: false },
            imageDocument.elements[2],
          ],
        },
        500_000,
        { imageResolver: { resolve: () => resolved } },
      ).commands,
    ).toHaveLength(1);
    expect(() =>
      evaluateScene(
        {
          ...imageDocument,
          elements: [
            {
              ...imageDocument.elements[0],
              transform: [Number.MAX_VALUE, 0, 0, 1, 0, 0],
            },
            { ...image, transform: [2, 0, 0, 1, 0, 0] },
            imageDocument.elements[2],
          ],
        },
        500_000,
        { imageResolver: { resolve: () => resolved } },
      ),
    ).toThrow("RUNTIME_EVALUATION_NON_FINITE");
  });

  it("rejects finite local transforms whose composition overflows", () => {
    const overflowingDocument = {
      ...FIRST_SLICE_DOCUMENT,
      rootIds: ["group-1"],
      elements: [
        {
          id: "group-1",
          type: "group",
          childrenIds: ["shape-1"],
          transform: [Number.MAX_VALUE, 0, 0, 1, 0, 0],
        },
        {
          ...FIRST_SLICE_DOCUMENT.elements[0],
          transform: [2, 0, 0, 1, 0, 0],
        },
      ],
    } as SceneDocumentV1;

    expect(() => evaluateScene(overflowingDocument, 500_000)).toThrow(
      "RUNTIME_EVALUATION_NON_FINITE",
    );
  });

  it("evaluates every opacity segment and text step track", () => {
    const document = {
      ...FIRST_SLICE_DOCUMENT,
      rootIds: ["shape-1", "text-1"],
      elements: [
        { ...FIRST_SLICE_DOCUMENT.elements[0] },
        {
          id: "text-1",
          type: "text",
          text: "before",
          x: 0,
          y: 0,
          fontSize: 12,
          opacity: 1,
        },
      ],
      tracks: [
        {
          elementId: "shape-1",
          property: "opacity",
          interpolation: "linear",
          easing: "linear",
          keyframes: [
            { timeUs: 0, value: 0.2 },
            { timeUs: 500_000, value: 0.6 },
            { timeUs: 1_000_000, value: 0.8 },
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
      ],
    } as SceneDocumentV1;

    expect(evaluateScene(document, 750_000).state.elements).toMatchObject([
      { id: "shape-1", opacity: 0.7 },
      { id: "text-1", text: "after" },
    ]);
  });

  it("seeks and advances an ephemeral range transport", () => {
    const looping = createTimelineTransport({
      ...FIRST_SLICE_DOCUMENT,
      playbackRange: { startUs: 200_000, endUs: 300_000 },
    });
    expect(looping.snapshot()).toMatchObject({
      playheadUs: 200_000,
      playing: false,
    });
    expect(looping.seek(250_000).state.timeUs).toBe(250_000);
    looping.play();
    expect(looping.advance(50_000).state.timeUs).toBe(300_000);
    expect(looping.snapshot()).toMatchObject({
      playheadUs: 300_000,
      playing: true,
    });
    expect(looping.advance(250_000).state.timeUs).toBe(250_000);

    const stopping = createTimelineTransport({
      ...FIRST_SLICE_DOCUMENT,
      loop: false,
    });
    stopping.play();
    expect(stopping.advance(1_000_000).state.timeUs).toBe(1_000_000);
    expect(stopping.snapshot()).toMatchObject({
      playheadUs: 1_000_000,
      playing: false,
    });
  });
});
