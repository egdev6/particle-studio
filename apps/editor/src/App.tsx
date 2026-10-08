import { useEffect, useMemo, useRef, useState } from "react";
import {
  FIRST_SLICE_DOCUMENT,
  canonicalizeSceneDocument,
  createApprovalEnvelope,
  type SceneDocumentV1,
} from "@particle-studio/scene-document";
import { renderCommands } from "@particle-studio/renderer-canvas2d";
import {
  createTimelineTransport,
  RUNTIME_VERSION,
  type ImageResolver,
  type TimelineSnapshot,
} from "@particle-studio/runtime";
import type { ElementIdSource } from "@particle-studio/commands";
import { createBrowserAgentWorkspaceAdapter } from "./browser-agent-workspace-port.js";
import { createIndexedDbPersistenceAdapter } from "@particle-studio/persistence-indexeddb";
import { createApprovalRecord } from "@particle-studio/persistence";
import { buildEditorApprovedSelfContainedHtml } from "./export-build-authority.js";
import {
  createDurableCommandBridge,
  type DurableCommandBridge,
  type DurableCommandBridgeResult,
} from "./durable-command-bridge.js";
import {
  createDurableDraftWorkspaceService,
  createPngImageCache,
  decodeVerifiedPngAsset,
  importDurablePngAsset,
  readDurableDraftRevisionEnvelope,
  resolveDurableDraftPointer,
  validateDurableDraftCanonicalContent,
  type DurableDraftWorkspace,
} from "./testing/indexeddb-recovery-harness.js";

declare global {
  interface Window {
    indexedDbRecoverySeam?: {
      read(databaseName: string): Promise<unknown>;
      seed(databaseName: string): Promise<void>;
    };
  }
}

const FOUNDATION_MESSAGE =
  "Editor authoring will begin after the deterministic core is available.";

export type EditorWorkflowRequest =
  | { readonly kind: "image-import"; readonly file: File }
  | { readonly kind: "editable-json-import"; readonly editableJson: string };

export type EditorWorkflowViewState = {
  readonly label: string;
};

export type EditorWorkflow = (
  request: EditorWorkflowRequest,
) => Promise<EditorWorkflowViewState>;

export type AppProps = {
  readonly workflow?: EditorWorkflow;
};

type WorkflowStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "pending"; readonly operation: "image" | "editable-json" }
  | { readonly kind: "success"; readonly operation: "image" | "editable-json" }
  | { readonly kind: "error"; readonly operation: "image" | "editable-json" };

const INITIAL_WORKFLOW_VIEW: EditorWorkflowViewState = {
  label: "Foundation preview",
};

function workflowStatusMessage(status: WorkflowStatus): string {
  switch (status.kind) {
    case "idle":
      return "Ready to import an image or editable JSON.";
    case "pending":
      return status.operation === "image"
        ? "Importing image…"
        : "Importing editable JSON…";
    case "success":
      return status.operation === "image"
        ? "Image imported."
        : "Editable JSON imported.";
    case "error":
      return status.operation === "image"
        ? "Unable to import image."
        : "Unable to import editable JSON.";
  }
}

const FIXTURE_IMAGE_ASSET = {
  sha256:
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  mimeType: "image/png",
  byteLength: 4,
  intrinsicWidth: 2,
  intrinsicHeight: 2,
} as const;

const GROUPED_PREVIEW_DOCUMENT = {
  ...FIRST_SLICE_DOCUMENT,
  rootIds: ["preview-group"],
  elements: [
    {
      id: "preview-group",
      type: "group",
      childrenIds: ["shape-1", "text-1", "image-1", "hidden-image-1"],
      transform: [1, 0, 0, 1, 150, 20],
    },
    { ...FIRST_SLICE_DOCUMENT.elements[0] },
    {
      id: "text-1",
      type: "text",
      text: "Hello Canvas",
      x: 4,
      y: 12,
      fontSize: 18,
      opacity: 0.5,
    },
    {
      id: "image-1",
      type: "image",
      asset: FIXTURE_IMAGE_ASSET,
      x: 8,
      y: 16,
      width: 32,
      height: 24,
      opacity: 0.4,
    },
    {
      id: "hidden-image-1",
      type: "image",
      asset: FIXTURE_IMAGE_ASSET,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      opacity: 1,
      visible: false,
    },
  ],
} as SceneDocumentV1;

function createFixtureImageResolver(): ImageResolver {
  const handle = document.createElement("canvas");
  handle.width = FIXTURE_IMAGE_ASSET.intrinsicWidth;
  handle.height = FIXTURE_IMAGE_ASSET.intrinsicHeight;

  return {
    resolve(asset) {
      if (
        asset.sha256 !== FIXTURE_IMAGE_ASSET.sha256 ||
        asset.mimeType !== FIXTURE_IMAGE_ASSET.mimeType ||
        asset.byteLength !== FIXTURE_IMAGE_ASSET.byteLength ||
        asset.intrinsicWidth !== FIXTURE_IMAGE_ASSET.intrinsicWidth ||
        asset.intrinsicHeight !== FIXTURE_IMAGE_ASSET.intrinsicHeight
      ) {
        return undefined;
      }
      return { handle, ...asset };
    },
  };
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function decodeBrowserPng(bytes: Uint8Array) {
  const blob = new Blob([copyToArrayBuffer(bytes)], { type: "image/png" });
  try {
    return await createImageBitmap(blob);
  } catch {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("PNG_IMAGE_DECODE_FAILED"));
        image.src = objectUrl;
      });
      return image;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

const EDITOR_DATABASE_NAME = "particle-studio-editor";
const EDITOR_DOCUMENT_ID = "particle-studio-editor-document";

const workspaceActivationAuthorities = new WeakMap<
  EditorWorkflowViewState,
  DurableDraftWorkspace
>();
const persistedAssetViews = new WeakSet<EditorWorkflowViewState>();

type DurableApproval = {
  readonly revisionId: string;
  readonly snapshotHash: string;
};

type FinalizedDurableHtmlExport = {
  readonly bytes: Uint8Array;
  readonly manifest: unknown;
};

type DurableCommandUnavailableResult = {
  readonly ok: false;
  readonly error: { readonly code: "DURABLE_COMMAND_UNAVAILABLE" };
};

type DurableBrowserCommandResult =
  | DurableCommandBridgeResult
  | DurableCommandUnavailableResult;

type DurableBrowserCommandOperation = {
  readonly result: DurableBrowserCommandResult;
};

type DurableWorkspaceIdentity = {
  readonly documentId: string;
  readonly revisionId: string;
};

type DurableBrowserComposition = {
  readonly workflow: EditorWorkflow;
  readonly approve: () => Promise<DurableApproval>;
  readonly readApproval: () => Promise<DurableApproval | null>;
  readonly exportApprovedHtml: () => Promise<FinalizedDurableHtmlExport>;
  readonly reload: () => Promise<DurableDraftWorkspace | null>;
  readonly dispatch: (
    command: unknown,
  ) => Promise<DurableBrowserCommandOperation>;
  readonly undo: () => Promise<DurableBrowserCommandOperation>;
  readonly redo: () => Promise<DurableBrowserCommandOperation>;
  readonly snapshot: () => Promise<ReturnType<
    DurableCommandBridge["snapshot"]
  > | null>;
  readonly release: () => Promise<void>;
};

type DurableBrowserCompositionDependencies = {
  readonly repository: ReturnType<typeof createIndexedDbPersistenceAdapter>;
  readonly cache: ReturnType<typeof createPngImageCache>;
  readonly service: ReturnType<typeof createDurableDraftWorkspaceService>;
  readonly resolvePointer: typeof resolveDurableDraftPointer;
  readonly readEnvelope: typeof readDurableDraftRevisionEnvelope;
  readonly validateContent: typeof validateDurableDraftCanonicalContent;
  readonly buildApprovedHtml: typeof buildEditorApprovedSelfContainedHtml;
  readonly commandIdSource?: ElementIdSource;
  readonly activateCommandWorkspace?: (
    workspace: DurableDraftWorkspace,
  ) => void;
};

function exactWorkspaceImageResolver(
  workspace: DurableDraftWorkspace,
): ImageResolver {
  return {
    resolve(reference) {
      const image = workspace.images.find(
        (candidate) =>
          Object.is(candidate.sha256, reference.sha256) &&
          Object.is(candidate.mimeType, reference.mimeType) &&
          Object.is(candidate.byteLength, reference.byteLength) &&
          Object.is(candidate.width, reference.intrinsicWidth) &&
          Object.is(candidate.height, reference.intrinsicHeight),
      );
      return image === undefined
        ? undefined
        : {
            ...reference,
            handle: image.handle,
          };
    },
  };
}

function createDurableBrowserCompositionDependencies(): DurableBrowserCompositionDependencies {
  const repository = createIndexedDbPersistenceAdapter({
    databaseName: EDITOR_DATABASE_NAME,
  });
  const cache = createPngImageCache({
    importVerifiedPng: (input) =>
      importDurablePngAsset(input, {
        assets: repository,
        sha256: async (bytes) => {
          const digest = await globalThis.crypto.subtle.digest(
            "SHA-256",
            copyToArrayBuffer(bytes),
          );
          return `sha256:${toHex(new Uint8Array(digest))}`;
        },
      }),
    decodeVerifiedPng: (asset) =>
      decodeVerifiedPngAsset(asset, {
        decodePng: async (bytes) => {
          const handle = await decodeBrowserPng(bytes);
          return { width: handle.width, height: handle.height, handle };
        },
      }),
  });
  const service = createDurableDraftWorkspaceService({
    documentId: EDITOR_DOCUMENT_ID,
    revisionId: () => `draft-${globalThis.crypto.randomUUID()}`,
    sequence: () => Date.now(),
    createdAt: () => Date.now(),
    repository,
    prehydration: {
      cache,
      rereadVerifiedPng: async (sha256) => {
        const asset = await repository.readAsset(sha256);
        if (asset.mimeType !== "image/png") {
          throw new Error("DURABLE_PNG_MISSING");
        }
        return asset as typeof asset & { readonly mimeType: "image/png" };
      },
      decodeVerifiedPng: (asset) =>
        decodeVerifiedPngAsset(asset, {
          decodePng: async (bytes) => {
            const handle = await decodeBrowserPng(bytes);
            return { width: handle.width, height: handle.height, handle };
          },
        }),
    },
  });

  return {
    repository,
    cache,
    service,
    resolvePointer: resolveDurableDraftPointer,
    readEnvelope: readDurableDraftRevisionEnvelope,
    validateContent: validateDurableDraftCanonicalContent,
    buildApprovedHtml: buildEditorApprovedSelfContainedHtml,
    activateCommandWorkspace: () => undefined,
  };
}

function releasedCompositionError(): Error {
  return new Error("DURABLE_BROWSER_COMPOSITION_RELEASED");
}

const unavailableDurableCommand = (): DurableCommandUnavailableResult => ({
  ok: false,
  error: { code: "DURABLE_COMMAND_UNAVAILABLE" },
});

const durableCommandPublishFailure = (): DurableCommandBridgeResult => ({
  ok: false,
  error: { code: "DURABLE_PUBLISH_FAILED" },
});

const browserCommandIdSource: ElementIdSource = () => {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid !== "function") return { kind: "unavailable" };
  return {
    kind: "id",
    id: `element-${randomUuid.call(globalThis.crypto)}`,
  };
};

function createDurableBrowserComposition(
  dependencies = createDurableBrowserCompositionDependencies(),
): DurableBrowserComposition {
  let operationTail = Promise.resolve();
  let released = false;
  let releasePromise: Promise<void> | undefined;
  let commandBridge: DurableCommandBridge | null = null;
  let commandBridgeIdentity: DurableWorkspaceIdentity | null = null;
  let publishedCommandWorkspace: DurableDraftWorkspace | null = null;

  const enqueue = <Value,>(operation: () => Promise<Value>): Promise<Value> => {
    if (released) return Promise.reject(releasedCompositionError());
    const queued = operationTail.then(async () => {
      if (released) throw releasedCompositionError();
      const value = await operation();
      if (released) throw releasedCompositionError();
      return value;
    });
    operationTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  };

  const refreshCommandBridge = (workspace: DurableDraftWorkspace): void => {
    const bridgeIdentity: DurableWorkspaceIdentity = {
      documentId: workspace.documentId,
      revisionId: workspace.revisionId,
    };
    commandBridgeIdentity = bridgeIdentity;
    commandBridge = createDurableCommandBridge({
      documentId: bridgeIdentity.documentId,
      document: workspace.plan.document,
      idSource: dependencies.commandIdSource ?? browserCommandIdSource,
      publish: async (document) => {
        const expected = commandBridgeIdentity;
        const current = dependencies.service.current;
        if (
          expected === null ||
          current === null ||
          current.documentId !== expected.documentId ||
          current.revisionId !== expected.revisionId
        ) {
          throw new Error("DURABLE_COMMAND_WORKSPACE_UNAVAILABLE");
        }
        const approval = await dependencies.repository.readApproval(
          current.documentId,
          current.revisionId,
        );
        const editableJson = new TextDecoder().decode(
          canonicalizeSceneDocument.exportEditableJson(document),
        );
        const currentAfterApproval = dependencies.service.current;
        if (
          currentAfterApproval === null ||
          currentAfterApproval.documentId !== expected.documentId ||
          currentAfterApproval.revisionId !== expected.revisionId
        ) {
          throw new Error("DURABLE_COMMAND_WORKSPACE_UNAVAILABLE");
        }
        publishedCommandWorkspace = await dependencies.service.publish(
          editableJson,
          approval,
        );
      },
    });
  };

  const runCommand = (
    operation: (
      bridge: DurableCommandBridge,
    ) => Promise<DurableCommandBridgeResult>,
  ): Promise<DurableBrowserCommandOperation> =>
    enqueue(async () => {
      const bridge = commandBridge;
      if (bridge === null) return { result: unavailableDurableCommand() };
      publishedCommandWorkspace = null;
      const result = await operation(bridge);
      if (!result.ok) return { result };
      const workspace =
        publishedCommandWorkspace as DurableDraftWorkspace | null;
      const current = dependencies.service.current;
      if (
        workspace === null ||
        current === null ||
        current.documentId !== workspace.documentId ||
        current.revisionId !== workspace.revisionId
      ) {
        return { result: durableCommandPublishFailure() };
      }
      if (released) throw releasedCompositionError();
      commandBridgeIdentity = {
        documentId: workspace.documentId,
        revisionId: workspace.revisionId,
      };
      dependencies.activateCommandWorkspace?.(workspace);
      return { result };
    });

  return {
    workflow(request) {
      return enqueue(async () => {
        if (request.kind === "image-import") {
          await dependencies.cache.importPng({
            mimeType: request.file.type,
            bytes: new Uint8Array(await request.file.arrayBuffer()),
          });
          const view = Object.freeze({ label: "Verified PNG asset" });
          persistedAssetViews.add(view);
          return view;
        }
        const prior = dependencies.service.current;
        const approval =
          prior == null
            ? null
            : await dependencies.repository.readApproval(
                prior.documentId,
                prior.revisionId,
              );
        const workspace = await dependencies.service.publish(
          request.editableJson,
          approval,
        );
        refreshCommandBridge(workspace);
        const view = Object.freeze({ label: `Draft ${workspace.revisionId}` });
        workspaceActivationAuthorities.set(view, workspace);
        return view;
      });
    },
    approve() {
      return enqueue(async () => {
        const workspace = dependencies.service.current;
        if (workspace === null) throw new Error("DURABLE_APPROVAL_UNAVAILABLE");
        const verifiedAssetManifest = workspace.plan.references.map(
          (reference) => ({
            sha256: reference.sha256,
            mimeType: reference.mimeType,
            byteLength: reference.byteLength,
          }),
        );
        const envelope = await createApprovalEnvelope({
          document: workspace.plan.document,
          runtimeVersion: RUNTIME_VERSION,
          verifiedAssetManifest,
        });
        await dependencies.repository.writeApproval(
          createApprovalRecord({
            documentId: workspace.documentId,
            revisionId: workspace.revisionId,
            approvalEnvelope: envelope,
            snapshotHash: envelope.snapshotHash,
            approvalEnvelopeBytes: envelope.bytes,
            canonicalDocumentBytes: workspace.canonicalBytes,
            verifiedAssetManifest,
            audit: {
              approvedAt: workspace.createdAt,
              actorLabel: "local-human",
            },
          }),
        );
        return {
          revisionId: workspace.revisionId,
          snapshotHash: envelope.snapshotHash,
        };
      });
    },
    readApproval() {
      return enqueue(async () => {
        const workspace = dependencies.service.current;
        if (workspace === null) return null;
        const approval = await dependencies.repository.readApproval(
          workspace.documentId,
          workspace.revisionId,
        );
        return approval === null
          ? null
          : {
              revisionId: approval.revisionId,
              snapshotHash: approval.snapshotHash,
            };
      });
    },
    exportApprovedHtml() {
      return enqueue(async () => {
        const workspace = dependencies.service.current;
        if (workspace === null) throw new Error("DURABLE_EXPORT_UNAVAILABLE");
        const approval = await dependencies.repository.readApproval(
          workspace.documentId,
          workspace.revisionId,
        );
        if (approval === null) throw new Error("DURABLE_EXPORT_UNAVAILABLE");

        const exported = await dependencies.buildApprovedHtml({
          approval,
          assets: dependencies.repository,
        });
        const current = dependencies.service.current;
        const currentApproval =
          current === null
            ? null
            : await dependencies.repository.readApproval(
                current.documentId,
                current.revisionId,
              );
        if (
          released ||
          current === null ||
          current.documentId !== workspace.documentId ||
          current.revisionId !== workspace.revisionId ||
          currentApproval === null ||
          currentApproval.snapshotHash !== approval.snapshotHash
        ) {
          throw new Error("DURABLE_EXPORT_STALE");
        }

        const bytes = exported.files.get("particle-studio.html");
        if (bytes === undefined)
          throw new Error("DURABLE_EXPORT_FINALIZATION_FAILED");
        return { bytes: bytes.slice(), manifest: exported.manifest };
      });
    },
    reload() {
      return enqueue(async () => {
        try {
          const pointer = await dependencies.resolvePointer({
            documentId: EDITOR_DOCUMENT_ID,
            repository: dependencies.repository,
          });
          const envelope = await dependencies.readEnvelope(pointer);
          const workspace = await dependencies.service.reload(
            dependencies.validateContent(envelope),
            pointer,
          );
          refreshCommandBridge(workspace);
          return workspace;
        } catch {
          if (released) throw releasedCompositionError();
          return null;
        }
      });
    },
    dispatch(command) {
      return runCommand((bridge) => bridge.dispatch(command));
    },
    undo() {
      return runCommand((bridge) => bridge.undo());
    },
    redo() {
      return runCommand((bridge) => bridge.redo());
    },
    snapshot() {
      return enqueue(async () => commandBridge?.snapshot() ?? null);
    },
    release() {
      if (releasePromise) return releasePromise;
      released = true;
      commandBridge = null;
      commandBridgeIdentity = null;
      publishedCommandWorkspace = null;
      releasePromise = operationTail.then(() => {
        dependencies.service.release();
      });
      return releasePromise;
    },
  };
}

export const createDurableBrowserCompositionForTesting =
  import.meta.env.MODE === "test"
    ? (dependencies: DurableBrowserCompositionDependencies) =>
        createDurableBrowserComposition(dependencies)
    : undefined;

function downloadFinalizedHtml(bytes: Uint8Array): void {
  const blob = new Blob([copyToArrayBuffer(bytes)], { type: "text/html" });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  try {
    anchor.href = objectUrl;
    anchor.download = "particle-studio.html";
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  }
}

export const deliverFinalizedHtmlForTesting =
  import.meta.env.MODE === "test" ? downloadFinalizedHtml : undefined;

export function App({ workflow }: AppProps) {
  const [message, setMessage] = useState("Foundation shell is ready.");
  const [editableJson, setEditableJson] = useState("");
  const [selectedImage, setSelectedImage] = useState<File>();
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatus>({
    kind: "idle",
  });
  const [workflowView, setWorkflowView] = useState(INITIAL_WORKFLOW_VIEW);
  const [durableAssetState, setDurableAssetState] = useState("asset idle");
  const [durableDraftState, setDurableDraftState] = useState("draft idle");
  const [durableRevision, setDurableRevision] = useState("");
  const [approval, setApproval] = useState<DurableApproval | null>(null);
  const [approvalState, setApprovalState] = useState("draft");
  const [exportState, setExportState] = useState("unavailable");
  const [approvalParentHash, setApprovalParentHash] = useState("");

  const [approvalInvalidationReason, setApprovalInvalidationReason] =
    useState("");
  const [durableRehydrationState, setDurableRehydrationState] =
    useState("rehydration idle");
  const workflowInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const activateCommandWorkspaceRef = useRef<
    (workspace: DurableDraftWorkspace) => void
  >(() => undefined);
  const composition = useMemo(
    () =>
      createDurableBrowserComposition({
        ...createDurableBrowserCompositionDependencies(),
        activateCommandWorkspace: (workspace) =>
          activateCommandWorkspaceRef.current(workspace),
      }),
    [],
  );
  // External browser-agent host registration is deliberately deferred.
  const browserAgentAdapter = useMemo(
    () =>
      createBrowserAgentWorkspaceAdapter({
        documentId: EDITOR_DOCUMENT_ID,
        snapshot: composition.snapshot,
        dispatch: composition.dispatch,
        undo: composition.undo,
        redo: composition.redo,
      }),
    [composition],
  );
  void browserAgentAdapter;
  const editorWorkflow = workflow ?? composition.workflow;
  const [canonicalizationProof, setCanonicalizationProof] = useState<
    { hex: string; sha256: string } | undefined
  >();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageResolver = useMemo(createFixtureImageResolver, []);
  const transportRef = useRef<ReturnType<
    typeof createTimelineTransport
  > | null>(null);
  if (!transportRef.current) {
    transportRef.current = createTimelineTransport(GROUPED_PREVIEW_DOCUMENT, {
      imageResolver,
    });
  }
  const transport = transportRef.current;
  const [snapshot, setSnapshot] = useState<TimelineSnapshot>(() =>
    transport.snapshot(),
  );
  const activateDurableWorkspace = (workspace: DurableDraftWorkspace) => {
    const nextTransport = createTimelineTransport(workspace.plan.document, {
      imageResolver: exactWorkspaceImageResolver(workspace),
    });
    transportRef.current = nextTransport;
    setSnapshot(nextTransport.snapshot());
    setDurableRevision(workspace.revisionId);
    setDurableDraftState("draft active");
    setApproval(null);
    setApprovalState("draft");
    setExportState("unavailable");
    setApprovalParentHash(workspace.parentApprovalHash ?? "");

    setApprovalInvalidationReason(workspace.approvalInvalidationReason ?? "");
  };
  const animationFrameRef = useRef<number | undefined>(undefined);
  const previousFrameMsRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    activateCommandWorkspaceRef.current = (workspace) => {
      if (mountedRef.current) activateDurableWorkspace(workspace);
    };
    return () => {
      activateCommandWorkspaceRef.current = () => undefined;
    };
  }, [activateDurableWorkspace]);

  useEffect(() => {
    if (
      new URLSearchParams(globalThis.location.search).get(
        "indexeddb-recovery",
      ) !== "1"
    ) {
      return;
    }

    void import("./testing/indexeddb-recovery-harness.js").then(
      ({ readIndexedDbRecoveryOffer, seedIndexedDbRecoveryOffer }) => {
        window.indexedDbRecoverySeam = {
          read: readIndexedDbRecoveryOffer,
          seed: seedIndexedDbRecoveryOffer,
        };
      },
    );
  }, []);

  useEffect(() => {
    let mounted = true;
    setDurableRehydrationState("rehydration pending");
    void composition
      .reload()
      .then((workspace) => {
        if (!mounted) return;
        if (workspace === null) {
          setDurableRehydrationState("rehydration idle");
          return;
        }
        activateDurableWorkspace(workspace);
        void composition.readApproval().then((persistedApproval) => {
          if (!mounted || persistedApproval === null) return;
          setApproval(persistedApproval);
          setApprovalState("approved");
          setExportState("ready");
        });
        setDurableRehydrationState("rehydrated");
      })
      .catch(() => {
        if (mounted) setDurableRehydrationState("rehydration idle");
      });
    return () => {
      mounted = false;
      queueMicrotask(() => {
        if (!mountedRef.current) void composition.release();
      });
    };
  }, [composition]);

  useEffect(() => {
    if (!globalThis.crypto?.subtle) {
      return;
    }

    const canonical = canonicalizeSceneDocument(FIRST_SLICE_DOCUMENT);
    const hex = toHex(canonical.bytes);
    let reloaded: unknown;
    try {
      reloaded = JSON.parse(new TextDecoder().decode(canonical.bytes));
    } catch {
      throw new Error("CANONICALIZATION_RELOAD_MISMATCH");
    }

    if (toHex(canonicalizeSceneDocument(reloaded).bytes) !== hex) {
      throw new Error("CANONICALIZATION_RELOAD_MISMATCH");
    }

    const browserBytes = new Uint8Array(canonical.bytes);
    void globalThis.crypto.subtle
      .digest("SHA-256", browserBytes)
      .then((digest) => {
        setCanonicalizationProof({
          hex,
          sha256: toHex(new Uint8Array(digest)),
        });
      });
  }, []);

  const cancelAnimation = () => {
    if (animationFrameRef.current !== undefined) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = undefined;
    }
    previousFrameMsRef.current = undefined;
  };

  useEffect(() => {
    if (!snapshot.playing) {
      cancelAnimation();
      return;
    }

    const advanceFrame = (frameMs: number) => {
      const previousFrameMs = previousFrameMsRef.current;
      previousFrameMsRef.current = frameMs;
      const elapsedUs =
        previousFrameMs === undefined
          ? 0
          : Math.floor(Math.max(0, frameMs - previousFrameMs) * 1_000);
      transport.advance(elapsedUs);
      const nextSnapshot = transport.snapshot();
      setSnapshot(nextSnapshot);
      if (nextSnapshot.playing) {
        animationFrameRef.current = requestAnimationFrame(advanceFrame);
      } else {
        animationFrameRef.current = undefined;
      }
    };

    animationFrameRef.current = requestAnimationFrame(advanceFrame);
    return cancelAnimation;
  }, [snapshot.playing, transport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.width = canvas.width;
    const context = canvas.getContext("2d");
    if (!context) return;
    renderCommands(context, snapshot.evaluation.commands);
  }, [snapshot.evaluation.commands]);

  const opacity = snapshot.evaluation.state.elements[0]?.opacity;
  const workflowMessage = workflowStatusMessage(workflowStatus);
  const workflowPending = workflowStatus.kind === "pending";

  const runWorkflow = (request: EditorWorkflowRequest) => {
    if (workflowInFlightRef.current) return;

    workflowInFlightRef.current = true;
    const operation =
      request.kind === "image-import" ? "image" : "editable-json";
    setWorkflowStatus({ kind: "pending", operation });
    let operationResult: Promise<EditorWorkflowViewState>;
    try {
      operationResult = Promise.resolve(editorWorkflow(request));
    } catch {
      workflowInFlightRef.current = false;
      setWorkflowStatus({ kind: "error", operation });
      return;
    }
    void operationResult
      .then((view) => {
        if (!mountedRef.current) return;
        const label =
          view !== null && typeof view === "object" ? view.label : undefined;
        if (typeof label !== "string") {
          throw new Error("EDITOR_WORKFLOW_VIEW_INVALID");
        }
        setWorkflowView({ label });
        if (persistedAssetViews.has(view)) {
          setDurableAssetState("asset persisted");
        }
        const workspace = workspaceActivationAuthorities.get(view);
        if (workspace !== undefined) {
          workspaceActivationAuthorities.delete(view);
          activateDurableWorkspace(workspace);
          setDurableRehydrationState("rehydration active");
        }
        setWorkflowStatus({ kind: "success", operation });
      })
      .catch(() => {
        if (mountedRef.current) {
          setWorkflowStatus({ kind: "error", operation });
        }
      })
      .finally(() => {
        workflowInFlightRef.current = false;
      });
  };

  const importImage = () => {
    if (workflowInFlightRef.current) return;
    if (!selectedImage) {
      setWorkflowStatus({ kind: "error", operation: "image" });
      return;
    }
    runWorkflow({ kind: "image-import", file: selectedImage });
  };

  const importEditableJson = () => {
    runWorkflow({ kind: "editable-json-import", editableJson });
  };

  const approveSnapshot = () => {
    if (workflow !== undefined || durableDraftState !== "draft active") return;
    setApprovalState("approving");
    void composition
      .approve()
      .then((nextApproval) => {
        if (!mountedRef.current) return;
        setApproval(nextApproval);
        setApprovalState("approved");
        setExportState("ready");
      })
      .catch(() => {
        if (mountedRef.current) setApprovalState("approval failed");
      });
  };

  const exportAvailable =
    workflow === undefined &&
    durableDraftState === "draft active" &&
    approvalState === "approved" &&
    approval !== null &&
    approval.revisionId === durableRevision &&
    exportState === "ready";

  const downloadApprovedHtml = () => {
    if (!exportAvailable) return;
    setExportState("rechecking");
    void composition
      .exportApprovedHtml()
      .then((exported) => {
        if (!mountedRef.current) return;
        downloadFinalizedHtml(exported.bytes);
        setExportState("ready");
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        setExportState(
          error instanceof Error &&
            error.message === "DURABLE_EXPORT_UNAVAILABLE"
            ? "unavailable"
            : "failed",
        );
      });
  };

  const activateWithKeyboard = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    action: () => void,
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  };

  return (
    <main className="editor-shell">
      <header className="editor-shell__header">
        <p className="editor-shell__eyebrow">Particle Studio</p>
        <h1>Editor foundation</h1>
        <p>
          This static shell establishes the UI boundary without loading a scene
          or editing product data.
        </p>
      </header>

      <section aria-labelledby="foundation-status">
        <h2 id="foundation-status">Workspace status</h2>
        <p aria-live="polite">{message}</p>
        <button onClick={() => setMessage(FOUNDATION_MESSAGE)} type="button">
          Review foundation scope
        </button>
      </section>

      <section aria-labelledby="authoring-heading">
        <h2 id="authoring-heading">Import editable assets</h2>
        {workflowStatus.kind === "error" ? (
          <p role="alert">{workflowMessage}</p>
        ) : (
          <p role="status">{workflowMessage}</p>
        )}
        <p data-testid="workflow-rendered-view">{workflowView.label}</p>
        <p data-testid="durable-asset-state">{durableAssetState}</p>
        <p data-testid="durable-draft-state">{durableDraftState}</p>
        <p data-testid="durable-rehydration-state">{durableRehydrationState}</p>
        <p data-testid="durable-revision">{durableRevision}</p>
        <p data-testid="approval-state">{approvalState}</p>
        <p aria-live="polite" data-testid="export-state">
          {exportState}
        </p>
        <p data-testid="approval-revision">{approval?.revisionId ?? ""}</p>

        <p data-testid="approval-snapshot-hash">
          {approval?.snapshotHash ?? ""}
        </p>
        <p data-testid="approval-parent-hash">{approvalParentHash}</p>
        <p data-testid="approval-invalidation-reason">
          {approvalInvalidationReason}
        </p>
        <button
          disabled={
            workflow !== undefined ||
            durableDraftState !== "draft active" ||
            approvalState === "approving"
          }
          onClick={approveSnapshot}
          type="button"
        >
          Approve local snapshot
        </button>
        <button
          disabled={!exportAvailable}
          onClick={downloadApprovedHtml}
          type="button"
        >
          Download approved HTML
        </button>

        <label>
          Image to import
          <input
            accept="image/png"
            disabled={workflowPending}
            onChange={(event) => {
              setSelectedImage(event.currentTarget.files?.[0]);
            }}
            type="file"
          />
        </label>
        <button
          disabled={workflowPending}
          onClick={importImage}
          onKeyDown={(event) => activateWithKeyboard(event, importImage)}
          type="button"
        >
          Import image
        </button>
        <label>
          Editable JSON
          <textarea
            disabled={workflowPending}
            onChange={(event) => setEditableJson(event.currentTarget.value)}
            value={editableJson}
          />
        </label>
        <button
          disabled={workflowPending}
          onClick={importEditableJson}
          onKeyDown={(event) => activateWithKeyboard(event, importEditableJson)}
          type="button"
        >
          Import editable JSON
        </button>
      </section>

      <section aria-labelledby="preview-heading">
        <h2 id="preview-heading">Canvas2D preview</h2>
        <p data-testid="preview-time-us">{snapshot.playheadUs}</p>
        <p data-testid="transport-playhead-us">{snapshot.playheadUs}</p>
        <p data-testid="transport-status">
          {snapshot.playing ? "playing" : "paused"}
        </p>
        <p data-testid="transport-loop">
          {GROUPED_PREVIEW_DOCUMENT.loop ? "enabled" : "disabled"}
        </p>
        <p data-testid="preview-opacity">{opacity}</p>
        <label>
          Timeline position
          <input
            aria-label="Timeline position"
            max={GROUPED_PREVIEW_DOCUMENT.durationUs}
            min={0}
            onChange={(event) => {
              transport.seek(Number(event.currentTarget.value));
              previousFrameMsRef.current = undefined;
              setSnapshot(transport.snapshot());
            }}
            step={1}
            type="range"
            value={snapshot.playheadUs}
          />
        </label>
        <button
          onClick={() => {
            previousFrameMsRef.current = undefined;
            transport.play();
            setSnapshot(transport.snapshot());
          }}
          type="button"
        >
          Play
        </button>
        <button
          onClick={() => {
            transport.pause();
            cancelAnimation();
            setSnapshot(transport.snapshot());
          }}
          type="button"
        >
          Pause
        </button>
        <canvas
          aria-label="Scene preview"
          data-testid="scene-preview"
          height={120}
          ref={canvasRef}
          width={200}
        />
      </section>

      {canonicalizationProof && (
        <section aria-label="Chromium canonicalization proof">
          <p data-testid="canonicalization-identifier">jcs-1</p>
          <p data-testid="canonicalization-hex">{canonicalizationProof.hex}</p>
          <p data-testid="canonicalization-sha256">
            {canonicalizationProof.sha256}
          </p>
        </section>
      )}
    </main>
  );
}
