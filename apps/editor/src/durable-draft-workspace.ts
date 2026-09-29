import type {
  CompleteSceneRevision, ConditionalCompleteRevisionWritePort,
} from "@particle-studio/persistence";
import {
  publishFirstCanonicalDraft, type FirstCanonicalDraftPublication,
  type LivePriorDraftOptions,
} from "./canonical-draft-publication.js";
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

/** Read-only dependencies that additionally carry the conditional write port, enabling `publish`. */
export interface DurableDraftWriteWorkspaceDependencies extends DurableDraftWorkspaceDependencies {
  readonly persistence: ConditionalCompleteRevisionWritePort & DraftPointerReadPort & RevisionReadPort;
}

/** Publish inputs; every field is captured synchronously before the attempt queues. */
export interface DurableDraftPublishInput {
  readonly documentId: string;
  readonly editableJson: string;
  readonly revisionId: () => string;
  readonly sequence: number;
  readonly createdAt: () => number;
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
   * Reloads and publishes share one serial queue: every attempt reads fresh state
   * only after its predecessor settled. Releasing `current` while attempts are
   * pending is allowed but is never cancellation — queued attempts still run and
   * publish on success. Never await a queued call of the same workspace from
   * inside a dependency callback (the queue would deadlock).
   */
  reload(options: { readonly documentId: string }): Promise<DurableDraftPublication>;
  /**
   * Publishes on the same serial queue as `reload`, with every scalar, callback,
   * and bound dependency method captured before the attempt queues. The trusted
   * prior is picked at execution from this workspace's private current
   * publication: a foreign or released publication is never adopted, and an
   * exact retry returns the same facade without any decode or write. Replacing
   * while a current publication exists targets only that prior's document — a
   * cross-document publish fails closed and preserves the previous live
   * workspace (release `current` first to publish elsewhere). A release of
   * `current` during a pending attempt is not cancellation: an attempt whose
   * conditional write has already committed still publishes and becomes current.
   */
  publish(options: DurableDraftPublishInput): Promise<DurableDraftPublication>;
}

type UnderlyingPublication = FirstCanonicalDraftPublication | CanonicalDraftReloadPublication;

/**
 * Composes the existing reload service, publication, prehydration, and cache into
 * one durable draft workspace. The genuine prior publications stay private:
 * callers only ever see frozen facades, so no raw workspace release authority is
 * exposed. Each attempt builds its reload service from a snapshot taken before the
 * attempt queues, so reassigning dependency ports, methods, or callbacks after
 * `reload` or `publish` returns cannot change that attempt. The coordinator owns
 * cross-attempt releases: a successful swap or replacement releases the superseded
 * publication, a failed attempt releases only its own resources and leaves
 * `current` untouched.
 */
export function createDurableDraftWorkspace(
  dependencies: DurableDraftWriteWorkspaceDependencies,
): DurableDraftWorkspace;
export function createDurableDraftWorkspace(
  dependencies: DurableDraftWorkspaceDependencies,
): DurableDraftWorkspace;
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
    publish(options: DurableDraftPublishInput) {
      // Snapshot every scalar, callback, and bound dependency method synchronously,
      // BEFORE this attempt queues: reassigning inputs or dependencies while an
      // attempt is pending cannot change identity, content, or write targets.
      let snapshot: {
        input: DurableDraftPublishInput;
        persistence: {
          readPointers: DraftPointerReadPort["readPointers"];
          readRevision: RevisionReadPort["readRevision"];
          writeCompleteRevisionIfPointersMatch:
            ConditionalCompleteRevisionWritePort["writeCompleteRevisionIfPointersMatch"];
        };
        prehydration: CanonicalPrehydrationDependencies;
        cache: PngImageCache;
        cachePorts: CanonicalPrehydrationCachePorts;
      };
      try {
        const persistence = dependencies.persistence;
        const cache = dependencies.cache;
        const write = (persistence as Partial<DurableDraftWriteWorkspaceDependencies["persistence"]>)
          .writeCompleteRevisionIfPointersMatch;
        if (typeof write !== "function") throw failure();
        snapshot = {
          // Explicit declared-field reads (a spread would drop prototype getters
          // and non-enumerable own fields); the copy pins later caller mutation.
          input: {
            documentId: options.documentId,
            editableJson: options.editableJson,
            revisionId: options.revisionId,
            sequence: options.sequence,
            createdAt: options.createdAt,
          },
          persistence: {
            readPointers: persistence.readPointers.bind(persistence),
            readRevision: persistence.readRevision.bind(persistence),
            writeCompleteRevisionIfPointersMatch: write.bind(
              persistence as DurableDraftWriteWorkspaceDependencies["persistence"],
            ),
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
        // The trusted prior is picked at execution from this workspace's private
        // current publication; foreign publications can never be adopted.
        const prior = current;
        const underlying = await publishFirstCanonicalDraft({
          ...snapshot.input,
          // The genuine bound methods return validated pointer snapshots and
          // revisions at runtime; the read-side ports only promise `unknown`.
          persistence: snapshot.persistence as ConditionalCompleteRevisionWritePort,
          cache: snapshot.cache,
          cachePorts: snapshot.cachePorts,
          prehydration: snapshot.prehydration,
          priorPublication: prior?.underlying,
        } satisfies LivePriorDraftOptions);
        // An exact retry returns the same genuine publication, so the same facade
        // stays current without any decode or write.
        if (prior !== null && underlying === prior.underlying) return prior.facade;
        const facade = facadeFor(underlying);
        current = { facade, underlying };
        return facade;
        // A failed attempt releases only its own staged resources; the previous
        // live publication and `current` are untouched.
      });
    },
  });
}
