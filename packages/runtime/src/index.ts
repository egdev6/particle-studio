import {
  validateSceneDocument,
  type SceneDocumentV1,
} from "@particle-studio/scene-document";

const MICROSECONDS_PER_SECOND = 1_000_000n;
const STEPS_PER_SECOND = 60n;

export const RUNTIME_VERSION = "particle-studio-runtime-v1" as const;

type SceneTrack = SceneDocumentV1["tracks"][number];
type NumericTrack = Extract<SceneTrack, { property: "opacity" }>;
type TextTrack = Extract<SceneTrack, { property: "text.text" }>;
type Easing = NumericTrack["easing"];

type AffineTransform = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
];

const IDENTITY_TRANSFORM: AffineTransform = [1, 0, 0, 1, 0, 0];

type EvaluatedShape = {
  readonly id: string;
  readonly type: "shape";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly opacity: number;
  readonly transform?: AffineTransform;
};

type EvaluatedLine = {
  readonly id: string;
  readonly type: "line";
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly opacity: number;
  readonly transform?: AffineTransform;
};

type EvaluatedText = {
  readonly id: string;
  readonly type: "text";
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly fontSize: number;
  readonly opacity: number;
  readonly transform?: AffineTransform;
};

type ImageElement = Extract<
  SceneDocumentV1["elements"][number],
  { type: "image" }
>;

export interface ResolvedImage {
  readonly handle: unknown;
  readonly sha256: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
}

export interface ImageResolver {
  resolve(asset: ImageElement["asset"]): ResolvedImage | undefined;
}

export interface EvaluationOptions {
  readonly imageResolver?: ImageResolver;
}

type EvaluatedImage = {
  readonly id: string;
  readonly type: "image";
  readonly resolved: unknown;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly opacity: number;
  readonly transform?: AffineTransform;
};

type ParticlePoint = { readonly x: number; readonly y: number };
type EvaluatedParticle = {
  readonly id: string;
  readonly type: "particle";
  readonly points: readonly ParticlePoint[];
  readonly size: number;
  readonly opacity: number;
  readonly transform?: AffineTransform;
};

export type EvaluatedElement =
  | EvaluatedShape
  | EvaluatedLine
  | EvaluatedParticle
  | EvaluatedText
  | EvaluatedImage;

export interface EvaluatedScene {
  readonly timeUs: number;
  readonly completedStep: number;
  readonly elements: readonly EvaluatedElement[];
}

export type RenderCommand =
  | {
      readonly kind: "draw-shape";
      readonly sourceId: string;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly opacity: number;
      readonly transform?: AffineTransform;
    }
  | {
      readonly kind: "draw-line";
      readonly sourceId: string;
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly opacity: number;
      readonly transform?: AffineTransform;
    }
  | {
      readonly kind: "draw-text";
      readonly sourceId: string;
      readonly text: string;
      readonly x: number;
      readonly y: number;
      readonly fontSize: number;
      readonly opacity: number;
      readonly transform?: AffineTransform;
    }
  | {
      readonly kind: "draw-particles";
      readonly sourceId: string;
      readonly points: readonly ParticlePoint[];
      readonly size: number;
      readonly opacity: number;
      readonly transform?: AffineTransform;
    }
  | {
      readonly kind: "draw-image";
      readonly sourceId: string;
      readonly resolved: unknown;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly opacity: number;
      readonly transform?: AffineTransform;
    };

export interface EvaluationResult {
  readonly state: EvaluatedScene;
  readonly commands: readonly RenderCommand[];
}

function invalidTime(): never {
  throw new Error("RUNTIME_TIME_US_INVALID");
}

function assertTimeUs(timeUs: number, durationUs?: number) {
  if (
    !Number.isSafeInteger(timeUs) ||
    timeUs < 0 ||
    (durationUs !== undefined && timeUs > durationUs)
  ) {
    invalidTime();
  }
}

function applyEasing(easing: Easing, progress: number) {
  switch (easing) {
    case "linear":
      return progress;
    case "easeInQuad":
      return progress * progress;
    case "easeOutQuad":
      return 1 - (1 - progress) * (1 - progress);
    case "easeInOutQuad":
      return progress < 0.5
        ? 2 * progress * progress
        : 1 - (-2 * progress + 2) ** 2 / 2;
  }
}

function evaluateNumericTrack(track: NumericTrack, timeUs: number) {
  const [first, last] = track.keyframes;
  if (!first || !last) throw new Error("RUNTIME_DOCUMENT_INVALID");
  if (timeUs <= first.timeUs) return first.value;
  for (let index = 1; index < track.keyframes.length; index += 1) {
    const next = track.keyframes[index]!;
    if (timeUs < next.timeUs) {
      const previous = track.keyframes[index - 1]!;
      const progress =
        (timeUs - previous.timeUs) / (next.timeUs - previous.timeUs);
      return (
        previous.value +
        (next.value - previous.value) * applyEasing(track.easing, progress)
      );
    }
  }
  return last.value;
}

function opacityFor(
  document: SceneDocumentV1,
  elementId: string,
  timeUs: number,
) {
  const track = document.tracks.find(
    (candidate): candidate is NumericTrack =>
      candidate.elementId === elementId && candidate.property === "opacity",
  );
  return track ? evaluateNumericTrack(track, timeUs) : undefined;
}

function textFor(
  element: Extract<SceneDocumentV1["elements"][number], { type: "text" }>,
  document: SceneDocumentV1,
  timeUs: number,
) {
  const track = document.tracks.find(
    (candidate): candidate is TextTrack =>
      candidate.elementId === element.id && candidate.property === "text.text",
  );
  if (!track) return element.text;
  return track.keyframes.reduce(
    (value, keyframe) => (keyframe.timeUs <= timeUs ? keyframe.value : value),
    track.keyframes[0]!.value,
  );
}

function transformFor(
  transform: readonly number[] | undefined,
): AffineTransform {
  if (!transform) return IDENTITY_TRANSFORM;
  if (transform.length !== 6 || !transform.every(Number.isFinite)) {
    throw new Error("RUNTIME_EVALUATION_NON_FINITE");
  }
  return [
    transform[0]!,
    transform[1]!,
    transform[2]!,
    transform[3]!,
    transform[4]!,
    transform[5]!,
  ];
}

/** Composes parent then child under the document's column-vector convention. */
function composeTransform(
  parent: AffineTransform,
  child: AffineTransform,
): AffineTransform {
  const [a, b, c, d, e, f] = parent;
  const [A, B, C, D, E, F] = child;
  const result: AffineTransform = [
    a * A + c * B,
    b * A + d * B,
    a * C + c * D,
    b * C + d * D,
    a * E + c * F + e,
    b * E + d * F + f,
  ];
  if (!result.every(Number.isFinite)) {
    throw new Error("RUNTIME_EVALUATION_NON_FINITE");
  }
  return result;
}

function isIdentityTransform(transform: AffineTransform) {
  return transform.every((value, index) => value === IDENTITY_TRANSFORM[index]);
}

/** `particle-counter32-v1` uses UTF-8 FNV-1a stream IDs and a uint32 avalanche. */
function particleStreamId(id: string) {
  let hash = 0x811c9dc5;
  for (const character of `particle-counter32-v1\0${id}`) {
    const codePoint = character.codePointAt(0)!;
    const bytes: number[] = [];
    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
    for (const byte of bytes) {
      hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    }
  }
  return hash;
}

function particleCounter32(
  seed: number,
  stream: number,
  cycleStart: number,
  slot: number,
) {
  let value = (seed ^ stream ^ cycleStart ^ slot) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97) >>> 0;
  return (value ^ (value >>> 15)) >>> 0;
}

function evaluateElement(
  document: SceneDocumentV1,
  element: Exclude<SceneDocumentV1["elements"][number], { type: "group" }>,
  timeUs: number,
  transform: AffineTransform,
  imageResolver: ImageResolver | undefined,
): EvaluatedElement {
  const transformProperty = isIdentityTransform(transform) ? {} : { transform };
  const opacity = opacityFor(document, element.id, timeUs) ?? element.opacity;
  if (element.type === "text") {
    if (
      ![element.x, element.y, element.fontSize, opacity].every(Number.isFinite)
    ) {
      throw new Error("RUNTIME_EVALUATION_NON_FINITE");
    }
    return {
      id: element.id,
      type: "text",
      text: textFor(element, document, timeUs),
      x: element.x,
      y: element.y,
      fontSize: element.fontSize,
      opacity,
      ...transformProperty,
    };
  }
  if (element.type === "particle") {
    const completedStep = deriveCompletedStep(timeUs);
    const cycle = Math.floor(completedStep / element.lifetimeSteps);
    const ageSteps = completedStep % element.lifetimeSteps;
    const cycleStart = cycle * element.lifetimeSteps;
    const stream = particleStreamId(element.id);
    const random = (slot: number) =>
      particleCounter32(document.seed, stream, cycleStart, slot) /
      0x1_0000_0000;
    const points = Array.from({ length: element.count }, (_, index) => ({
      x:
        element.x +
        (random(2 * index) * 2 - 1) * element.spread +
        (element.velocityX * ageSteps) / 60,
      y:
        element.y +
        (random(2 * index + 1) * 2 - 1) * element.spread +
        (element.velocityY * ageSteps) / 60,
    }));
    if (
      ![element.size, opacity, ...points.flatMap(({ x, y }) => [x, y])].every(
        Number.isFinite,
      )
    ) {
      throw new Error("RUNTIME_EVALUATION_NON_FINITE");
    }
    return {
      id: element.id,
      type: "particle",
      points,
      size: element.size,
      opacity,
      ...transformProperty,
    };
  }
  if (element.type === "image") {
    if (!imageResolver) throw new Error("RUNTIME_IMAGE_RESOLVER_MISSING");
    const resolved = imageResolver.resolve(element.asset);
    if (
      !resolved ||
      typeof resolved !== "object" ||
      !("handle" in resolved) ||
      resolved.handle === null ||
      resolved.handle === undefined
    ) {
      throw new Error("RUNTIME_IMAGE_ASSET_UNRESOLVED");
    }
    if (
      ![
        resolved.byteLength,
        resolved.intrinsicWidth,
        resolved.intrinsicHeight,
        element.x,
        element.y,
        element.width,
        element.height,
        opacity,
      ].every(Number.isFinite)
    ) {
      throw new Error("RUNTIME_EVALUATION_NON_FINITE");
    }
    if (resolved.sha256 !== element.asset.sha256) {
      throw new Error("RUNTIME_IMAGE_ASSET_HASH_MISMATCH");
    }
    if (
      resolved.mimeType !== element.asset.mimeType ||
      resolved.byteLength !== element.asset.byteLength ||
      resolved.intrinsicWidth !== element.asset.intrinsicWidth ||
      resolved.intrinsicHeight !== element.asset.intrinsicHeight
    ) {
      throw new Error("RUNTIME_IMAGE_ASSET_METADATA_MISMATCH");
    }
    return {
      id: element.id,
      type: "image",
      resolved: resolved.handle,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      opacity,
      ...transformProperty,
    };
  }
  const numbers =
    element.type === "shape"
      ? [element.x, element.y, element.width, element.height, opacity]
      : [element.x1, element.y1, element.x2, element.y2, opacity];
  if (!numbers.every(Number.isFinite)) {
    throw new Error("RUNTIME_EVALUATION_NON_FINITE");
  }

  return element.type === "shape"
    ? {
        id: element.id,
        type: "shape",
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        opacity,
        ...transformProperty,
      }
    : {
        id: element.id,
        type: "line",
        x1: element.x1,
        y1: element.y1,
        x2: element.x2,
        y2: element.y2,
        opacity,
        ...transformProperty,
      };
}

function renderCommand(element: EvaluatedElement): RenderCommand {
  const transformProperty = element.transform
    ? { transform: element.transform }
    : {};
  return element.type === "image"
    ? {
        kind: "draw-image",
        sourceId: element.id,
        resolved: element.resolved,
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        opacity: element.opacity,
        ...transformProperty,
      }
    : element.type === "text"
      ? {
          kind: "draw-text",
          sourceId: element.id,
          text: element.text,
          x: element.x,
          y: element.y,
          fontSize: element.fontSize,
          opacity: element.opacity,
          ...transformProperty,
        }
      : element.type === "particle"
        ? {
            kind: "draw-particles",
            sourceId: element.id,
            points: element.points,
            size: element.size,
            opacity: element.opacity,
            ...transformProperty,
          }
        : element.type === "shape"
          ? {
              kind: "draw-shape",
              sourceId: element.id,
              x: element.x,
              y: element.y,
              width: element.width,
              height: element.height,
              opacity: element.opacity,
              ...transformProperty,
            }
          : {
              kind: "draw-line",
              sourceId: element.id,
              x1: element.x1,
              y1: element.y1,
              x2: element.x2,
              y2: element.y2,
              opacity: element.opacity,
              ...transformProperty,
            };
}

/** Returns the exact rational 60 Hz step completed at an explicit time. */
export function deriveCompletedStep(timeUs: number) {
  assertTimeUs(timeUs);
  return Number((BigInt(timeUs) * STEPS_PER_SECOND) / MICROSECONDS_PER_SECOND);
}

/** Evaluates an accepted first-slice document without clocks, history, or side effects. */
export interface TimelineSnapshot {
  readonly playheadUs: number;
  readonly playing: boolean;
  readonly evaluation: EvaluationResult;
}

export interface TimelineTransport {
  snapshot(): TimelineSnapshot;
  seek(timeUs: number): EvaluationResult;
  play(): TimelineSnapshot;
  pause(): TimelineSnapshot;
  advance(elapsedUs: number): EvaluationResult;
}

export function createTimelineTransport(
  document: unknown,
  options?: EvaluationOptions,
): TimelineTransport {
  const validation = validateSceneDocument(document);
  if (!validation.ok) throw new Error("RUNTIME_DOCUMENT_INVALID");
  const { playbackRange } = validation.value;
  let playheadUs = playbackRange.startUs;
  let playing = false;
  const evaluate = () => evaluateScene(validation.value, playheadUs, options);
  const snapshot = (): TimelineSnapshot => ({
    playheadUs,
    playing,
    evaluation: evaluate(),
  });

  return {
    snapshot,
    seek(timeUs) {
      assertTimeUs(timeUs, validation.value.durationUs);
      playheadUs = timeUs;
      return evaluate();
    },
    play() {
      playing = true;
      return snapshot();
    },
    pause() {
      playing = false;
      return snapshot();
    },
    advance(elapsedUs) {
      assertTimeUs(elapsedUs);
      if (!playing) return evaluate();
      const advanced = playheadUs + elapsedUs;
      if (!Number.isSafeInteger(advanced)) invalidTime();
      if (advanced < playbackRange.endUs) {
        playheadUs = advanced;
      } else if (advanced === playbackRange.endUs) {
        playheadUs = advanced;
        if (!validation.value.loop) playing = false;
      } else if (validation.value.loop) {
        const rangeLength = playbackRange.endUs - playbackRange.startUs;
        playheadUs =
          playbackRange.startUs +
          ((advanced - playbackRange.endUs) % rangeLength);
      } else {
        playheadUs = playbackRange.endUs;
        playing = false;
      }
      return evaluate();
    },
  };
}

export function evaluateScene(
  document: unknown,
  timeUs: number,
  options?: EvaluationOptions,
): EvaluationResult {
  const validation = validateSceneDocument(document);
  if (!validation.ok) throw new Error("RUNTIME_DOCUMENT_INVALID");
  assertTimeUs(timeUs, validation.value.durationUs);

  const elementsById = new Map(
    validation.value.elements.map((element) => [element.id, element]),
  );
  const elements: EvaluatedElement[] = [];
  const traverse = (
    elementId: string,
    parentTransform: AffineTransform,
    parentVisible: boolean,
  ) => {
    const element = elementsById.get(elementId);
    if (!element) throw new Error("RUNTIME_DOCUMENT_INVALID");

    const visible = parentVisible && (element.visible ?? true);
    if (!visible) return;

    const transform = composeTransform(
      parentTransform,
      transformFor(element.transform),
    );
    if (element.type === "group") {
      for (const childId of element.childrenIds) {
        traverse(childId, transform, visible);
      }
      return;
    }
    elements.push(
      evaluateElement(
        validation.value,
        element,
        timeUs,
        transform,
        options?.imageResolver,
      ),
    );
  };

  for (const rootId of validation.value.rootIds) {
    traverse(rootId, IDENTITY_TRANSFORM, true);
  }
  return {
    state: {
      timeUs,
      completedStep: deriveCompletedStep(timeUs),
      elements,
    },
    commands: elements.map(renderCommand),
  };
}
