import { canonicalizeSceneDocument } from "@particle-studio/scene-document";
import { renderCommands } from "@particle-studio/renderer-canvas2d";
import {
  createTimelineTransport,
  evaluateScene,
  RUNTIME_VERSION,
} from "@particle-studio/runtime";

import {
  FRAME_MEASURED_SAMPLES,
  FRAME_WARMUP_SAMPLES,
  SEEK_MEASURED_SAMPLES,
  SEEK_WARMUP_SAMPLES,
  batchRateFromTotal,
  type BatchRate,
} from "./measurement.js";
import {
  createReferenceFixture,
  REFERENCE_DURATION_US,
  REFERENCE_FIXTURE_VERSION,
  REFERENCE_PARTICLE_COUNT,
  REFERENCE_VIEWPORT,
} from "./reference-fixture.js";

/**
 * Browser-side measurement harness for the frozen Canvas2D performance gate.
 * It only wires the real production runtime and renderer to the real canvas:
 * all summarizing, threshold decisions, and manifest building stay in the
 * pure R1a modules so Node tests and the browser share one rule set.
 *
 * Importing this module installs the harness on `globalThis` synchronously
 * and starts nothing: no animation loop, no timer, and no measurement runs on
 * load. `ready` resolves once the fixture hash has been computed over the
 * canonical bytes; the fixture whose hash is reported is exactly the fixture
 * that every frame and seek measurement evaluates.
 */

const CANVAS_ELEMENT_ID = "performance-canvas";

type ReferenceFixture = ReturnType<typeof createReferenceFixture>;
type Evaluation = ReturnType<typeof evaluateScene>;

export interface PerformanceSampleContract {
  readonly frameWarmupSamples: number;
  readonly frameMeasuredSamples: number;
  readonly seekWarmupSamples: number;
  readonly seekMeasuredSamples: number;
  readonly seekTargetUs: number;
}

export interface PerformanceHarnessDescription {
  readonly fixtureVersion: string;
  readonly fixtureHash: string;
  readonly viewport: typeof REFERENCE_VIEWPORT;
  readonly particleCount: number;
  readonly runtimeVersion: string;
  readonly buildMode: "production" | "development";
  readonly sampleContract: PerformanceSampleContract;
}

export interface SeekSample {
  readonly seekMs: number;
  readonly creationMs: number;
  readonly points: number;
}

/** Non-vacuity proof for the frame measurement (real draw-call count). */
export interface DrawWorkProof {
  readonly fillRectCalls: number;
  readonly commands: number;
  readonly points: number;
}

/**
 * Fixed attempt budget for the timer-resolution probe: sampling deltas is
 * cheap, so the bound only exists to keep the probe deterministic and
 * unbounded loops out of the harness.
 */
const TIMER_RESOLUTION_ATTEMPTS = 1_000;

export interface PerformanceHarness {
  /** Resolves once the canonical fixture hash has been computed. */
  readonly ready: Promise<void>;
  describe(): Promise<PerformanceHarnessDescription>;
  warmupFrames(count: number): number;
  measureFrames(count: number): number[];
  /** Whole-batch corroboration for the per-sample median; not a gate. */
  measureFrameBatch(count: number): BatchRate;
  measureSeeks(count: number): SeekSample[];
  /** Effective performance.now() quantum; 0 means unresolved in-budget. */
  timerResolutionMs(): number;
  /** Non-vacuity proof for the frame measurement. */
  proveDrawWork(): DrawWorkProof;
  canvasSize(): { width: number; height: number };
}

const referenceCanvas = {
  fixture: null as ReferenceFixture | null,
  context: null as CanvasRenderingContext2D | null,
};

function referenceFixture(): ReferenceFixture {
  const fixture = (referenceCanvas.fixture ??= createReferenceFixture());
  return fixture;
}

function canvasElement(): HTMLCanvasElement {
  const canvas = document.getElementById(CANVAS_ELEMENT_ID);
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error(
      `PERFORMANCE_CANVAS_MISSING: expected #${CANVAS_ELEMENT_ID} on the measurement page`,
    );
  }
  if (
    canvas.width !== REFERENCE_VIEWPORT.width ||
    canvas.height !== REFERENCE_VIEWPORT.height
  ) {
    throw new Error(
      `PERFORMANCE_CANVAS_SIZE_INVALID: expected ${REFERENCE_VIEWPORT.width}x${REFERENCE_VIEWPORT.height}, got ${canvas.width}x${canvas.height}`,
    );
  }
  return canvas;
}

function canvasContext(): CanvasRenderingContext2D {
  const cached = referenceCanvas.context;
  if (cached) return cached;
  const context = canvasElement().getContext("2d");
  if (!context) {
    throw new Error(
      "PERFORMANCE_CANVAS_2D_UNAVAILABLE: the measurement canvas has no 2d context",
    );
  }
  referenceCanvas.context = context;
  return context;
}

/**
 * Midpoint sweep across the frozen timeline: sample i of n evaluates at the
 * center of its share of the ten seconds, so measured frames cover the whole
 * timeline deterministically instead of repeating one evaluation time.
 */
function sweepTimeUs(sampleIndex: number, sampleCount: number): number {
  return Math.floor(
    ((sampleIndex + 0.5) / sampleCount) * REFERENCE_DURATION_US,
  );
}

/** Draws one evaluated frame on the real 2d context. */
function evaluateAndRender(timeUs: number): Evaluation {
  const evaluation = evaluateScene(referenceFixture(), timeUs);
  renderCommands(canvasContext(), evaluation.commands);
  return evaluation;
}

/**
 * Wraps the real 2d context in a counting proxy that delegates every access
 * to the real context: `fillRect` calls are counted and then performed, so
 * the drawing still happens exactly as in an uncounted pass.
 */
function countingCanvasContext(): {
  context: CanvasRenderingContext2D;
  fillRectCalls: () => number;
} {
  const context = canvasContext();
  let fillRectCalls = 0;
  const counting = new Proxy(context, {
    get(target, property, receiver) {
      if (property === "fillRect") {
        return (...args: Parameters<CanvasRenderingContext2D["fillRect"]>) => {
          fillRectCalls += 1;
          return target.fillRect(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    // Native Canvas2D setters (globalAlpha, font, ...) reject a receiver
    // that is not the real context, so attribute writes must be forwarded
    // with the real context as their `this` instead of the proxy.
    set(target, property, value) {
      Reflect.set(target, property, value, target);
      return true;
    },
  }) as CanvasRenderingContext2D;
  return { context: counting, fillRectCalls: () => fillRectCalls };
}

/** The measured gate counts particle points, so a wrong expansion fails loudly. */
function particlePointCount(evaluation: Evaluation): number {
  const particleCommands = evaluation.commands.filter(
    (command) => command.kind === "draw-particles",
  );
  const command = particleCommands[0];
  if (particleCommands.length !== 1 || !command) {
    throw new Error(
      "PERFORMANCE_PARTICLE_COMMAND_INVALID: expected exactly one draw-particles command",
    );
  }
  return command.points.length;
}

let fixtureHash: string | null = null;

/**
 * Computes the fixture hash with Web Crypto over the same scene-document
 * canonical bytes the Node-only canonical-hash module hashes with node:crypto;
 * the pinned SHA-256 in the Node suite and in the e2e spec binds both paths.
 */
const ready: Promise<void> = (async () => {
  const { bytes } = canonicalizeSceneDocument(referenceFixture());
  // Copy into a plain ArrayBuffer-backed view so the bytes satisfy the
  // WebCrypto BufferSource type (canonical bytes may be ArrayBufferLike).
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  fixtureHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
})();

const harness: PerformanceHarness = {
  ready,

  async describe() {
    await ready;
    if (!fixtureHash) throw new Error("PERFORMANCE_FIXTURE_HASH_MISSING");
    return {
      fixtureVersion: REFERENCE_FIXTURE_VERSION,
      fixtureHash,
      viewport: REFERENCE_VIEWPORT,
      particleCount: REFERENCE_PARTICLE_COUNT,
      runtimeVersion: RUNTIME_VERSION,
      buildMode: import.meta.env.PROD ? "production" : "development",
      sampleContract: {
        frameWarmupSamples: FRAME_WARMUP_SAMPLES,
        frameMeasuredSamples: FRAME_MEASURED_SAMPLES,
        seekWarmupSamples: SEEK_WARMUP_SAMPLES,
        seekMeasuredSamples: SEEK_MEASURED_SAMPLES,
        seekTargetUs: REFERENCE_DURATION_US,
      },
    };
  },

  warmupFrames(count: number): number {
    for (let index = 0; index < count; index += 1) {
      evaluateAndRender(sweepTimeUs(index, count));
    }
    return count;
  },

  measureFrames(count: number): number[] {
    const samples: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const startedAt = performance.now();
      evaluateAndRender(sweepTimeUs(index, count));
      samples.push(performance.now() - startedAt);
    }
    return samples;
  },

  measureFrameBatch(count: number): BatchRate {
    // Corroboration, not a gate: the frozen verdict still keys on the
    // per-sample median from measureFrames. Timing the whole batch with a
    // single performance.now() pair yields a figure that does not depend on
    // the timer quantum resolving every individual frame.
    const startedAt = performance.now();
    for (let index = 0; index < count; index += 1) {
      evaluateAndRender(sweepTimeUs(index, count));
    }
    return batchRateFromTotal({ totalMs: performance.now() - startedAt, count });
  },

  timerResolutionMs(): number {
    // Measures the effective performance.now() quantum by repeatedly taking
    // consecutive delta samples and keeping the smallest non-zero delta
    // observed. Documented fallback: 0 when no non-zero delta appears within
    // TIMER_RESOLUTION_ATTEMPTS attempts, which the spec treats as a failure
    // rather than silently reporting an unusable resolution.
    let smallestNonZeroDelta = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < TIMER_RESOLUTION_ATTEMPTS; attempt += 1) {
      const before = performance.now();
      const after = performance.now();
      const delta = after - before;
      if (delta > 0 && delta < smallestNonZeroDelta) {
        smallestNonZeroDelta = delta;
      }
    }
    return Number.isFinite(smallestNonZeroDelta) ? smallestNonZeroDelta : 0;
  },

  proveDrawWork(): DrawWorkProof {
    // Non-vacuity proof for the frame measurement: exactly one unrecorded
    // evaluate + render pass against a counting wrapper around the real 2d
    // context. This pass is never part of a measured sample; it only proves
    // that a measured sample really issues one Canvas2D fillRect per
    // particle point.
    const counting = countingCanvasContext();
    const evaluation = evaluateScene(referenceFixture(), sweepTimeUs(0, 1));
    renderCommands(counting.context, evaluation.commands);
    return {
      fillRectCalls: counting.fillRectCalls(),
      commands: evaluation.commands.length,
      points: particlePointCount(evaluation),
    };
  },

  measureSeeks(count: number) {
    const samples: SeekSample[] = [];
    for (let index = 0; index < count; index += 1) {
      // Every sample builds a fresh runtime from a fresh fixture: the seek
      // gate must never depend on transport reuse or prior seek history.
      const creationStartedAt = performance.now();
      const transport = createTimelineTransport(createReferenceFixture());
      const creationMs = performance.now() - creationStartedAt;

      // The performance gate applies to seekMs only; creationMs and points
      // are diagnostic context retained next to every sample.
      const seekStartedAt = performance.now();
      const evaluation = transport.seek(REFERENCE_DURATION_US);
      const seekMs = performance.now() - seekStartedAt;

      samples.push({
        seekMs,
        creationMs,
        points: particlePointCount(evaluation),
      });
    }
    return samples;
  },

  canvasSize() {
    const canvas = canvasElement();
    return { width: canvas.width, height: canvas.height };
  },
};

(globalThis as { __particleStudioPerformance?: PerformanceHarness })
  .__particleStudioPerformance = harness;
