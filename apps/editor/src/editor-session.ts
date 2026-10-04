import type { ElementIdSource } from "@particle-studio/commands";
import { createEditorDurableEditing } from "./editor-durable-editing.js";

type RectangleGeometry = Pick<EditorImageImportGeometry, "x" | "y" | "width" | "height">;
import {
  importDurablePngAsset, type DurablePngAssetPort, type Sha256,
} from "./durable-png-import.js";
import { decodeVerifiedPngAsset, type PngDecodePrimitive } from "./verified-png-decode.js";
import { createPngImageCache, type PngImageCache } from "./png-image-cache.js";
import {
  createDurableDraftWorkspace, type DurableDraftWorkspace,
  type DurableDraftWriteWorkspaceDependencies,
} from "./durable-draft-workspace.js";
import {
  createEditorImageImportWorkflow, type EditorImageImportGeometry,
} from "./editor-image-import-workflow.js";
import { createEditorImportWorkflow } from "./editor-import-workflow.js";
import type { EditorImportWorkflow } from "./editor-import-controls.js";
import {
  createEditorBrowserAgentWorkspace, type EditorBrowserAgentWorkspaceResult,
} from "./editor-browser-agent-workspace.js";

export interface EditorSessionDependencies {
  readonly persistence: DurableDraftWriteWorkspaceDependencies["persistence"] & DurablePngAssetPort;
  readonly documentId: string;
  readonly sha256: Sha256;
  readonly decodePng: PngDecodePrimitive["decodePng"];
  /** Startup-known lower bound for JSON imports only; invoked once per activation, never at construction. */
  readonly jsonImportSequenceFloor?: () => number;
  readonly revisionId: () => string;
  readonly createdAt: () => number;
  readonly commandId: () => string;
  readonly elementIdSource: ElementIdSource;
  readonly geometry: () => EditorImageImportGeometry;
}

/** One selected published shape and its atomic authored/local coordinates. */
export interface ShapePositionRequest {
  readonly documentId: string;
  readonly revisionId: string;
  readonly elementId: string;
  readonly x: number;
  readonly y: number;
}

export interface EditorSession {
  readonly workspace: DurableDraftWorkspace;
  readonly cache: PngImageCache;
  readonly importWorkflow: EditorImportWorkflow;
  reload(): ReturnType<DurableDraftWorkspace["reload"]>;
  createAgent(): EditorBrowserAgentWorkspaceResult;
  addRectangle(geometry: RectangleGeometry): Promise<void>;
  setShapePosition(request: ShapePositionRequest): Promise<void>;
}

/**
 * Non-UI assembly over caller-owned persistence. Construction performs no I/O;
 * reload and agent creation are explicit, with no disposal or rebase authority.
 * Revision IDs must remain unique across import and editing attempts. Imports
 * observe the live durable sequence; editing retains its private source binding.
 */
export function createEditorSession(deps: EditorSessionDependencies): EditorSession {
  // Read declared fields once, including getter-backed options, before any I/O.
  const captured: EditorSessionDependencies = {
    persistence: deps.persistence,
    documentId: deps.documentId,
    sha256: deps.sha256,
    decodePng: deps.decodePng,
    jsonImportSequenceFloor: deps.jsonImportSequenceFloor,
    revisionId: deps.revisionId,
    createdAt: deps.createdAt,
    commandId: deps.commandId,
    elementIdSource: deps.elementIdSource,
    geometry: deps.geometry,
  };
  const port = captured.persistence;
  const persistence: EditorSessionDependencies["persistence"] = {
    readPointers: port.readPointers.bind(port),
    readRevision: port.readRevision.bind(port),
    writeCompleteRevision: port.writeCompleteRevision.bind(port),
    writeCompleteRevisionIfPointersMatch: port.writeCompleteRevisionIfPointersMatch.bind(port),
    writeAsset: port.writeAsset.bind(port),
    readAsset: port.readAsset.bind(port),
  };
  const decodeVerifiedPng = (verified: Parameters<typeof decodeVerifiedPngAsset>[0]) =>
    decodeVerifiedPngAsset(verified, { decodePng: captured.decodePng });
  const cache = createPngImageCache({
    importVerifiedPng: (input) => importDurablePngAsset(input, {
      assets: persistence, sha256: captured.sha256,
    }),
    decodeVerifiedPng,
  });
  const workspace = createDurableDraftWorkspace({
    persistence, cache,
    prehydration: {
      rereadVerifiedPng: (hash) => persistence.readAsset(hash),
      decodeVerifiedPng,
    },
  });
  const sequence = () => (workspace.current?.revision.sequence ?? 0) + 1;
  const imageWorkflow = createEditorImageImportWorkflow({
    workspace, cache, assets: persistence,
    sha256: captured.sha256, decodePng: captured.decodePng,
    revisionId: captured.revisionId, createdAt: captured.createdAt,
    commandId: captured.commandId, elementIdSource: captured.elementIdSource,
    geometry: captured.geometry, sequence,
  });
  const importWorkflow = createEditorImportWorkflow({
    workspace, imageWorkflow, documentId: captured.documentId,
    revisionId: captured.revisionId, createdAt: captured.createdAt,
    sequence: () => {
      const floor = captured.jsonImportSequenceFloor === undefined ? 0 : captured.jsonImportSequenceFloor();
      const current = workspace.current?.revision.sequence ?? 0;
      if (!Number.isSafeInteger(floor) || floor < 0 ||
        !Number.isSafeInteger(current) || current < 0) {
        throw new Error("EDITOR_JSON_IMPORT_SEQUENCE_INVALID");
      }
      const next = Math.max(current, floor) + 1;
      if (!Number.isSafeInteger(next)) throw new Error("EDITOR_JSON_IMPORT_SEQUENCE_INVALID");
      return next;
    },
  });
  return Object.freeze({
    workspace, cache, importWorkflow,
    reload: () => workspace.reload({ documentId: captured.documentId }),
    addRectangle: async (geometry: RectangleGeometry): Promise<void> => {
      const current = workspace.current;
      if (current === null || current.revision.documentId !== captured.documentId ||
        !Number.isSafeInteger(current.revision.sequence) || current.revision.sequence < 0 ||
        !Number.isSafeInteger(current.revision.sequence + 1)) {
        throw new Error("EDITOR_RECTANGLE_SOURCE_UNAVAILABLE");
      }
      // Initialize from the genuine source before reading inputs or generating
      // metadata. The helper captures/clones it and never rebases this attempt.
      const bridge = createEditorDurableEditing({ workspace,
        revisionId: () => revisionId, createdAt: () => createdAt,
        commandElementIdSource: () => ({ ...elementId }),
      });
      if (!bridge.ok) throw new Error(bridge.error.code);
      const rectangle = { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height };
      if (!Object.values(rectangle).every(Number.isFinite) || rectangle.width <= 0 || rectangle.height <= 0) {
        throw new Error("EDITOR_RECTANGLE_GEOMETRY_INVALID");
      }
      // Bridge dispatch is queued: constant callbacks protect this activation's
      // identity/time even if caller-owned sources change before publication.
      const commandId = captured.commandId();
      const elementId = { ...captured.elementIdSource() };
      const revisionId = captured.revisionId();
      const createdAt = captured.createdAt();
      const result = await bridge.editing.dispatch({ commandSchemaVersion: 1,
        commandId, documentId: captured.documentId, expectedRevision: 0,
        actorCapability: "human-ui", payload: { type: "create-element",
          element: { type: "shape", ...rectangle, opacity: 1 } },
      });
      if (!result.ok) throw new Error(result.error.code);
    },
    setShapePosition: async (request: ShapePositionRequest): Promise<void> => {
      let position: ShapePositionRequest;
      try {
        position = Object.freeze({ documentId: request.documentId, revisionId: request.revisionId,
          elementId: request.elementId, x: request.x, y: request.y });
      } catch { throw new Error("EDITOR_SHAPE_POSITION_INPUT_INVALID"); }
      const current = workspace.current;
      if (!current || current.revision.documentId !== captured.documentId ||
        !Number.isSafeInteger(current.revision.sequence) || current.revision.sequence < 0 ||
        !Number.isSafeInteger(current.revision.sequence + 1)) {
        throw new Error("EDITOR_SHAPE_POSITION_SOURCE_UNAVAILABLE");
      }
      const { documentId, revisionId: selectedRevisionId, elementId, x, y } = position;
      if (typeof documentId !== "string" || !documentId ||
        typeof selectedRevisionId !== "string" || !selectedRevisionId ||
        typeof elementId !== "string" || !elementId ||
        documentId !== current.revision.documentId || selectedRevisionId !== current.revision.revisionId) {
        throw new Error("EDITOR_SHAPE_POSITION_SOURCE_MISMATCH");
      }
      const element = current.revision.document.elements.find((candidate) => candidate.id === elementId);
      if (element?.type !== "shape" || !Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error("EDITOR_SHAPE_POSITION_INPUT_INVALID");
      }
      // The fresh bridge binds this exact validated selection to expectedSource;
      // its queued guard and native conditional write remain authoritative.
      const bridge = createEditorDurableEditing({ workspace,
        revisionId: () => revisionId, createdAt: () => createdAt });
      if (!bridge.ok) throw new Error("EDITOR_SHAPE_POSITION_SOURCE_UNAVAILABLE");
      const commandId = captured.commandId();
      const revisionId = captured.revisionId();
      const createdAt = captured.createdAt();
      const result = await bridge.editing.dispatch({ commandSchemaVersion: 1,
        commandId, documentId, expectedRevision: 0, actorCapability: "human-ui",
        payload: { type: "set-shape-position", elementId, x, y },
      });
      if (!result.ok) throw new Error(`EDITOR_SHAPE_POSITION_${result.error.code}`);
    },
    createAgent: (): EditorBrowserAgentWorkspaceResult => {
      const current = workspace.current;
      if (current === null || current.revision.documentId !== captured.documentId) {
        return { ok: false, error: { code: "EDITOR_DURABLE_EDITING_INIT_FAILED" } };
      }
      return createEditorBrowserAgentWorkspace({
        workspace, revisionId: captured.revisionId, createdAt: captured.createdAt,
        commandElementIdSource: captured.elementIdSource,
      });
    },
  });
}
