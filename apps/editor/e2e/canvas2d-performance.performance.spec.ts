import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import {
  buildEnvironmentManifest,
  decidePerformanceVerdict,
  FRAME_MEASURED_SAMPLES,
  FRAME_WARMUP_SAMPLES,
  PERFORMANCE_THRESHOLDS,
  SEEK_MEASURED_SAMPLES,
  SEEK_WARMUP_SAMPLES,
  summarizeSamples,
} from "../src/performance/measurement";
// Dependency-free constants module: loadable under Playwright's Node loader
// (it imports nothing, so the generated scene-document validator is never
// reached from the spec).
import {
  REFERENCE_DURATION_US,
  REFERENCE_FIXTURE_VERSION,
  REFERENCE_PARTICLE_COUNT,
  REFERENCE_VIEWPORT,
} from "../src/performance/reference-fixture-constants";

/**
 * The canonical fixture hash pinned by the R1a Node suite
 * (apps/editor/tests/performance/reference-fixture.test.ts). This stays a
 * literal in the spec, so bundle drift of the measured fixture fails loudly.
 */
const PINNED_FIXTURE_HASH =
  "4d13da5a4f38418d678410f56cc621dcfe3fab17c57fef7a5790d33a2e86e890";
const PINNED_RUNTIME_VERSION = "particle-studio-runtime-v1";

const HARNESS_GLOBAL = "__particleStudioPerformance";
const CANVAS_ID = "performance-canvas";

interface PerformanceSampleContract {
  readonly frameWarmupSamples: number;
  readonly frameMeasuredSamples: number;
  readonly seekWarmupSamples: number;
  readonly seekMeasuredSamples: number;
  readonly seekTargetUs: number;
}

interface PerformanceHarnessDescription {
  readonly fixtureVersion: string;
  readonly fixtureHash: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly particleCount: number;
  readonly runtimeVersion: string;
  readonly buildMode: "production" | "development";
  readonly sampleContract: PerformanceSampleContract;
}

interface SeekSample {
  readonly seekMs: number;
  readonly creationMs: number;
  readonly points: number;
}

/** Resolution-independent batch corroboration for the per-sample median. */
interface BatchRate {
  readonly totalMs: number;
  readonly count: number;
  readonly meanMs: number;
}

/** Non-vacuity proof for the frame measurement (real draw-call count). */
interface DrawWorkProof {
  readonly fillRectCalls: number;
  readonly commands: number;
  readonly points: number;
}

interface PerformanceHarness {
  readonly ready: Promise<void>;
  describe(): Promise<PerformanceHarnessDescription>;
  warmupFrames(count: number): number;
  measureFrames(count: number): number[];
  measureFrameBatch(count: number): BatchRate;
  measureSeeks(count: number): SeekSample[];
  timerResolutionMs(): number;
  proveDrawWork(): DrawWorkProof;
  canvasSize(): { readonly width: number; readonly height: number };
}

/**
 * Navigates to the measurement page, waits for the harness global, and waits
 * for `ready` (the Web Crypto canonical fixture hash) before any call.
 */
async function openMeasurementPage(page: Page): Promise<void> {
  await page.goto("/performance.html");
  await page.waitForFunction(
    (globalName) =>
      typeof (globalThis as Record<string, unknown>)[globalName] === "object",
    HARNESS_GLOBAL,
    // waitForFunction has no default timeout; bound it so a missing harness
    // fails this assertion instead of burning the whole test timeout.
    { timeout: 30_000 },
  );
  await page.evaluate(async (globalName) => {
    const harness = (globalThis as Record<string, unknown>)[
      globalName
    ] as PerformanceHarness;
    await harness.ready;
  }, HARNESS_GLOBAL);
}

/** Calls one harness method through the installed measurement global. */
async function callHarness<T>(
  page: Page,
  method: keyof PerformanceHarness,
  args: readonly unknown[] = [],
): Promise<T> {
  return page.evaluate(
    ({ globalName, harnessMethod, harnessArgs }) => {
      const harness = (globalThis as Record<string, unknown>)[
        globalName
      ] as PerformanceHarness;
      if (!harness) throw new Error("PERFORMANCE_HARNESS_MISSING");
      const operation = harness[harnessMethod] as (
        ...callArgs: unknown[]
      ) => unknown;
      return operation.apply(harness, harnessArgs) as T;
    },
    {
      globalName: HARNESS_GLOBAL,
      harnessMethod: method,
      harnessArgs: [...args],
    },
  );
}

interface EvidenceInput {
  readonly evidenceDir: string;
  readonly manifest: ReturnType<typeof buildEnvironmentManifest>;
  readonly frameSamples: readonly number[];
  readonly seekSamples: readonly SeekSample[];
  readonly frameSummary: ReturnType<typeof summarizeSamples>;
  readonly seekSummary: ReturnType<typeof summarizeSamples>;
  readonly verdict: ReturnType<typeof decidePerformanceVerdict>;
  readonly batchRate: BatchRate;
  readonly timerResolutionMs: number;
  readonly proof: DrawWorkProof;
}

/** Writes the three retained R1 evidence artifacts into the evidence directory. */
async function writeEvidence(input: EvidenceInput): Promise<void> {
  const { evidenceDir } = input;
  await mkdir(evidenceDir, { recursive: true });
  const artifacts: readonly [string, string][] = [
    [
      "environment-manifest.json",
      `${JSON.stringify(input.manifest, null, 2)}\n`,
    ],
    [
      "raw-samples.json",
      `${JSON.stringify(
        {
          frames: input.frameSamples,
          seeks: input.seekSamples,
          // Corroboration and non-vacuity proof live beside the raw samples:
          // the frozen gate keys on `frames` alone, these keys only add
          // evidence for how strong the median-based verdict is.
          batch: input.batchRate,
          drawWorkProof: input.proof,
        },
        null,
      2,
      )}\n`,
    ],
    [
      "summary.json",
      `${JSON.stringify(
        {
          thresholds: PERFORMANCE_THRESHOLDS,
          frame: input.frameSummary,
          seek: input.seekSummary,
          verdict: input.verdict,
          batchRate: input.batchRate,
          timerResolutionMs: input.timerResolutionMs,
        },
        null,
      2,
      )}\n`,
    ],
  ];
  try {
    await Promise.all(
      artifacts.map(([name, contents]) =>
        writeFile(path.join(evidenceDir, name), contents),
      ),
    );
  } catch (error) {
    throw new Error(`PERFORMANCE_EVIDENCE_WRITE_FAILED: ${String(error)}`);
  }
}

/**
 * Slow measurements never fail the suite unless enforcement is explicit:
 * with PARTICLE_STUDIO_PERF_ENFORCE=1 a miss must name the observed value.
 */
function assertThresholdsWhenEnforced(
  verdict: ReturnType<typeof decidePerformanceVerdict>,
  frameSummary: ReturnType<typeof summarizeSamples>,
  seekSummary: ReturnType<typeof summarizeSamples>,
): void {
  if (process.env.PARTICLE_STUDIO_PERF_ENFORCE !== "1") return;
  const failures: string[] = [];
  if (!verdict.framePass) {
    failures.push(
      `median frame cost ${frameSummary.median.toFixed(3)} ms exceeded the ${PERFORMANCE_THRESHOLDS.medianFrameMs} ms threshold`,
    );
  }
  if (!verdict.seekPass) {
    failures.push(
      `worst seek sample ${seekSummary.max.toFixed(3)} ms exceeded the ${PERFORMANCE_THRESHOLDS.seekMs} ms threshold`,
    );
  }
  expect(
    failures,
    `Canvas2D performance thresholds missed: ${failures.join("; ")}`,
  ).toEqual([]);
}

test(
  "serves the production measurement page with the frozen harness contract",
  async ({ page }) => {
    await openMeasurementPage(page);

    const description = await callHarness<PerformanceHarnessDescription>(
      page,
      "describe",
    );

    // The measurement must run against the production build, not a dev server.
    expect(description.buildMode).toBe("production");

    // No editor chrome may sit in the measurement path: no React root, no
    // editor markup, exactly one canvas as the only body child.
    expect(await page.locator("#root").count()).toBe(0);
    const bodyChildren = await page.evaluate(
      () => Array.from(document.body.children).map((element) => element.id),
    );
    expect(bodyChildren).toEqual([CANVAS_ID]);

    // The canvas backing store must be exactly the reference viewport.
    expect(await callHarness(page, "canvasSize")).toEqual(REFERENCE_VIEWPORT);

    // The frozen harness contract: versioned fixture identity, pinned hash,
    // runtime version, and the exact warmup/measured sample counts.
    expect(description.fixtureVersion).toBe(REFERENCE_FIXTURE_VERSION);
    expect(description.fixtureHash).toBe(PINNED_FIXTURE_HASH);
    expect(description.viewport).toEqual(REFERENCE_VIEWPORT);
    expect(description.particleCount).toBe(REFERENCE_PARTICLE_COUNT);
    expect(description.runtimeVersion).toBe(PINNED_RUNTIME_VERSION);
    expect(description.sampleContract).toEqual({
      frameWarmupSamples: FRAME_WARMUP_SAMPLES,
      frameMeasuredSamples: FRAME_MEASURED_SAMPLES,
      seekWarmupSamples: SEEK_WARMUP_SAMPLES,
      seekMeasuredSamples: SEEK_MEASURED_SAMPLES,
      seekTargetUs: REFERENCE_DURATION_US,
    });
  },
);

test(
  "measures Canvas2D frame and seek cost and retains R1 evidence",
  async ({ page, browser }) => {
    // 600 frame samples plus 25 fresh-runtime seeks can exceed the default
    // timeout on a loaded machine; the measurement itself must never be cut.
    test.setTimeout(600_000);

    await openMeasurementPage(page);

    // Warmups are unrecorded by contract: the returned count proves they ran.
    expect(
      await callHarness<number>(page, "warmupFrames", [FRAME_WARMUP_SAMPLES]),
    ).toBe(FRAME_WARMUP_SAMPLES);

    const frameSamples = await callHarness<number[]>(page, "measureFrames", [
      FRAME_MEASURED_SAMPLES,
    ]);
    expect(frameSamples).toHaveLength(FRAME_MEASURED_SAMPLES);
    for (const sample of frameSamples) {
      expect(Number.isFinite(sample)).toBe(true);
      expect(sample).toBeGreaterThanOrEqual(0);
    }

    // Non-vacuity proof: one unrecorded pass with a counting context must
    // issue exactly one real Canvas2D fillRect per particle point, so the
    // measured samples demonstrably draw 1,000 rectangles per sample.
    const proof = await callHarness<DrawWorkProof>(page, "proveDrawWork");
    expect(proof.fillRectCalls).toBe(REFERENCE_PARTICLE_COUNT);
    expect(proof.points).toBe(REFERENCE_PARTICLE_COUNT);
    expect(proof.commands).toBeGreaterThan(0);

    // Timer resolution corroboration: the per-sample median is only as good
    // as the performance.now() quantum behind it, so record that quantum.
    const timerResolutionMs = await callHarness<number>(
      page,
      "timerResolutionMs",
    );
    expect(Number.isFinite(timerResolutionMs)).toBe(true);
    expect(timerResolutionMs).toBeGreaterThan(0);

    // Resolution-independent batch corroboration: one timing pair over the
    // whole batch. This is recorded evidence, never a gate.
    const batchRate = await callHarness<BatchRate>(page, "measureFrameBatch", [
      FRAME_MEASURED_SAMPLES,
    ]);
    expect(batchRate.count).toBe(FRAME_MEASURED_SAMPLES);
    expect(Number.isFinite(batchRate.totalMs)).toBe(true);
    expect(batchRate.totalMs).toBeGreaterThan(0);
    expect(Number.isFinite(batchRate.meanMs)).toBe(true);
    expect(batchRate.meanMs).toBeGreaterThan(0);

    // Seek warmups run on the same fresh-runtime path and are discarded.
    await callHarness(page, "measureSeeks", [SEEK_WARMUP_SAMPLES]);

    const seekSamples = await callHarness<SeekSample[]>(page, "measureSeeks", [
      SEEK_MEASURED_SAMPLES,
    ]);
    expect(seekSamples).toHaveLength(SEEK_MEASURED_SAMPLES);
    for (const sample of seekSamples) {
      // Every measured seek must have expanded exactly 1,000 particle points.
      expect(sample.points).toBe(REFERENCE_PARTICLE_COUNT);
    }

    // Summarize in Node with the R1a primitives, then retain the evidence
    // before any threshold assertion so a miss is never lost: the verdict
    // decision belongs to the evidence, not to the runner.
    const frameSummary = summarizeSamples(frameSamples);
    const seekSummary = summarizeSamples(
      seekSamples.map((sample) => sample.seekMs),
    );
    const verdict = decidePerformanceVerdict({ frameSummary, seekSummary });

    const description = await callHarness<PerformanceHarnessDescription>(
      page,
      "describe",
    );
    const manifest = buildEnvironmentManifest({
      os: os.platform(),
      architecture: os.arch(),
      cpu: os.cpus()[0]?.model ?? "unknown",
      nodeVersion: process.version,
      playwrightVersion: test.info().config.version,
      chromiumVersion: browser.version(),
      buildMode: description.buildMode,
      fixtureVersion: description.fixtureVersion,
      fixtureHash: description.fixtureHash,
      runtimeVersion: description.runtimeVersion,
      timerResolutionMs,
      drawCallsPerSample: proof.fillRectCalls,
    });

    const evidenceDir = path.resolve(
      path.dirname(test.info().file),
      "../../..",
      "odd/evidence/r1-canvas2d-performance",
    );
    await writeEvidence({
      evidenceDir,
      manifest,
      frameSamples,
      seekSamples,
      frameSummary,
      seekSummary,
      verdict,
      batchRate,
      timerResolutionMs,
      proof,
    });

    assertThresholdsWhenEnforced(verdict, frameSummary, seekSummary);
  },
);
