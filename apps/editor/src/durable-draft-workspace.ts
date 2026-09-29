import type { CompleteSceneRevision } from "@particle-studio/persistence";
import {
  createCanonicalDraftReloadService, type CanonicalDraftReloadPublication,
} from "./canonical-draft-reload.js";
import type {
  CanonicalPrehydrationCachePorts, CanonicalPrehydrationDependencies,
} from "./canonical-reference-prehydration.js";
import type { CanonicalReferencePlan } from "./canonical-reference-plan.js";
import type { DraftPointerReadPort } from "./durable-draft-identity.js";
import type { CachedPngImage, PngImageCache } from "./png-image-cache.js";
import type { RevisionReadPort } from "./referenced-revision-envelope.js";

const failure = () => new Error("EDITOR_DURABLE_DRAFT_WORKSPACE_FAILED");

/** Read-only ports and cache/prehydration instances the workspace binds attempts to. */
export interface DurableDraftWorkspaceDependencies {
  readonly persistence: DraftPointerReadPort & RevisionReadPort;
  readonly prehydration: CanonicalPrehydrationDependencies;
  readonly cache: PngImageCache;
}

/** Frozen view of a publication's hydrated images; its release is publication authority. */
export interface DurableDraftWorkspaceView {
  readonly plan: CanonicalReferencePlan;
  readonly images: readonly CachedPngImage[];
  release(): void;
}

/**
 * Safe facade over a genuine private publication. Both release paths route through
 * one authority: stale, repeated, or superseded releases are no-ops, and releasing
 * a current publication clears the workspace `current` getter immediately.
 */
export interface DurableDraftPublication {
  readonly revision: CompleteSceneRevision;
  readonly workspace: DurableDraftWorkspaceView;
  release(): void;
}

export interface DurableDraftWorkspace {
  /** The live publication, or null once released or before the first success. */
  readonly current: DurableDraftPublication | null;
  /**
   * Reloads share one serial queue: every attempt reads fresh state only after its
   * predecessor settled. Releasing `current` while attempts are pending is allowed
   * but is never cancellation — queued attempts still run and publish on success.
   * Never await a queued call of the same workspace from inside a dependency
   * callback (the queue would deadlock).
   */
  reload(options: { readonly documentId: string }): Promise<DurableDraftPublication>;
}

type UnderlyingPublication = CanonicalDraftReloadPublication;

/**
 * Read-only durable reload coordinator composing the existing reload service,
 * prehydration, and cache. The genuine underlying publication stays private:
 * callers only ever see frozen facades, so no raw workspace release authority is
 * exposed. Each attempt builds its reload service from a snapshot taken before the
 * attempt queues, so reassigning dependency ports, methods, or callbacks after
 * `reload` returns cannot change that attempt. The coordinator owns cross-attempt
 * releases: a successful swap releases the superseded publication, a failed
 * attempt releases only its own resources and leaves `current` untouched.
 */
export function createDurableDraftWorkspace(
  dependencies: DurableDraftWorkspaceDependencies,
): DurableDraftWorkspace {
  // Facade identity is keyed by the genuine private prior: an exact retry that
  // returns the same underlying publication returns the same facade.
  const facades = new WeakMap<UnderlyingPublication, DurableDraftPublication>();
  let current: {
    readonly facade: DurableDraftPublication;
    readonly underlying: UnderlyingPublication;
  } | null = null;

  const facadeFor = (underlying: UnderlyingPublication): DurableDraftPublication => {
    const existing = facades.get(underlying);
    if (existing !== undefined) return existing;
    let released = false;
    // One release authority for both public paths; the underlying release routes
    // through its own module authority, keeping every liveness WeakSet honest.
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      if (current?.facade === facade) current = null;
      try { underlying.release(); } catch { /* Never expose dependency details. */ }
    };
    const workspace: DurableDraftWorkspaceView = Object.freeze({
      plan: underlying.workspace.plan,
      images: underlying.workspace.images,
      release: releaseOnce,
    });
    const facade: DurableDraftPublication = Object.freeze({
      revision: underlying.revision,
      workspace,
      release: releaseOnce,
    });
    facades.set(underlying, facade);
    return facade;
  };

  let tails: Promise<void> = Promise.resolve();
  const enqueue = <T>(attempt: () => Promise<T>): Promise<T> => {
    const result = tails.then(attempt, attempt);
    tails = result.then(() => undefined, () => undefined);
    return result;
  };

  return Object.freeze({
    get current() { return current?.facade ?? null; },
    reload(options: { readonly documentId: string }) {
      // Snapshot the scalar input and every dependency port/callback synchronously,
      // BEFORE this attempt queues: reassigning inputs or dependencies while an
      // attempt is pending cannot change identity, revision, or hydration sources.
      let snapshot: {
        documentId: string;
        persistence: DurableDraftWorkspaceDependencies["persistence"];
        prehydration: CanonicalPrehydrationDependencies;
        cache: PngImageCache;
        cachePorts: CanonicalPrehydrationCachePorts;
      };
      try {
        const persistence = dependencies.persistence;
        const cache = dependencies.cache;
        // Bind the mutable method values to their original receivers before
        // queueing: a pending attempt can no longer observe same-object method
        // reassignment, and each invocation captures whatever methods are
        // current at its own call. Prehydration callbacks stay receiver-free
        // per the documented primitive contract.
        snapshot = {
          documentId: (options as { readonly documentId?: unknown }).documentId as string,
          persistence: {
            readPointers: persistence.readPointers.bind(persistence),
            readRevision: persistence.readRevision.bind(persistence),
          },
          prehydration: {
            rereadVerifiedPng: dependencies.prehydration.rereadVerifiedPng,
            decodeVerifiedPng: dependencies.prehydration.decodeVerifiedPng,
          },
          cache,
          cachePorts: {
            adoptStaged: cache.adoptStaged.bind(cache),
            resolveImage: cache.resolveImage.bind(cache),
            disposeCandidate: cache.disposeCandidate.bind(cache),
          },
        };
      } catch { return Promise.reject(failure()); }
      return enqueue(async () => {
        const previous = current;
        try {
          // Per-attempt service built from the prequeued snapshot: the shared
          // reload primitive is used as-is and never re-reads live dependencies
          // from inside the queue.
          const service = createCanonicalDraftReloadService(snapshot);
          const underlying = await service.reload({ documentId: snapshot.documentId });
          const facade = facadeFor(underlying);
          // Atomic in-memory swap, then release the superseded publication: each
          // per-attempt service has no prior of its own, so the coordinator owns
          // the cross-attempt release. Stale facade releases stay no-ops.
          current = { facade, underlying };
          previous?.underlying.release();
          return facade;
        } catch (error) {
          // A failed attempt releases only its own resources; the previous live
          // publication and `current` are untouched.
          throw error;
        }
      });
    },
  });
}
