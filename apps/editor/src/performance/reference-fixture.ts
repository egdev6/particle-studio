import type { SceneDocumentV1 } from "@particle-studio/scene-document";

import {
  REFERENCE_DURATION_US,
  REFERENCE_PARTICLE_COUNT,
  REFERENCE_SEED,
  REFERENCE_VIEWPORT,
} from "./reference-fixture-constants.js";

// Re-export the frozen constants so every existing importer of this module
// keeps working; the constants themselves live dependency-free in
// ./reference-fixture-constants.ts, which loads in the browser bundle, under
// Vitest, and under Playwright's Node loader alike.
export {
  REFERENCE_DURATION_US,
  REFERENCE_FIXTURE_VERSION,
  REFERENCE_PARTICLE_COUNT,
  REFERENCE_SEED,
  REFERENCE_VIEWPORT,
} from "./reference-fixture-constants.js";

// Particle field geometry: a 1920x1080-centered emitter whose 900 px spread
// plus its drift over ten seconds (10 px/s over 600 steps = +/-100 px) covers
// the whole reference viewport. lifetimeSteps = 1000 keeps the full ten
// seconds (600 completed steps at 60 Hz) inside the first lifetime cycle, so
// the seek measurement never depends on particle re-spawning.
const PARTICLE_ELEMENT_ID = "ref-particle-field";

// The opacity track spans the full timeline with keyframes exactly at 0 and
// at REFERENCE_DURATION_US (the frozen validator domain forbids keyframes
// beyond durationUs). A seek to exactly 10 s therefore returns the final
// keyframe value, while every interior time performs real linear
// interpolation work — exercised by the 5 s seam test.
const OPACITY_TRACK_END_US = REFERENCE_DURATION_US;

/**
 * Builds a fresh, deeply independent, deterministic reference scene document
 * that passes the real generated scene-document validator. Every call returns
 * newly allocated object literals; mutating one returned fixture never
 * affects any other fixture.
 *
 * Browser-safe by contract: this module imports nothing at runtime except the
 * dependency-free constants module and performs no Node, crypto, Date, or
 * performance access anywhere.
 */
export function createReferenceFixture(): SceneDocumentV1 {
  return {
    schemaVersion: 1,
    durationUs: REFERENCE_DURATION_US,
    playbackRange: { startUs: 0, endUs: REFERENCE_DURATION_US },
    loop: true,
    seed: REFERENCE_SEED,
    rootIds: [PARTICLE_ELEMENT_ID],
    elements: [
      {
        id: PARTICLE_ELEMENT_ID,
        type: "particle",
        count: REFERENCE_PARTICLE_COUNT,
        x: REFERENCE_VIEWPORT.width / 2,
        y: REFERENCE_VIEWPORT.height / 2,
        velocityX: 10,
        velocityY: -10,
        spread: 900,
        size: 2,
        opacity: 1,
        lifetimeSteps: 1000,
      },
    ],
    tracks: [
      {
        elementId: PARTICLE_ELEMENT_ID,
        property: "opacity",
        interpolation: "linear",
        easing: "linear",
        keyframes: [
          { timeUs: 0, value: 1 },
          { timeUs: OPACITY_TRACK_END_US, value: 0.4 },
        ],
      },
    ],
  };
}
