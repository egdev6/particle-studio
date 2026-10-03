import type { SceneDocumentV1 } from "@particle-studio/scene-document";

// A string is immutable; the structural root is valid but emits no primitives.
export const EMPTY_SCENE_JSON = JSON.stringify({
  schemaVersion: 1,
  durationUs: 1_000_000,
  playbackRange: { startUs: 0, endUs: 1_000_000 },
  loop: true,
  seed: 42,
  tracks: [],
  rootIds: ["root"],
  elements: [{ id: "root", type: "group", childrenIds: [] }],
} satisfies SceneDocumentV1);
