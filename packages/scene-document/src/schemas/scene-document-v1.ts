import { Type, type Static } from "@sinclair/typebox";

const stableId = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z][A-Za-z0-9_-]*$",
});
const safeTimeUs = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});
const finiteNumber = Type.Number();
// Affine tuples use column vectors: [a, b, c, d, e, f] maps (x, y) to
// (a*x + c*y + e, b*x + d*y + f); parent composition is deferred to C2b.
const affineTransform = Type.Array(finiteNumber, {
  minItems: 6,
  maxItems: 6,
});
const elementPresentation = {
  transform: Type.Optional(affineTransform),
  visible: Type.Optional(Type.Boolean()),
};
const numericKeyframe = Type.Object(
  { timeUs: safeTimeUs, value: finiteNumber },
  { additionalProperties: false },
);
const stepKeyframe = Type.Object(
  {
    timeUs: safeTimeUs,
    value: Type.String({ minLength: 1, pattern: "^[^\\r\\n]+$" }),
  },
  { additionalProperties: false },
);
const numericTrack = Type.Object(
  {
    elementId: stableId,
    property: Type.Literal("opacity"),
    interpolation: Type.Literal("linear"),
    easing: Type.Union([
      Type.Literal("linear"),
      Type.Literal("easeInQuad"),
      Type.Literal("easeOutQuad"),
      Type.Literal("easeInOutQuad"),
    ]),
    keyframes: Type.Array(numericKeyframe, { minItems: 1, maxItems: 1_000 }),
  },
  { additionalProperties: false },
);
const stepTrack = Type.Object(
  {
    elementId: stableId,
    property: Type.Literal("text.text"),
    interpolation: Type.Literal("step"),
    keyframes: Type.Array(stepKeyframe, { minItems: 1, maxItems: 1_000 }),
  },
  { additionalProperties: false },
);
const shape = Type.Object(
  {
    id: stableId,
    type: Type.Literal("shape"),
    x: finiteNumber,
    y: finiteNumber,
    width: finiteNumber,
    height: finiteNumber,
    opacity: finiteNumber,
    ...elementPresentation,
  },
  { additionalProperties: false },
);
const line = Type.Object(
  {
    id: stableId,
    type: Type.Literal("line"),
    x1: finiteNumber,
    y1: finiteNumber,
    x2: finiteNumber,
    y2: finiteNumber,
    opacity: finiteNumber,
    ...elementPresentation,
  },
  { additionalProperties: false },
);
const group = Type.Object(
  {
    id: stableId,
    type: Type.Literal("group"),
    childrenIds: Type.Array(stableId, { minItems: 0, maxItems: 1_000 }),
    ...elementPresentation,
  },
  { additionalProperties: false },
);
const text = Type.Object(
  {
    id: stableId,
    type: Type.Literal("text"),
    text: Type.String({ minLength: 1, pattern: "^[^\\r\\n]+$" }),
    x: finiteNumber,
    y: finiteNumber,
    fontSize: Type.Number({ exclusiveMinimum: 0 }),
    opacity: Type.Number({ minimum: 0, maximum: 1 }),
    ...elementPresentation,
  },
  { additionalProperties: false },
);
const imageAssetReference = Type.Object(
  {
    sha256: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
    mimeType: Type.Literal("image/png"),
    byteLength: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    intrinsicWidth: Type.Integer({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    intrinsicHeight: Type.Integer({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
  },
  { additionalProperties: false },
);
const image = Type.Object(
  {
    id: stableId,
    type: Type.Literal("image"),
    asset: imageAssetReference,
    x: finiteNumber,
    y: finiteNumber,
    width: Type.Number({ exclusiveMinimum: 0 }),
    height: Type.Number({ exclusiveMinimum: 0 }),
    opacity: finiteNumber,
    ...elementPresentation,
  },
  { additionalProperties: false },
);
const particle = Type.Object(
  {
    id: stableId,
    type: Type.Literal("particle"),
    count: Type.Integer({ minimum: 1, maximum: 1_000 }),
    x: finiteNumber,
    y: finiteNumber,
    velocityX: finiteNumber,
    velocityY: finiteNumber,
    spread: Type.Number({ minimum: 0 }),
    size: Type.Number({ exclusiveMinimum: 0 }),
    opacity: Type.Number({ minimum: 0, maximum: 1 }),
    lifetimeSteps: Type.Integer({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    ...elementPresentation,
  },
  { additionalProperties: false },
);

export const SceneDocumentV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    durationUs: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    playbackRange: Type.Object(
      { startUs: safeTimeUs, endUs: safeTimeUs },
      { additionalProperties: false },
    ),
    loop: Type.Boolean(),
    seed: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
    rootIds: Type.Array(stableId, { minItems: 1, maxItems: 1_000 }),
    elements: Type.Array(
      Type.Union([shape, line, group, particle, text, image]),
      {
        minItems: 1,
        maxItems: 1_000,
      },
    ),
    tracks: Type.Array(Type.Union([numericTrack, stepTrack]), {
      minItems: 0,
      maxItems: 1_000,
    }),
  },
  {
    $id: "https://particle.studio/schema/scene-document-v1",
    additionalProperties: false,
  },
);

export type SceneDocumentV1 = Static<typeof SceneDocumentV1Schema>;
export type InternalSceneDocumentV1 = SceneDocumentV1;
