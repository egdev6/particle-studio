import { describe, expect, it } from "vitest";
import {
  FRAME_MEASURED_SAMPLES,
  FRAME_WARMUP_SAMPLES,
  PERFORMANCE_THRESHOLDS,
  SEEK_MEASURED_SAMPLES,
  SEEK_WARMUP_SAMPLES,
  buildEnvironmentManifest,
  batchRateFromTotal,
  decidePerformanceVerdict,
  summarizeSamples,
} from "../../src/performance/measurement.js";

describe("measurement constants", () => {
  it("pins the frozen harness thresholds and sample budgets", () => {
    expect(PERFORMANCE_THRESHOLDS).toEqual({
      medianFrameMs: 16.7,
      seekMs: 100,
    });
    expect(FRAME_WARMUP_SAMPLES).toBe(120);
    expect(FRAME_MEASURED_SAMPLES).toBe(600);
    expect(SEEK_WARMUP_SAMPLES).toBe(5);
    expect(SEEK_MEASURED_SAMPLES).toBe(20);
  });
});

describe("summarizeSamples", () => {
  it("uses the middle value for an odd count", () => {
    expect(summarizeSamples([3, 1, 2])).toEqual({
      count: 3,
      min: 1,
      mean: 2,
      median: 2,
      max: 3,
    });
  });

  it("uses the mean of the two middle values for an even count", () => {
    expect(summarizeSamples([4, 1, 3, 2])).toEqual({
      count: 4,
      min: 1,
      mean: 2.5,
      median: 2.5,
      max: 4,
    });
  });

  it("summarizes a single sample", () => {
    expect(summarizeSamples([7])).toEqual({
      count: 1,
      min: 7,
      mean: 7,
      median: 7,
      max: 7,
    });
  });

  it("reports the arithmetic mean of the samples", () => {
    expect(summarizeSamples([1, 2, 3, 10]).mean).toBe(4);
  });

  it("rejects an empty input instead of reporting a zero mean", () => {
    expect(() => summarizeSamples([])).toThrow("PERFORMANCE_SAMPLES_EMPTY");
  });

  it("does not mutate the input array", () => {
    const samples = [9, 2, 5, 1];
    const snapshot = [...samples];
    summarizeSamples(samples);
    expect(samples).toEqual(snapshot);
  });
});

describe("batchRateFromTotal", () => {
  it("divides the batch total by the call count", () => {
    expect(batchRateFromTotal({ totalMs: 100, count: 4 })).toEqual({
      totalMs: 100,
      count: 4,
      meanMs: 25,
    });
  });

  it("returns meanMs 0 instead of NaN for an empty batch", () => {
    expect(batchRateFromTotal({ totalMs: 0, count: 0 })).toEqual({
      totalMs: 0,
      count: 0,
      meanMs: 0,
    });
  });

  it("keeps fractional means exact enough for corroboration", () => {
    const rate = batchRateFromTotal({ totalMs: 1, count: 3 });
    expect(rate.meanMs).toBeCloseTo(1 / 3, 12);
  });
});

describe("decidePerformanceVerdict", () => {
  it("passes when both gates hold", () => {
    const frameSummary = summarizeSamples([16, 15, 17]);
    const seekSummary = summarizeSamples([40, 60, 99]);
    const verdict = decidePerformanceVerdict({ frameSummary, seekSummary });
    expect(verdict).toEqual({
      framePass: true,
      seekPass: true,
      passed: true,
      failedThresholds: [],
      observedMedianFrameMs: 16,
      observedMaxSeekMs: 99,
    });
  });

  it("fails only the frame gate when the median frame cost misses", () => {
    const frameSummary = summarizeSamples([20, 21, 22]);
    const seekSummary = summarizeSamples([10, 20, 30]);
    const verdict = decidePerformanceVerdict({ frameSummary, seekSummary });
    expect(verdict.framePass).toBe(false);
    expect(verdict.seekPass).toBe(true);
    expect(verdict.passed).toBe(false);
    expect(verdict.failedThresholds).toEqual(["medianFrameMs"]);
    expect(verdict.observedMedianFrameMs).toBe(21);
  });

  it("fails the seek gate on one extreme sample even when the median would pass", () => {
    const frameSummary = summarizeSamples([15, 16, 17]);
    // Median 99 ms would pass, but one 250 ms seek must fail the gate.
    const seekSamples = Array.from({ length: 19 }, () => 99).concat(250);
    const seekSummary = summarizeSamples(seekSamples);
    expect(seekSummary.median).toBeLessThanOrEqual(
      PERFORMANCE_THRESHOLDS.seekMs,
    );
    const verdict = decidePerformanceVerdict({ frameSummary, seekSummary });
    expect(verdict.framePass).toBe(true);
    expect(verdict.seekPass).toBe(false);
    expect(verdict.passed).toBe(false);
    expect(verdict.failedThresholds).toEqual(["seekMs"]);
    expect(verdict.observedMaxSeekMs).toBe(250);
  });

  it("fails both gates when both miss", () => {
    const frameSummary = summarizeSamples([30, 31, 32]);
    const seekSummary = summarizeSamples([120, 130, 140]);
    const verdict = decidePerformanceVerdict({ frameSummary, seekSummary });
    expect(verdict.passed).toBe(false);
    expect(verdict.failedThresholds).toEqual(["medianFrameMs", "seekMs"]);
  });
});

describe("buildEnvironmentManifest", () => {
  it("returns exactly the frozen design manifest fields", () => {
    const manifest = buildEnvironmentManifest({
      os: "linux",
      architecture: "x64",
      cpu: "Test CPU",
      nodeVersion: "v24.0.0",
      playwrightVersion: "1.0.0",
      chromiumVersion: "130.0.0",
      buildMode: "production",
      fixtureVersion: "canvas2d-particles-1000-v1",
      fixtureHash: "abc",
      runtimeVersion: "particle-studio-runtime-v1",
      timerResolutionMs: 0.1,
      drawCallsPerSample: 1000,
    });
    expect(Object.keys(manifest).sort()).toEqual(
      [
        "os",
        "architecture",
        "cpu",
        "nodeVersion",
        "playwrightVersion",
        "chromiumVersion",
        "buildMode",
        "fixtureVersion",
        "fixtureHash",
        "runtimeVersion",
        "timerResolutionMs",
        "drawCallsPerSample",
        "frameWarmupSamples",
        "frameMeasuredSamples",
        "seekWarmupSamples",
        "seekMeasuredSamples",
      ].sort(),
    );
    expect(manifest.frameWarmupSamples).toBe(FRAME_WARMUP_SAMPLES);
    expect(manifest.frameMeasuredSamples).toBe(FRAME_MEASURED_SAMPLES);
    expect(manifest.seekWarmupSamples).toBe(SEEK_WARMUP_SAMPLES);
    expect(manifest.seekMeasuredSamples).toBe(SEEK_MEASURED_SAMPLES);
    expect(manifest.timerResolutionMs).toBe(0.1);
    expect(manifest.drawCallsPerSample).toBe(1000);
  });

  it("returns a plain serializable object", () => {
    const manifest = buildEnvironmentManifest({
      os: "linux",
      architecture: "arm64",
      cpu: "Test CPU",
      nodeVersion: "v24.0.0",
      playwrightVersion: "1.0.0",
      chromiumVersion: "130.0.0",
      buildMode: "production",
      fixtureVersion: "canvas2d-particles-1000-v1",
      fixtureHash: "abc",
      runtimeVersion: "particle-studio-runtime-v1",
      timerResolutionMs: 0.2,
      drawCallsPerSample: 1000,
    });
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
    expect(Object.getPrototypeOf(manifest)).toBe(Object.prototype);
  });
});
