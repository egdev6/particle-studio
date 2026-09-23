import {
  APPROVAL_ENVELOPE_IDENTIFIER,
  APPROVAL_HASH_IDENTIFIER,
  APPROVAL_POLICY_IDENTIFIER,
  CANONICALIZATION_IDENTIFIER,
  canonicalizeSceneDocument as canonicalizeSceneDocumentV1,
  createApprovalEnvelope,
  readCanonicalApprovalEvidence,
  validateCanonicalApprovalEnvelope,
  type ApprovalEnvelope,
  type CanonicalApprovalEnvelope,
  type ValidatedCanonicalApprovalEvidence,
  type CanonicalSceneDocument,
  type VerifiedAssetManifestEntry,
} from "./canonicalization/canonicalize-scene-document.js";

const canonicalizeSceneDocument = Object.assign(canonicalizeSceneDocumentV1, {
  exportEditableJson(value: unknown): Uint8Array {
    return canonicalizeSceneDocumentV1(value).bytes.slice();
  },
});

export {
  validateSceneDocument,
  type SceneDocumentValidationErrorCode,
  type SceneDocumentValidationResult,
} from "./validation/validate-scene-document.js";
export type { SceneDocumentV1 } from "./schemas/scene-document-v1.js";
export {
  APPROVAL_ENVELOPE_IDENTIFIER,
  APPROVAL_HASH_IDENTIFIER,
  APPROVAL_POLICY_IDENTIFIER,
  CANONICALIZATION_IDENTIFIER,
  canonicalizeSceneDocument,
  createApprovalEnvelope,
  readCanonicalApprovalEvidence,
  validateCanonicalApprovalEnvelope,
  type ApprovalEnvelope,
  type CanonicalApprovalEnvelope,
  type ValidatedCanonicalApprovalEvidence,
  type CanonicalSceneDocument,
  type VerifiedAssetManifestEntry,
};
export {
  FIRST_SLICE_CANONICAL_HEX,
  FIRST_SLICE_CANONICAL_SHA256,
  FIRST_SLICE_DOCUMENT,
} from "./canonicalization/first-slice-fixture.js";
