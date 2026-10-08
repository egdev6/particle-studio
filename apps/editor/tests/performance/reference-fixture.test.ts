import { describe, expect, it } from "vitest";
import {
  canonicalizeSceneDocument,
  validateSceneDocument,
  type SceneDocumentV1,
} from "@particle-studio/scene-document";
import { evaluateScene, RUNTIME_VERSION } from "@particle-studio/runtime";
import {
  REFERENCE_DURATION_US,
  REFERENCE_FIXTURE_VERSION,
  REFERENCE_PARTICLE_COUNT,
  REFERENCE_SEED,
  REFERENCE_VIEWPORT,
  createReferenceFixture,
} from "../../src/performance/reference-fixture.js";
import { referenceFixtureCanonicalHash } from "../../src/performance/reference-fixture-canonical-hash.js";

// apps/editor/tsconfig.json restricts "types" to vitest/globals, so @types/node
// is not part of this program and "node:*" module specifiers do not resolve.
// process.getBuiltinModule reaches the same Node built-ins at runtime without
// changing the editor compiler options (same pattern as netlify-deployment).
type NodeCryptoModule = {
  createHash(algorithm: "sha256"): {
    update(bytes: Uint8Array): { digest(encoding: "hex"): string };
  };
};
const nodeProcess = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: string): unknown };
  }
).process;
const nodeCrypto = nodeProcess.getBuiltinModule("node:crypto") as NodeCryptoModule;

const bytesEqual = (first: Uint8Array, second: Uint8Array) =>
  first.length === second.length &&
  first.every((byte, index) => byte === second[index]);

const expectParticleElement = (fixture: SceneDocumentV1) => {
  const element = fixture.elements[0]!;
  if (element.type !== "particle") {
    throw new Error(`expected a particle element, got ${element.type}`);
  }
  return element;
};

// Pinned once from the implemented fixture; any future fixture drift that
// changes the canonical bytes must fail here loudly.
const PINNED_REFERENCE_FIXTURE_SHA256 =
  "4d13da5a4f38418d678410f56cc621dcfe3fab17c57fef7a5790d33a2e86e890";
const PINNED_CANONICAL_BYTE_LENGTH = 504;

describe("reference fixture constants", () => {
  it("pins the frozen reference scene constants", () => {
    expect(REFERENCE_FIXTURE_VERSION).toBe("canvas2d-particles-1000-v1");
    expect(REFERENCE_VIEWPORT).toEqual({ width: 1920, height: 1080 });
    expect(REFERENCE_PARTICLE_COUNT).toBe(1000);
    expect(REFERENCE_DURATION_US).toBe(10_000_000);
    expect(Number.isInteger(REFERENCE_SEED)).toBe(true);
    expect(REFERENCE_SEED).toBeGreaterThanOrEqual(0);
    expect(REFERENCE_SEED).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("createReferenceFixture", () => {
  it("produces a document accepted by the real generated validator", () => {
    const validation = validateSceneDocument(createReferenceFixture());
    expect(validation.ok).toBe(true);
  });

  it("is deterministic across repeated calls", () => {
    const first = createReferenceFixture();
    const second = createReferenceFixture();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("makes two independently created instances deeply independent", () => {
    const first = createReferenceFixture();
    const second = createReferenceFixture();
    expectParticleElement(first).count = 1;
    expect(expectParticleElement(second).count).toBe(REFERENCE_PARTICLE_COUNT);
    expect(second.elements).not.toBe(first.elements);
    expect(JSON.stringify(createReferenceFixture())).toBe(
      JSON.stringify(second),
    );
  });

  it("is unaffected in later calls by mutating one returned fixture", () => {
    const mutated = createReferenceFixture();
    mutated.durationUs = 1;
    mutated.tracks[0]!.keyframes[0]!.timeUs = 999;
    const fresh = createReferenceFixture();
    expect(fresh.durationUs).toBe(REFERENCE_DURATION_US);
    expect(fresh.tracks[0]!.keyframes[0]!.timeUs).toBe(0);
  });

  it("produces byte-identical canonical bytes for independent instances", () => {
    const canonicalFirst = canonicalizeSceneDocument(
      createReferenceFixture(),
    ).bytes;
    const canonicalSecond = canonicalizeSceneDocument(
      createReferenceFixture(),
    ).bytes;
    expect(bytesEqual(canonicalFirst, canonicalSecond)).toBe(true);
  });

  it("pins the frozen shape facts of the reference scene", () => {
    const fixture: SceneDocumentV1 = createReferenceFixture();
    expect(fixture.durationUs).toBe(10_000_000);
    expect(fixture.playbackRange).toEqual({
      startUs: 0,
      endUs: 10_000_000,
    });
    expect(fixture.elements).toHaveLength(1);
    const particle = expectParticleElement(fixture);
    expect(particle.count).toBe(1000);
    expect(fixture.rootIds).toEqual([particle.id]);
    expect(fixture.tracks).toHaveLength(1);
    const track = fixture.tracks[0]!;
    expect(track.elementId).toBe(particle.id);
    expect(track.property).toBe("opacity");
    expect(track.keyframes.length).toBeGreaterThanOrEqual(2);
    expect(track.keyframes[0]!.timeUs).toBe(0);
    expect(track.keyframes.at(-1)!.timeUs).toBe(10_000_000);
  });

  it("keeps the whole ten seconds inside the first particle lifetime cycle", () => {
    const fixture = createReferenceFixture();
    const particle = expectParticleElement(fixture);
    expect(particle.lifetimeSteps).toBe(1000);
    // 10 s at 60 Hz completes exactly 600 steps, well below lifetimeSteps,
    // so no seek in [0, 10 s] ever re-spawns particles across a cycle.
    expect(600).toBeLessThan(particle.lifetimeSteps);
  });
});

describe("referenceFixtureCanonicalHash", () => {
  it("matches the pinned canonical SHA-256 constant", () => {
    expect(referenceFixtureCanonicalHash()).toBe(
      PINNED_REFERENCE_FIXTURE_SHA256,
    );
  });

  it("hashes exactly the scene-document canonical bytes", () => {
    const canonical = canonicalizeSceneDocument(createReferenceFixture());
    expect(canonical.bytes.length).toBe(PINNED_CANONICAL_BYTE_LENGTH);
    expect(referenceFixtureCanonicalHash()).toBe(
      nodeCrypto.createHash("sha256").update(canonical.bytes).digest("hex"),
    );
  });

  it("returns lowercase hex and is stable across calls", () => {
    const first = referenceFixtureCanonicalHash();
    const second = referenceFixtureCanonicalHash();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });
});

describe("fixture/runtime seam", () => {
  it("draws 1000 particles from a seek to exactly 10 seconds", () => {
    const result = evaluateScene(createReferenceFixture(), 10_000_000);
    const particleCommands = result.commands.filter(
      (command) => command.kind === "draw-particles",
    );
    expect(particleCommands).toHaveLength(1);
    const command = particleCommands[0]!;
    if (command.kind !== "draw-particles") {
      throw new Error("unreachable");
    }
    expect(command.points).toHaveLength(1000);
    expect(result.state.completedStep).toBe(600);
  });

  it("interpolates the opacity track at an interior seek time", () => {
    // The validator domain forbids keyframes beyond durationUs, so a seek to
    // exactly 10 s returns the final keyframe value; real interpolation work
    // is proven at the midpoint of the [0, 10 s] track instead.
    const result = evaluateScene(createReferenceFixture(), 5_000_000);
    const element = result.state.elements[0]!;
    if (element.type !== "particle") {
      throw new Error("unreachable");
    }
    expect(element.opacity).toBe(0.7);
  });

  it("runs against the pinned runtime version", () => {
    expect(RUNTIME_VERSION).toBe("particle-studio-runtime-v1");
  });
});
