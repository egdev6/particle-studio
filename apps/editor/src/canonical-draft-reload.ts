import type {
  CompleteSceneRevision, DraftRevisionPointer, SavedRevisionPointer,
} from "@particle-studio/persistence";
import { readCanonicalDraftContentParity } from "./canonical-draft-content-parity.js";
import {
  prehydrateCanonicalReferences,
  type CanonicalImageWorkspace,
  type CanonicalPrehydrationDependencies,
} from "./canonical-reference-prehydration.js";
import {
  readDurableDraftIdentity,
  type DurableDraftIdentity,
  type DraftPointerReadPort,
} from "./durable-draft-identity.js";
import { readReferencedRevisionEnvelope, type RevisionReadPort } from "./referenced-revision-envelope.js";
import type { PngImageCache } from "./png-image-cache.js";

export interface CanonicalDraftReloadDependencies {
  /** Read-only durable draft authority: pointer identity plus the referenced revision. */
  readonly persistence: DraftPointerReadPort & RevisionReadPort;
  readonly prehydration: CanonicalPrehydrationDependencies;
  readonly cache: PngImageCache;
}

export interface CanonicalDraftReloadPublication {
  readonly identity: DurableDraftIdentity;
  readonly revision: CompleteSceneRevision;
  readonly workspace: CanonicalImageWorkspace;
  /** Releases only while this publication is current or still owned; stale calls are no-ops. */
  release(): void;
}

export interface CanonicalDraftReloadService {
  /** The live publication, or null once released; replaced only after hydration completed. */
  readonly current: CanonicalDraftReloadPublication | null;
  /**
   * Reloads are serialized per service: every attempt reads fresh state and never
   * writes. Serialized queue contract — never await `reload` of the same service
   * from inside a dependency callback (the queue would deadlock); fire-and-forget
   * calls are safe and run after the in-flight attempt. An explicit release of
   * `current` during any callback is allowed: the in-flight attempt still publishes
   * its fully hydrated workspace on success, and stale releases stay no-ops.
   */
  reload(options: { readonly documentId: string }): Promise<CanonicalDraftReloadPublication>;
}

const failure = () => new Error("EDITOR_CANONICAL_DRAFT_RELOAD_FAILED");

// Ownership is process-local: a publication's release authority lives in this set.
const owned = new WeakSet<CanonicalDraftReloadPublication>();

export interface LiveReloadDraftAuthority {
  /** Full pointer snapshot captured from the same read that fixed the identity. */
  readonly saved: SavedRevisionPointer | null;
  readonly draft: DraftRevisionPointer;
}

const approvalHashPattern = /^sha256:[a-f0-9]{64}$/;

// Republish authority is minted only by the reload service itself, from the one
// pointer read that fixed the identity; nothing can be registered from outside.
const authorities = new WeakMap<CanonicalDraftReloadPublication, LiveReloadDraftAuthority>();

/**
 * Returns the captured pointer authority only for a still-live, genuine reload
 * publication; released, superseded, or foreign objects yield null.
 */
export function readLiveReloadDraftAuthority(
  publication: unknown,
): LiveReloadDraftAuthority | null {
  if (publication === null || typeof publication !== "object") return null;
  const authority = authorities.get(publication as CanonicalDraftReloadPublication);
  return authority !== undefined && owned.has(publication as CanonicalDraftReloadPublication)
    ? authority : null;
}

function ownValue<T = unknown>(source: Record<string, unknown>, key: string): T | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor && "value" in descriptor ? (descriptor.value as T) : undefined;
}

/**
 * Synchronously copies the full pointer snapshot from the one read that fixed the
 * identity, before anything else can observe or mutate it. Malformed provenance
 * yields undefined: ordinary reloads never depended on `saved`, so republish
 * authority is simply absent instead of failing the reload.
 */
function captureLiveDraftPointers(
  result: unknown,
  documentId: string,
): LiveReloadDraftAuthority | undefined {
  try {
    if (result === null || typeof result !== "object") return undefined;
    const snapshot = result as Record<string, unknown>;
    const savedValue = ownValue(snapshot, "saved");
    const draftValue = ownValue(snapshot, "draft");
    let saved: SavedRevisionPointer | null = null;
    if (savedValue !== null) {
      if (typeof savedValue !== "object") return undefined;
      const savedPointer = savedValue as Record<string, unknown>;
      const revisionId = ownValue<string>(savedPointer, "revisionId");
      const sequence = ownValue<number>(savedPointer, "sequence");
      if (ownValue(savedPointer, "kind") !== "saved" || ownValue(savedPointer, "documentId") !== documentId ||
        typeof revisionId !== "string" || revisionId.trim().length === 0 ||
        !Number.isSafeInteger(sequence) || (sequence as number) < 0) return undefined;
      saved = Object.freeze({ kind: "saved", documentId, revisionId, sequence: sequence as number });
    }
    if (draftValue === null || typeof draftValue !== "object") return undefined;
    const draftPointer = draftValue as Record<string, unknown>;
    const draftRevisionId = ownValue<string>(draftPointer, "revisionId");
    const draftSequence = ownValue<number>(draftPointer, "sequence");
    const parentApprovalHash = ownValue<string>(draftPointer, "parentApprovalHash");
    if (ownValue(draftPointer, "kind") !== "draft" || ownValue(draftPointer, "documentId") !== documentId ||
      typeof draftRevisionId !== "string" || draftRevisionId.trim().length === 0 ||
      !Number.isSafeInteger(draftSequence) || (draftSequence as number) < 0 ||
      (parentApprovalHash !== undefined && (typeof parentApprovalHash !== "string" ||
        !approvalHashPattern.test(parentApprovalHash)))) return undefined;
    const draft: DraftRevisionPointer = Object.freeze({
      kind: "draft", documentId, revisionId: draftRevisionId, sequence: draftSequence as number,
      ...(parentApprovalHash === undefined ? {} : { parentApprovalHash }),
    });
    return Object.freeze({ saved, draft });
  } catch {
    return undefined;
  }
}

export function createCanonicalDraftReloadService(
  dependencies: CanonicalDraftReloadDependencies,
): CanonicalDraftReloadService {
  let current: CanonicalDraftReloadPublication | null = null;
  let tails: Promise<void> = Promise.resolve();

  const releasePublication = (publication: CanonicalDraftReloadPublication, workspace: CanonicalImageWorkspace): void => {
    if (!owned.delete(publication)) return;
    if (current === publication) current = null;
    try { workspace.release(); } catch { /* Never expose dependency details. */ }
  };

  return Object.freeze({
    get current() { return current; },
    reload(options: { readonly documentId: string }) {
      // Snapshot the caller's scalar and every port/callback synchronously, before
      // this attempt queues or awaits anything: reassigning ports or options during
      // a pending read cannot mix identity and revision sources.
      let snapshot: { documentId: unknown; persistence: CanonicalDraftReloadDependencies["persistence"];
        prehydration: CanonicalPrehydrationDependencies; cache: PngImageCache };
      try {
        snapshot = {
          documentId: (options as { readonly documentId?: unknown }).documentId,
          persistence: dependencies.persistence,
          prehydration: {
            rereadVerifiedPng: dependencies.prehydration.rereadVerifiedPng,
            decodeVerifiedPng: dependencies.prehydration.decodeVerifiedPng,
          },
          cache: dependencies.cache,
        };
      } catch { return Promise.reject(failure()); }
      const run = async (): Promise<CanonicalDraftReloadPublication> => {
        // The wrapped port lets the identity read's single pointer read also capture
        // the full snapshot; the real port and receiver stay the only data sources.
        let authority: LiveReloadDraftAuthority | undefined;
        const wrapped = {
          readPointers: async (documentId: string): Promise<unknown> => {
            const result = await snapshot.persistence.readPointers.call(snapshot.persistence, documentId);
            authority = captureLiveDraftPointers(result, documentId);
            return result;
          },
          readRevision: (documentId: string, revisionId: string): Promise<unknown> =>
            snapshot.persistence.readRevision.call(snapshot.persistence, documentId, revisionId),
        };
        try {
          const identity = await readDurableDraftIdentity(
            snapshot.documentId as string, wrapped,
          );
          const envelope = await readReferencedRevisionEnvelope(identity, snapshot.persistence);
          const { plan, revision } = readCanonicalDraftContentParity(envelope);
          // Hydration must complete, with every lease adopted, before any swap.
          const hydrated = await prehydrateCanonicalReferences(
            plan, snapshot.prehydration, snapshot.cache,
          );
          let exposed!: CanonicalImageWorkspace;
          const publication: CanonicalDraftReloadPublication = Object.freeze({
            identity, revision,
            get workspace() { return exposed; },
            release() { releasePublication(publication, hydrated); },
          });
          // The public workspace is a safe facade: its release routes through the
          // same publication authority, so it can never dangle `current` or
          // double-dispose, in either release order.
          exposed = Object.freeze({
            plan: hydrated.plan, images: hydrated.images,
            release() { releasePublication(publication, hydrated); },
          });
          owned.add(publication);
          if (authority !== undefined) authorities.set(publication, authority);
          // Atomic in-memory swap: no await between reading `current` and publishing,
          // so no callback can interleave. The previous publication is released only
          // after the swap, and a consumer's stale or repeated release stays a no-op.
          const previous = current;
          current = publication;
          previous?.release();
          return publication;
        } catch {
          // The failed attempt releases only its own resources; prehydration rolls
          // back its staged leases internally, and `current` is never touched.
          throw failure();
        }
      };
      // Serialize attempts through one tail: each reload reads fresh state only
      // after its predecessor settled, whether that predecessor succeeded or not.
      const result = tails.then(run, run);
      tails = result.then(() => undefined, () => undefined);
      return result;
    },
  });
}
