import validate, {
  SCENE_DOCUMENT_V1_VALIDATOR_CONTRACT,
} from "../generated/scene-document-v1-validator.generated.mjs";
import type { SceneDocumentV1 } from "../schemas/scene-document-v1.js";
import { EXPECTED_SCENE_DOCUMENT_V1_VALIDATOR_CONTRACT } from "./scene-document-v1-validator-contract.js";

if (
  SCENE_DOCUMENT_V1_VALIDATOR_CONTRACT !==
  EXPECTED_SCENE_DOCUMENT_V1_VALIDATOR_CONTRACT
) {
  throw new Error("VALIDATOR_CONTRACT_MISMATCH");
}

export type SceneDocumentValidationErrorCode =
  | "SCENE_DOCUMENT_SCHEMA_VERSION_MISSING"
  | "SCENE_DOCUMENT_SCHEMA_VERSION_UNSUPPORTED"
  | "SCENE_DOCUMENT_INVALID";

export type SceneDocumentValidationResult =
  | { readonly ok: true; readonly value: SceneDocumentV1 }
  | {
      readonly ok: false;
      readonly error: { readonly code: SceneDocumentValidationErrorCode };
    };

type SceneDocumentImportErrorCode =
  | "SCENE_DOCUMENT_IMPORT_INVALID_JSON"
  | "SCENE_DOCUMENT_IMPORT_SCHEMA_VERSION_UNSUPPORTED"
  | "SCENE_DOCUMENT_IMPORT_VALIDATION_FAILED";

type SceneDocumentImportResult =
  | { readonly ok: true; readonly value: SceneDocumentV1 }
  | {
      readonly ok: false;
      readonly error: { readonly code: SceneDocumentImportErrorCode };
    };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUniqueValues(values: readonly string[]) {
  return new Set(values).size === values.length;
}

function copySceneDocument(document: SceneDocumentV1): SceneDocumentV1 {
  // SAFETY: Node 24 and supported browsers provide structuredClone for JSON values.
  return (
    globalThis as unknown as {
      structuredClone: <Value>(value: Value) => Value;
    }
  ).structuredClone(document);
}

function importError(
  code: SceneDocumentImportErrorCode,
): SceneDocumentImportResult {
  return { ok: false, error: { code } };
}

function hasHierarchy(document: SceneDocumentV1) {
  const elementsById = new Map(
    document.elements.map((element) => [element.id, element]),
  );
  if (
    elementsById.size !== document.elements.length ||
    !hasUniqueValues(document.rootIds)
  ) {
    return false;
  }

  const ownership = new Map(
    document.elements.map((element) => [element.id, 0]),
  );
  for (const rootId of document.rootIds) {
    if (!ownership.has(rootId)) return false;
    ownership.set(rootId, (ownership.get(rootId) ?? 0) + 1);
  }

  const groups = new Map(
    document.elements
      .filter((element) => element.type === "group")
      .map((element) => [element.id, element]),
  );
  for (const group of groups.values()) {
    if (!hasUniqueValues(group.childrenIds)) return false;
    for (const childId of group.childrenIds) {
      if (childId === group.id || !ownership.has(childId)) return false;
      ownership.set(childId, (ownership.get(childId) ?? 0) + 1);
    }
  }
  if ([...ownership.values()].some((count) => count !== 1)) return false;

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (groupId: string): boolean => {
    if (visiting.has(groupId)) return false;
    if (visited.has(groupId)) return true;
    visiting.add(groupId);
    for (const childId of groups.get(groupId)?.childrenIds ?? []) {
      if (groups.has(childId) && !visit(childId)) return false;
    }
    visiting.delete(groupId);
    visited.add(groupId);
    return true;
  };
  return [...groups.keys()].every(visit);
}

function hasValidV1Domain(document: SceneDocumentV1) {
  return (
    document.playbackRange.startUs < document.playbackRange.endUs &&
    document.playbackRange.endUs <= document.durationUs &&
    hasHierarchy(document) &&
    hasUniqueValues(
      document.tracks.map((track) => `${track.elementId}:${track.property}`),
    ) &&
    document.tracks.every((track) => {
      const target = document.elements.find(
        (element) => element.id === track.elementId,
      );
      if (!target || target.type === "group") return false;
      if (track.property === "text.text" && target.type !== "text")
        return false;
      if (
        track.property === "opacity" &&
        (target.type === "text" ||
          target.type === "image" ||
          target.type === "particle") &&
        !track.keyframes.every(
          (keyframe) => keyframe.value >= 0 && keyframe.value <= 1,
        )
      )
        return false;
      return track.keyframes.every(
        (keyframe, index) =>
          keyframe.timeUs <= document.durationUs &&
          (index === 0 || track.keyframes[index - 1]!.timeUs < keyframe.timeUs),
      );
    })
  );
}

function validateSceneDocumentV1(
  value: unknown,
): SceneDocumentValidationResult {
  const schemaVersion = isObject(value) ? value.schemaVersion : undefined;

  if (schemaVersion === undefined) {
    return {
      ok: false,
      error: { code: "SCENE_DOCUMENT_SCHEMA_VERSION_MISSING" },
    };
  }
  if (schemaVersion !== 1) {
    return {
      ok: false,
      error: { code: "SCENE_DOCUMENT_SCHEMA_VERSION_UNSUPPORTED" },
    };
  }
  if (!validate(value) || !hasValidV1Domain(value as SceneDocumentV1)) {
    return { ok: false, error: { code: "SCENE_DOCUMENT_INVALID" } };
  }

  return { ok: true, value: value as SceneDocumentV1 };
}

function importEditableJson(json: string): SceneDocumentImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return importError("SCENE_DOCUMENT_IMPORT_INVALID_JSON");
  }

  if (!isObject(parsed) || parsed.schemaVersion === undefined) {
    return importError("SCENE_DOCUMENT_IMPORT_VALIDATION_FAILED");
  }

  switch (parsed.schemaVersion) {
    case 1: {
      const validation = validateSceneDocument(parsed);
      return validation.ok
        ? { ok: true, value: copySceneDocument(validation.value) }
        : importError("SCENE_DOCUMENT_IMPORT_VALIDATION_FAILED");
    }
    default:
      return importError("SCENE_DOCUMENT_IMPORT_SCHEMA_VERSION_UNSUPPORTED");
  }
}

export const validateSceneDocument = Object.assign(validateSceneDocumentV1, {
  importEditableJson,
});

export const validateInternalSceneDocumentV1 = validate;
