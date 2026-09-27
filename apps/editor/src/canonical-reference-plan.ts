import {
  canonicalizeSceneDocument,
  type SceneDocumentV1,
  validateSceneDocument,
} from "@particle-studio/scene-document";

const safeReflectApply = Reflect.apply;
const safeTextDecoderDecode = TextDecoder.prototype.decode;
const safeUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface PlannedImageReference {
  readonly elementId: string;
  readonly sha256: string;
  readonly mimeType: "image/png";
  readonly byteLength: number;
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
}

export interface CanonicalReferencePlan {
  readonly document: SceneDocumentV1;
  readonly canonicalEditableJson: string;
  readonly references: readonly PlannedImageReference[];
}

export type CanonicalReferencePlanResult =
  | { readonly ok: true; readonly value: CanonicalReferencePlan }
  | { readonly ok: false; readonly error: { readonly code: string } };

export interface CanonicalReferencePlanDependencies {
  readonly importEditableJson: typeof validateSceneDocument.importEditableJson;
  readonly exportEditableJson: typeof canonicalizeSceneDocument.exportEditableJson;
}

const canonicalReferencePlanDependencies: CanonicalReferencePlanDependencies = {
  importEditableJson: validateSceneDocument.importEditableJson,
  exportEditableJson: canonicalizeSceneDocument.exportEditableJson,
};

function freezeRecursively<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) freezeRecursively(child);
  return Object.freeze(value);
}

function copySceneDocumentForPlan(document: SceneDocumentV1): SceneDocumentV1 {
  return structuredClone(document);
}

function plannerDependencyFailure(): CanonicalReferencePlanResult {
  return freezeRecursively({
    ok: false as const,
    error: { code: "SCENE_DOCUMENT_REFERENCE_PLAN_DEPENDENCY_FAILED" },
  });
}

function matchesPlannedImageMetadata(
  left: PlannedImageReference,
  right: PlannedImageReference,
): boolean {
  return (
    Object.is(left.sha256, right.sha256) &&
    Object.is(left.mimeType, right.mimeType) &&
    Object.is(left.byteLength, right.byteLength) &&
    Object.is(left.intrinsicWidth, right.intrinsicWidth) &&
    Object.is(left.intrinsicHeight, right.intrinsicHeight)
  );
}

/**
 * Validates editable JSON before deriving the finite, schema-defined image plan.
 * It deliberately examines only `image.asset`, the sole asset reference declared by
 * SceneDocument v1, and performs no asset, cache, or decode work.
 */
export function createCanonicalReferencePlan(
  editableJson: string,
  dependencies: CanonicalReferencePlanDependencies = canonicalReferencePlanDependencies,
): CanonicalReferencePlanResult {
  let imported: unknown;
  try {
    const importEditableJson = dependencies.importEditableJson;
    if (typeof importEditableJson !== "function")
      return plannerDependencyFailure();
    imported = importEditableJson(editableJson);
  } catch {
    return plannerDependencyFailure();
  }

  try {
    if (imported === null || typeof imported !== "object") {
      return plannerDependencyFailure();
    }
    const result = imported as {
      readonly ok?: unknown;
      readonly value?: unknown;
      readonly error?: { readonly code?: unknown };
    };
    if (result.ok === false) {
      if (typeof result.error?.code === "string") {
        return result as CanonicalReferencePlanResult;
      }
      return plannerDependencyFailure();
    }
    if (
      result.ok !== true ||
      result.value === null ||
      typeof result.value !== "object"
    ) {
      return plannerDependencyFailure();
    }

    const sourceDocument = result.value as SceneDocumentV1;
    const elements = sourceDocument.elements;
    if (!Array.isArray(elements)) return plannerDependencyFailure();

    const referencesBySha256 = new Map<string, PlannedImageReference>();
    for (const element of elements) {
      if (
        element === null ||
        typeof element !== "object" ||
        typeof element.type !== "string"
      ) {
        return plannerDependencyFailure();
      }
      if (element.type !== "image") continue;
      if (
        typeof element.id !== "string" ||
        element.asset === null ||
        typeof element.asset !== "object" ||
        typeof element.asset.sha256 !== "string" ||
        element.asset.mimeType !== "image/png" ||
        !Number.isSafeInteger(element.asset.byteLength) ||
        !Number.isFinite(element.asset.intrinsicWidth) ||
        !Number.isFinite(element.asset.intrinsicHeight)
      ) {
        return plannerDependencyFailure();
      }

      const candidate: PlannedImageReference = {
        elementId: element.id,
        sha256: element.asset.sha256,
        mimeType: element.asset.mimeType,
        byteLength: element.asset.byteLength,
        intrinsicWidth: element.asset.intrinsicWidth,
        intrinsicHeight: element.asset.intrinsicHeight,
      };
      const established = referencesBySha256.get(candidate.sha256);
      if (established === undefined) {
        referencesBySha256.set(candidate.sha256, freezeRecursively(candidate));
      } else if (!matchesPlannedImageMetadata(established, candidate)) {
        return {
          ok: false,
          error: { code: "SCENE_DOCUMENT_REFERENCE_METADATA_CONFLICT" },
        };
      }
    }

    const document = freezeRecursively(
      copySceneDocumentForPlan(sourceDocument),
    );
    const exportEditableJson = dependencies.exportEditableJson;
    if (typeof exportEditableJson !== "function")
      return plannerDependencyFailure();
    const canonicalBytes = exportEditableJson(document);
    if (
      Object.prototype.toString.call(canonicalBytes) !==
        "[object Uint8Array]" ||
      Object.getPrototypeOf(canonicalBytes)?.constructor?.name !== "Uint8Array"
    ) {
      return plannerDependencyFailure();
    }
    Uint8Array.prototype.slice.call(canonicalBytes, 0, 0);
    const canonicalEditableJson = safeReflectApply(
      safeTextDecoderDecode,
      safeUtf8Decoder,
      [canonicalBytes],
    ) as string;
    const references = freezeRecursively([...referencesBySha256.values()]);

    return {
      ok: true,
      value: freezeRecursively({ document, canonicalEditableJson, references }),
    };
  } catch {
    return plannerDependencyFailure();
  }
}
