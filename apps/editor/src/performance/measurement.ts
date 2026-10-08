/**
 * Pure, Node-testable measurement primitives for the performance harness.
 * Timing itself belongs to the browser harness; nothing here touches the DOM,
 * browser globals, or performance.now().
 */

export const PERFORMANCE_THRESHOLDS = {
  medianFrameMs: 16.7,
  seekMs: 100,
} as const;

export const FRAME_WARMUP_SAMPLES = 120;
export const FRAME_MEASURED_SAMPLES = 600;
export const SEEK_WARMUP_SAMPLES = 5;
export const SEEK_MEASURED_SAMPLES = 20;

export interface SampleSummary {
  readonly count: number;
  readonly min: number;
  /** Arithmetic mean of the samples (sum divided by count). */
  readonly mean: number;
  readonly median: number;
  readonly max: number;
}

/**
 * Median rule (single documented rule, exercised by tests): sort a copy of
 * the samples ascending; for an odd count the median is the middle value,
 * and for an even count it is the arithmetic mean of the two middle values.
 * The input array is never mutated.
 *
 * Empty input is rejected (PERFORMANCE_SAMPLES_EMPTY), so `mean` is only
 * defined for a non-empty sample set: an empty batch must use
 * `batchRateFromTotal`, whose documented count === 0 behaviour is meanMs 0
 * rather than NaN.
 */
export function summarizeSamples(samples: readonly number[]): SampleSummary {
  if (samples.length === 0) {
    throw new Error("PERFORMANCE_SAMPLES_EMPTY");
  }
  const sorted = [...samples].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? sorted[middle]!
      : (sorted[middle - 1]! + sorted[middle]!) / 2;
  const total = samples.reduce((sum, sample) => sum + sample, 0);
  return {
    count: sorted.length,
    min: sorted[0]!,
    mean: total / sorted.length,
    median,
    max: sorted[sorted.length - 1]!,
  };
}

export interface BatchRate {
  readonly totalMs: number;
  readonly count: number;
  readonly meanMs: number;
}

export interface BatchRateInput {
  readonly totalMs: number;
  readonly count: number;
}

/**
 * Corroborating batch rate for a whole-batch timing: the mean per-iteration
 * cost of `count` iterations timed together as `totalMs`. Documented
 * behaviour for an empty batch: count === 0 (or any non-positive count)
 * returns meanMs 0 rather than NaN, so the corroboration figure stays a
 * plain serializable number.
 */
export function batchRateFromTotal({
  totalMs,
  count,
}: BatchRateInput): BatchRate {
  return {
    totalMs,
    count,
    meanMs: count > 0 ? totalMs / count : 0,
  };
}

export type PerformanceThresholdKey = "medianFrameMs" | "seekMs";

export interface PerformanceVerdict {
  /** Median frame cost within PERFORMANCE_THRESHOLDS.medianFrameMs. */
  readonly framePass: boolean;
  /** Every seek sample within PERFORMANCE_THRESHOLDS.seekMs (max gate). */
  readonly seekPass: boolean;
  readonly passed: boolean;
  readonly failedThresholds: readonly PerformanceThresholdKey[];
  /** Observed median frame cost so the verdict can state it. */
  readonly observedMedianFrameMs: number;
  /** Observed maximum seek cost so the verdict can state it. */
  readonly observedMaxSeekMs: number;
}

export interface PerformanceVerdictInput {
  readonly frameSummary: SampleSummary;
  readonly seekSummary: SampleSummary;
}

/**
 * Decides the frozen performance gates. The frame gate is a median gate; the
 * seek gate is a strict every-sample gate expressed through the observed
 * maximum, so one extreme seek fails even when the median would pass.
 */
export function decidePerformanceVerdict({
  frameSummary,
  seekSummary,
}: PerformanceVerdictInput): PerformanceVerdict {
  const framePass = frameSummary.median <= PERFORMANCE_THRESHOLDS.medianFrameMs;
  const seekPass = seekSummary.max <= PERFORMANCE_THRESHOLDS.seekMs;
  const failedThresholds: PerformanceThresholdKey[] = [];
  if (!framePass) failedThresholds.push("medianFrameMs");
  if (!seekPass) failedThresholds.push("seekMs");
  return {
    framePass,
    seekPass,
    passed: framePass && seekPass,
    failedThresholds,
    observedMedianFrameMs: frameSummary.median,
    observedMaxSeekMs: seekSummary.max,
  };
}

export interface EnvironmentManifestInput {
  readonly os: string;
  readonly architecture: string;
  readonly cpu: string;
  readonly nodeVersion: string;
  readonly playwrightVersion: string;
  readonly chromiumVersion: string;
  readonly buildMode: string;
  readonly fixtureVersion: string;
  readonly fixtureHash: string;
  readonly runtimeVersion: string;
  /** Effective performance.now() quantum measured by the browser harness. */
  readonly timerResolutionMs: number;
  /** Real Canvas2D draw calls issued per measured sample (non-vacuity). */
  readonly drawCallsPerSample: number;
}

export interface EnvironmentManifest extends EnvironmentManifestInput {
  readonly frameWarmupSamples: number;
  readonly frameMeasuredSamples: number;
  readonly seekWarmupSamples: number;
  readonly seekMeasuredSamples: number;
}

/**
 * Builds the frozen design's environment manifest. Browser-owned facts
 * (Playwright/Chromium versions, build mode, fixture identity, runtime
 * version) are taken as inputs and never validated here; the browser harness
 * owns collecting them.
 */
export function buildEnvironmentManifest(
  input: EnvironmentManifestInput,
): EnvironmentManifest {
  return {
    os: input.os,
    architecture: input.architecture,
    cpu: input.cpu,
    nodeVersion: input.nodeVersion,
    playwrightVersion: input.playwrightVersion,
    chromiumVersion: input.chromiumVersion,
    buildMode: input.buildMode,
    fixtureVersion: input.fixtureVersion,
    fixtureHash: input.fixtureHash,
    runtimeVersion: input.runtimeVersion,
    timerResolutionMs: input.timerResolutionMs,
    drawCallsPerSample: input.drawCallsPerSample,
    frameWarmupSamples: FRAME_WARMUP_SAMPLES,
    frameMeasuredSamples: FRAME_MEASURED_SAMPLES,
    seekWarmupSamples: SEEK_WARMUP_SAMPLES,
    seekMeasuredSamples: SEEK_MEASURED_SAMPLES,
  };
}
