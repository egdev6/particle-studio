import {
  createCompleteRevision, createDraftRevisionPointer, createRevisionPointersSnapshot,
  type CompleteSceneRevision, type ConditionalCompleteRevisionWritePort, type RevisionPointersSnapshot,
} from "@particle-studio/persistence";
import { createCanonicalReferencePlan } from "./canonical-reference-plan.js";
import {
  prehydrateCanonicalReferences,
  type CanonicalPrehydrationDependencies, type CanonicalImageWorkspace,
} from "./canonical-reference-prehydration.js";
import type { PngImageCache } from "./png-image-cache.js";

export interface FirstCanonicalDraftOptions {
  readonly editableJson: string;
  readonly documentId: string;
  readonly revisionId: () => string;
  readonly sequence: number;
  readonly createdAt: () => number;
  readonly persistence: ConditionalCompleteRevisionWritePort;
  readonly prehydration: CanonicalPrehydrationDependencies;
  readonly cache: PngImageCache;
}

export interface FirstCanonicalDraftPublication {
  readonly createdAt: number;
  readonly revision: CompleteSceneRevision;
  readonly pointers: RevisionPointersSnapshot;
  readonly workspace: CanonicalImageWorkspace;
  release(): void;
}

/** Only the first draft may be published here; subsequent edits need a separate path. */
export async function publishFirstCanonicalDraft(
  options: FirstCanonicalDraftOptions,
): Promise<FirstCanonicalDraftPublication> {
  const { editableJson, documentId, revisionId: createRevisionId, sequence,
    createdAt: createTimestamp, persistence, prehydration, cache } = options;
  const conditionalWrite = persistence.writeCompleteRevisionIfPointersMatch;
  const stablePrehydration: CanonicalPrehydrationDependencies = {
    rereadVerifiedPng: prehydration.rereadVerifiedPng,
    decodeVerifiedPng: prehydration.decodeVerifiedPng,
  };
  const plan = createCanonicalReferencePlan(editableJson);
  if (!plan.ok) throw new Error(plan.error.code);

  const existing = await persistence.readPointers(documentId);
  if (existing.draft !== null ||
    (existing.saved !== null &&
      (existing.saved.documentId !== documentId ||
        sequence <= existing.saved.sequence)) ||
    !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("EDITOR_FIRST_DRAFT_INELIGIBLE");
  }

  const revisionId = createRevisionId();
  const createdAt = createTimestamp();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error("EDITOR_FIRST_DRAFT_CREATED_AT_INVALID");
  }
  const revision = createCompleteRevision({
    documentId, revisionId,
    sequence, document: plan.value.document,
  });
  const pointers = createRevisionPointersSnapshot({
    saved: existing.saved, draft: createDraftRevisionPointer(revision),
  });

  const workspace = await prehydrateCanonicalReferences(plan.value, stablePrehydration, cache);
  try {
    await conditionalWrite.call(persistence, revision, existing, pointers);
  } catch (error) {
    workspace.release();
    throw error;
  }
  return Object.freeze({ createdAt, revision, pointers, workspace,
    release() { workspace.release(); },
  });
}
