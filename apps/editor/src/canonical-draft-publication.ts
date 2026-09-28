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
  /** Live publication whose draft pointer this invocation intends to replace (or retry). */
  readonly priorPublication?: FirstCanonicalDraftPublication;
}

export interface FirstCanonicalDraftPublication {
  readonly createdAt: number;
  readonly revision: CompleteSceneRevision;
  readonly pointers: RevisionPointersSnapshot;
  readonly workspace: CanonicalImageWorkspace;
  release(): void;
}

// Ownership is process-local: durable pointers alone cannot prove a live workspace.
const livePublications = new WeakSet<FirstCanonicalDraftPublication>();
const samePointers = (left: RevisionPointersSnapshot, right: RevisionPointersSnapshot) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Publish a first draft or replace an explicitly owned, still-live publication. */
export async function publishFirstCanonicalDraft(
  options: FirstCanonicalDraftOptions,
): Promise<FirstCanonicalDraftPublication> {
  const { editableJson, documentId, revisionId: createRevisionId, sequence,
    createdAt: createTimestamp, persistence, prehydration, cache,
    priorPublication } = options;
  let conditionalWrite: ConditionalCompleteRevisionWritePort["writeCompleteRevisionIfPointersMatch"];
  let stablePrehydration: CanonicalPrehydrationDependencies;
  try {
    conditionalWrite = persistence.writeCompleteRevisionIfPointersMatch;
    stablePrehydration = {
      rereadVerifiedPng: prehydration.rereadVerifiedPng,
      decodeVerifiedPng: prehydration.decodeVerifiedPng,
    };
  } catch { throw new Error("EDITOR_CANONICAL_DRAFT_DEPENDENCY_FAILED"); }
  let plan: ReturnType<typeof createCanonicalReferencePlan>;
  try { plan = createCanonicalReferencePlan(editableJson); }
  catch { throw new Error("EDITOR_CANONICAL_DRAFT_PLAN_FAILED"); }
  if (!plan.ok) throw new Error(plan.error.code);

  if (priorPublication && !livePublications.has(priorPublication))
    throw new Error("EDITOR_CANONICAL_DRAFT_PRIOR_MISMATCH");
  let existing: RevisionPointersSnapshot;
  try {
    existing = await persistence.readPointers(documentId);
    createRevisionPointersSnapshot(existing);
  } catch { throw new Error("EDITOR_CANONICAL_DRAFT_POINTER_READ_FAILED"); }
  if (priorPublication && (!livePublications.has(priorPublication) ||
    !samePointers(existing, priorPublication.pointers) ||
    priorPublication.revision.documentId !== documentId))
    throw new Error("EDITOR_CANONICAL_DRAFT_PRIOR_MISMATCH");
  if ((!priorPublication && existing.draft !== null) ||
    (existing.saved !== null && existing.saved.documentId !== documentId) ||
    !Number.isSafeInteger(sequence) || sequence < 0)
    throw new Error("EDITOR_FIRST_DRAFT_INELIGIBLE");

  let revisionId: string;
  try { revisionId = createRevisionId(); }
  catch { throw new Error("EDITOR_CANONICAL_DRAFT_IDENTITY_FAILED"); }
  // The caller's identity callback may synchronously release the prior publication.
  if (priorPublication && !livePublications.has(priorPublication))
    throw new Error("EDITOR_CANONICAL_DRAFT_PRIOR_MISMATCH");
  if (priorPublication && revisionId === priorPublication.revision.revisionId) {
    if (sequence === priorPublication.revision.sequence &&
      plan.value.canonicalEditableJson === priorPublication.workspace.plan.canonicalEditableJson)
      return priorPublication;
    throw new Error("EDITOR_FIRST_DRAFT_INELIGIBLE");
  }
  if ((existing.saved !== null && sequence <= existing.saved.sequence) ||
    (priorPublication && sequence <= priorPublication.revision.sequence))
    throw new Error("EDITOR_FIRST_DRAFT_INELIGIBLE");

  let createdAt: number;
  let revision: CompleteSceneRevision;
  let pointers: RevisionPointersSnapshot;
  try {
    createdAt = createTimestamp();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0)
      throw new Error("EDITOR_FIRST_DRAFT_CREATED_AT_INVALID");
    revision = createCompleteRevision({ documentId, revisionId,
      sequence, document: plan.value.document });
    pointers = createRevisionPointersSnapshot({
      saved: existing.saved, draft: createDraftRevisionPointer(revision),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "EDITOR_FIRST_DRAFT_CREATED_AT_INVALID") throw error;
    throw new Error("EDITOR_CANONICAL_DRAFT_IDENTITY_FAILED");
  }

  const workspace = await prehydrateCanonicalReferences(plan.value, stablePrehydration, cache);
  if (priorPublication && !livePublications.has(priorPublication)) {
    workspace.release();
    throw new Error("EDITOR_CANONICAL_DRAFT_PRIOR_MISMATCH");
  }
  // Ownership is checked at CAS entry. A caller may voluntarily release prior while
  // the write is pending; once it commits, publish the new workspace regardless.
  try { await conditionalWrite.call(persistence, revision, existing, pointers); }
  catch {
    workspace.release();
    throw new Error("EDITOR_CANONICAL_DRAFT_WRITE_FAILED");
  }
  const publication: FirstCanonicalDraftPublication = Object.freeze({ createdAt, revision, pointers, workspace,
    release() {
      if (!livePublications.delete(publication)) return;
      workspace.release();
    },
  });
  livePublications.add(publication);
  priorPublication?.release();
  return publication;
}
