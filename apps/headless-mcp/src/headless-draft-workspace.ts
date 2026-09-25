import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createRootConfinement,
  resolveExistingPath,
  RootConfinementError,
  type RootConfinement,
} from "@particle-studio/persistence-fs";
import {
  createFileSystemPersistenceAdapter,
  type PersistenceAdapterPort,
  FileSystemPersistenceError,
} from "@particle-studio/persistence-fs/revision-persistence";
import {
  createFileSystemAssetPersistenceAdapter,
  FileSystemAssetPersistenceError,
} from "@particle-studio/persistence-fs/asset-persistence";
import {
  createCommandSession,
  type CommandSession,
  type ElementIdSource,
  type ElementIdSourceResult,
} from "@particle-studio/commands";
import {
  createCompleteRevision,
  createDraftRevisionPointer,
  createRevisionPointersSnapshot,
  type CompleteSceneRevision,
  type ContentAddressedAsset,
  type DraftRevisionPointer,
  type SavedRevisionPointer,
} from "@particle-studio/persistence";
import {
  validateSceneDocument,
  type SceneDocumentValidationResult,
  type SceneDocumentV1,
} from "@particle-studio/scene-document";

/**
 * Local headless port surface. These shapes mirror the browser-agent
 * workspace port without importing the frozen WebMCP adapter package: the
 * headless workspace must not depend on browser transport code.
 */
export type HeadlessDraftSummary = {
  readonly documentId: string;
  readonly revision: number;
  readonly schemaVersion: number;
  readonly durationUs: number;
  readonly playbackRange: { readonly startUs: number; readonly endUs: number };
  readonly loop: boolean;
  readonly elementCount: number;
  readonly trackCount: number;
};

export type HeadlessDraftSummaryResult =
  | { readonly ok: true; readonly summary: HeadlessDraftSummary }
  | {
      readonly ok: false;
      readonly error: { readonly code: "DURABLE_COMMAND_UNAVAILABLE" };
    };

export type HeadlessCommandErrorCode =
  | "MALFORMED_COMMAND"
  | "DOCUMENT_MISMATCH"
  | "REVISION_CONFLICT"
  | "TARGET_NOT_FOUND"
  | "INVALID_CANDIDATE"
  | "NOTHING_TO_UNDO"
  | "NOTHING_TO_REDO"
  | "ID_SOURCE_UNAVAILABLE"
  | "ID_SOURCE_INVALID"
  | "ID_COLLISION"
  | "LAST_KEYFRAME"
  | "DURABLE_PUBLISH_FAILED";

export type HeadlessMutationResult =
  | {
      readonly ok: true;
      readonly revision: number;
      readonly document: SceneDocumentV1;
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: HeadlessCommandErrorCode };
    };

export type HeadlessWorkspaceErrorCode =
  | "HEADLESS_WORKSPACE_CONFINEMENT_REJECTED"
  | "HEADLESS_WORKSPACE_PERSISTED_STATE_INVALID"
  | "HEADLESS_WORKSPACE_ASSET_UNAVAILABLE"
  | "HEADLESS_WORKSPACE_SEED_UNAVAILABLE"
  | "HEADLESS_WORKSPACE_SEED_INVALID";

export class HeadlessWorkspaceError extends Error {
  readonly name = "HeadlessWorkspaceError";

  constructor(readonly code: HeadlessWorkspaceErrorCode) {
    super(code);
  }
}

export type HeadlessWorkspaceTestConfiguration = {
  readonly failPublication?: () => boolean;
};

let testConfiguration: HeadlessWorkspaceTestConfiguration | undefined;

/** This is intentionally reachable only through a relative test-only module. */
export function setHeadlessWorkspaceTestConfiguration(
  configuration: HeadlessWorkspaceTestConfiguration | undefined,
): void {
  testConfiguration = configuration;
}

export type HeadlessDraftWorkspaceOptions = {
  readonly documentId: string;
  readonly workspaceRoot: string;
  readonly documentsRoot: string;
  readonly outputsRoot: string;
  /**
   * Documents-role relative seed path. Required only when no draft pointer is
   * persisted yet; a resumed workspace never reads the seed.
   */
  readonly seedPath?: string;
  /** Injectable deterministic revision-id source; defaults to randomUUID. */
  readonly revisionIdSource?: () => string;
  /**
   * Injectable deterministic command element-id source for tests and
   * embedders. It is handed to every rebuilt CommandSession (fork lineage
   * included), so ID-minting commands match direct domain-session
   * capability; production defaults to a safe random UUID source.
   */
  readonly elementIdSource?: ElementIdSource;
};

export type HeadlessDraftWorkspace = {
  readonly documentId: string;
  getDraftSummary(): Promise<HeadlessDraftSummaryResult>;
  validateDraft(document: unknown): SceneDocumentValidationResult;
  dispatch(command: unknown): Promise<HeadlessMutationResult>;
  undo(): Promise<HeadlessMutationResult>;
  redo(): Promise<HeadlessMutationResult>;
};

type DispatchEnvelope = {
  readonly commandSchemaVersion: number;
  readonly commandId: string;
  readonly documentId: string;
  readonly expectedRevision: number;
  readonly payload: Record<string, unknown>;
};

type ActiveState = {
  readonly revision: number;
  readonly document: SceneDocumentV1;
};

type WorkspaceRuntime = {
  readonly confinement: RootConfinement;
  readonly adapter: PersistenceAdapterPort;
  readonly active: ActiveState;
  readonly nextSequence: number;
  readonly savedPointer: SavedRevisionPointer | null;
};

type DomainOutcome = ReturnType<CommandSession["dispatch"]>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const clone = <T>(value: T): T => structuredClone(value);

/**
 * Production element-id default. The domain's stable-id pattern requires a
 * leading letter, so the random UUID is prefixed instead of used raw.
 */
const defaultElementIdSource = (): ElementIdSourceResult => ({
  kind: "id",
  id: `el-${randomUUID()}`,
});

const envelopeKeys = [
  "commandSchemaVersion",
  "commandId",
  "documentId",
  "expectedRevision",
  "payload",
] as const;

function parseEnvelope(input: unknown): DispatchEnvelope | null {
  if (!isRecord(input)) return null;
  if (
    !envelopeKeys.every((key) => key in input) ||
    Object.keys(input).length !== envelopeKeys.length
  ) {
    return null;
  }
  const commandSchemaVersion = input["commandSchemaVersion"];
  const commandId = input["commandId"];
  const documentId = input["documentId"];
  const expectedRevision = input["expectedRevision"];
  const payload = input["payload"];
  if (
    commandSchemaVersion !== 1 ||
    typeof commandId !== "string" ||
    commandId.length === 0 ||
    typeof documentId !== "string" ||
    documentId.length === 0 ||
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    !isRecord(payload)
  ) {
    return null;
  }
  return {
    commandSchemaVersion,
    commandId,
    documentId,
    expectedRevision,
    payload,
  };
}

export async function createHeadlessDraftWorkspace(
  options: HeadlessDraftWorkspaceOptions,
): Promise<HeadlessDraftWorkspace> {
  const runtime = await buildRuntime(options);
  return assembleWorkspace(runtime, options);
}

async function buildRuntime(
  options: HeadlessDraftWorkspaceOptions,
): Promise<WorkspaceRuntime> {
  let confinement: RootConfinement;
  try {
    confinement = await createRootConfinement({
      workspace: options.workspaceRoot,
      documents: options.documentsRoot,
      outputs: options.outputsRoot,
    });
  } catch (error: unknown) {
    if (error instanceof RootConfinementError) {
      throw new HeadlessWorkspaceError("HEADLESS_WORKSPACE_CONFINEMENT_REJECTED");
    }
    throw error;
  }

  const adapter = createFileSystemPersistenceAdapter({ authority: confinement });

  let draftPointer: DraftRevisionPointer | null;
  let savedPointer: SavedRevisionPointer | null;
  try {
    const snapshot = await adapter.readPointers(options.documentId);
    draftPointer = snapshot.draft;
    savedPointer = snapshot.saved;
  } catch (error: unknown) {
    if (error instanceof FileSystemPersistenceError) {
      throw new HeadlessWorkspaceError(
        "HEADLESS_WORKSPACE_PERSISTED_STATE_INVALID",
      );
    }
    throw error;
  }

  if (draftPointer !== null) {
    // Resume: load the exact persisted draft revision. Never fall back to
    // seed content; any read or identity failure is a fail-closed startup
    // error.
    let revision: CompleteSceneRevision | null;
    try {
      revision = await adapter.readRevision(
        options.documentId,
        draftPointer.revisionId,
      );
    } catch (error: unknown) {
      if (error instanceof FileSystemPersistenceError) {
        throw new HeadlessWorkspaceError(
          "HEADLESS_WORKSPACE_PERSISTED_STATE_INVALID",
        );
      }
      throw error;
    }
    if (
      revision === null ||
      revision.documentId !== options.documentId ||
      revision.sequence !== draftPointer.sequence
    ) {
      throw new HeadlessWorkspaceError(
        "HEADLESS_WORKSPACE_PERSISTED_STATE_INVALID",
      );
    }
    await verifyReferencedAssets(confinement, revision.document);
    return {
      confinement,
      adapter,
      active: { revision: draftPointer.sequence, document: revision.document },
      nextSequence: draftPointer.sequence + 1,
      savedPointer,
    };
  }

  // Seed: resolve and read the explicit seed document through the documents
  // role. This is the only direct filesystem read, on an already-resolved
  // confined path.
  if (options.seedPath === undefined) {
    throw new HeadlessWorkspaceError("HEADLESS_WORKSPACE_SEED_UNAVAILABLE");
  }
  let seedPath: string;
  try {
    const resolved = await resolveExistingPath(confinement, {
      role: "documents",
      path: options.seedPath,
    });
    seedPath = resolved.path;
  } catch {
    throw new HeadlessWorkspaceError("HEADLESS_WORKSPACE_SEED_UNAVAILABLE");
  }
  let seedRaw: string;
  try {
    seedRaw = await readFile(seedPath, "utf8");
  } catch {
    throw new HeadlessWorkspaceError("HEADLESS_WORKSPACE_SEED_UNAVAILABLE");
  }
  let seedValue: unknown;
  try {
    seedValue = JSON.parse(seedRaw);
  } catch {
    throw new HeadlessWorkspaceError("HEADLESS_WORKSPACE_SEED_INVALID");
  }
  const seedDocument = validateSceneDocument(seedValue);
  if (!seedDocument.ok) {
    throw new HeadlessWorkspaceError("HEADLESS_WORKSPACE_SEED_INVALID");
  }
  await verifyReferencedAssets(confinement, seedDocument.value);
  return {
    confinement,
    adapter,
    // The seed state is revision 0; the first published revision is 1. The
    // persisted sequence resumes from the draft pointer for restored
    // workspaces.
    active: { revision: 0, document: seedDocument.value },
    nextSequence: 1,
    // A saved-only snapshot (saved != null, draft == null) must survive the
    // seed branch: the first published mutation carries this pointer into
    // its snapshot, so returning null here would erase the saved state.
    savedPointer,
  };
}

/**
 * Eagerly read and verify every asset referenced by the active document
 * through the accepted asset adapter. Startup is read-only for assets: no
 * workspace operation ever writes asset records.
 */
async function verifyReferencedAssets(
  confinement: RootConfinement,
  document: SceneDocumentV1,
): Promise<void> {
  const assetAdapter = createFileSystemAssetPersistenceAdapter({
    authority: confinement,
  });
  const references = new Map<string, { mimeType: string; byteLength: number }>();
  for (const element of document.elements) {
    if (element.type !== "image") continue;
    const declared = {
      mimeType: element.asset.mimeType,
      byteLength: element.asset.byteLength,
    };
    const existing = references.get(element.asset.sha256);
    if (existing !== undefined) {
      if (
        existing.mimeType !== declared.mimeType ||
        existing.byteLength !== declared.byteLength
      ) {
        // Two references to the same content-addressed bytes disagree about
        // the asset metadata: at most one declaration can be correct, so
        // verification fails closed instead of silently checking only the
        // last declaration.
        throw new HeadlessWorkspaceError("HEADLESS_WORKSPACE_ASSET_UNAVAILABLE");
      }
      // Consistent duplicate references verify through their single shared
      // record; each unique asset is read at most once.
      continue;
    }
    references.set(element.asset.sha256, declared);
  }
  for (const [sha256, expected] of references) {
    let asset: ContentAddressedAsset;
    try {
      asset = await assetAdapter.readAsset(sha256);
    } catch (error: unknown) {
      if (error instanceof FileSystemAssetPersistenceError) {
        throw new HeadlessWorkspaceError("HEADLESS_WORKSPACE_ASSET_UNAVAILABLE");
      }
      throw error;
    }
    if (
      asset.mimeType !== expected.mimeType ||
      asset.byteLength !== expected.byteLength
    ) {
      throw new HeadlessWorkspaceError("HEADLESS_WORKSPACE_ASSET_UNAVAILABLE");
    }
  }
}

function assembleWorkspace(
  runtime: WorkspaceRuntime,
  options: HeadlessDraftWorkspaceOptions,
): HeadlessDraftWorkspace {
  const { documentId, adapter, confinement } = {
    documentId: options.documentId,
    ...runtime,
  };
  const elementIdSource = options.elementIdSource ?? defaultElementIdSource;
  const nextRevisionId =
    options.revisionIdSource === undefined
      ? randomUUID
      : options.revisionIdSource;

  // Session-local undo/redo history always starts empty, including on resume.
  // The id source is inherited by every fork lineage, so ID-minting commands
  // behave like the direct domain session.
  let session: CommandSession = createCommandSession(
    documentId,
    runtime.active.document,
    elementIdSource,
  );
  let active: ActiveState = runtime.active;
  let nextSequence: number = runtime.nextSequence;
  const savedPointer = runtime.savedPointer;
  // The persisted sequence and the domain session's internal revision counter
  // advance in lockstep from construction, so this offset is constant: a
  // caller-provided persisted expectedRevision translates to the domain
  // session revision by subtracting it, and REVISION_CONFLICT semantics stay
  // with the domain layer.
  const revisionOffset = runtime.active.revision;
  let tail: Promise<void> = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = tail.then(operation);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const mutationFailure = (): HeadlessMutationResult => ({
    ok: false,
    error: { code: "DURABLE_PUBLISH_FAILED" },
  });

  const runMutation = (
    operation: (candidate: CommandSession) => DomainOutcome,
  ): Promise<HeadlessMutationResult> =>
    enqueue(async () => {
      const candidate = session.fork();
      const outcome = operation(candidate);
      if (!outcome.ok) return outcome;

      let completeRevision: CompleteSceneRevision;
      try {
        // Eagerly verify every asset referenced by the candidate document
        // before building or publishing the revision: an asset-introducing
        // mutation must fail closed without publication, commit, sequence,
        // pointer, or history advancement. Verification failures map to
        // DURABLE_PUBLISH_FAILED like every other durable publication
        // failure.
        await verifyReferencedAssets(confinement, outcome.document);
        const sequence = nextSequence;
        completeRevision = createCompleteRevision({
          documentId,
          revisionId: nextRevisionId(),
          sequence,
          document: outcome.document,
        });
        const snapshot = createRevisionPointersSnapshot({
          saved: savedPointer,
          draft: createDraftRevisionPointer(completeRevision),
        });
        if (testConfiguration?.failPublication?.() === true) {
          throw new Error("injected headless publication failure");
        }
        // Publication happens before the in-memory commit: the complete
        // revision plus the whole pointer snapshot is published, then the
        // active state advances.
        await adapter.writeCompleteRevision(completeRevision, snapshot);
      } catch {
        return mutationFailure();
      }
      session = candidate;
      // Ownership boundary: the caller-owned result document and the
      // workspace's active summary state must be independent objects. The
      // domain session snapshot is the owned read model and the returned
      // document is the domain result's own clone, so neither aliases the
      // session's internal document nor each other: caller-side mutation of
      // a returned document cannot reach later summaries or behavior.
      const { document: committedDocument } = session.snapshot();
      active = {
        revision: completeRevision.sequence,
        document: committedDocument,
      };
      nextSequence = completeRevision.sequence + 1;
      return {
        ok: true,
        revision: completeRevision.sequence,
        document: outcome.document,
      };
    });

  const summaryOf = (state: ActiveState): HeadlessDraftSummary => ({
    documentId,
    revision: state.revision,
    schemaVersion: state.document.schemaVersion,
    durationUs: state.document.durationUs,
    playbackRange: {
      startUs: state.document.playbackRange.startUs,
      endUs: state.document.playbackRange.endUs,
    },
    loop: state.document.loop,
    elementCount: state.document.elements.length,
    trackCount: state.document.tracks.length,
  });

  const workspace: HeadlessDraftWorkspace = {
    documentId,
    getDraftSummary: async () => {
      // Reads observe the last committed state without joining the tail, so a
      // summary during an in-flight mutation reports the previous commit.
      const state = active;
      return { ok: true, summary: summaryOf(state) };
    },
    validateDraft: (document: unknown) => validateSceneDocument(document),
    dispatch: (command: unknown) => {
      let isolated: unknown;
      try {
        isolated = clone(command);
      } catch {
        return Promise.resolve({
          ok: false as const,
          error: { code: "MALFORMED_COMMAND" as const },
        });
      }
      // Envelope validation is read-only, so it runs before the mutation
      // tail: a malformed command never waits for in-flight work. Caller
      // capability claims are rejected structurally; the headless capability
      // is injected below and never accepted from callers.
      const envelope = parseEnvelope(isolated);
      if (envelope === null) {
        return Promise.resolve({
          ok: false as const,
          error: { code: "MALFORMED_COMMAND" as const },
        });
      }
      const translated: unknown = {
        commandSchemaVersion: envelope.commandSchemaVersion,
        commandId: envelope.commandId,
        documentId: envelope.documentId,
        expectedRevision: envelope.expectedRevision - revisionOffset,
        payload: envelope.payload,
        actorCapability: "headless-agent",
      };
      return runMutation((candidate) => candidate.dispatch(translated));
    },
    undo: () => runMutation((candidate) => candidate.undo()),
    redo: () => runMutation((candidate) => candidate.redo()),
  };
  return Object.freeze(workspace);
}
