/**
 * Frozen reference-scene constants for the Canvas2D performance gate.
 *
 * Dependency-free by contract: this module must load identically in the
 * browser bundle, under Vitest, and under Playwright's Node loader. It
 * imports nothing at all and must stay that way.
 */

/**
 * Version of the frozen performance reference scene. Bumping this string is a
 * breaking change for every retained performance receipt and must never happen
 * silently: the canonical hash is pinned in the Node test suite.
 */
export const REFERENCE_FIXTURE_VERSION = "canvas2d-particles-1000-v1";

export const REFERENCE_VIEWPORT = { width: 1920, height: 1080 } as const;

export const REFERENCE_PARTICLE_COUNT = 1000;

/** Ten seconds of timeline, matching the frozen seek target. */
export const REFERENCE_DURATION_US = 10_000_000;

/** Fixed integer seed inside the schema range [0, 0xffffffff]. */
export const REFERENCE_SEED = 0x5eed_cafe;
