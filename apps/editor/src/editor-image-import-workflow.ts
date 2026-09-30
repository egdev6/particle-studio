import {
  createCommandSession,
  type CommandSession,
  type ElementIdSource,
  type ElementIdSourceResult,
} from "@particle-studio/commands";
import { canonicalizeSceneDocument } from "@particle-studio/scene-document";
import {
  importDurablePngAsset,
  type DurablePngAssetPort,
  type Sha256,
} from "./durable-png-import.js";
import {
  decodeVerifiedPngAsset,
  type PngDecodePrimitive,
} from "./verified-png-decode.js";
import type { PngImageCache } from "./png-image-cache.js";
import type { DurableDraftWorkspace } from "./durable-draft-workspace.js";
import type { EditorImportImageRequest } from "./editor-import-workflow.js";

/** Caller-declared placement of the imported image element; there are no UI defaults. */
export interface EditorImageImportGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly opacity: number;
}

export type EditorImageImportErrorCode =
  | "EDITOR_IMAGE_IMPORT_SOURCE_UNAVAILABLE"
  | "EDITOR_IMAGE_IMPORT_FILE_READ_FAILED"
  | "EDITOR_IMAGE_IMPORT_CACHE_ADOPTION_FAILED"
  | "EDITOR_IMAGE_IMPORT_SERIALIZATION_FAILED";

export class EditorImageImportError extends Error {
  constructor(readonly code: EditorImageImportErrorCode) {
    super(code);
    this.name = "EditorImageImportError";
  }
}

/** Narrow cache surface: the image route only ever stages or disposes candidates. */
export type EditorImageImportCachePort = Pick<
  PngImageCache,
  "adoptStaged" | "disposeCandidate"
>;

export interface EditorImageImportWorkflowDependencies {
  /** Durable workspace supplying the live source publication and the serial-queue publish. */
  readonly workspace: DurableDraftWorkspace;
  readonly assets: DurablePngAssetPort;
  readonly sha256: Sha256;
  readonly decodePng: PngDecodePrimitive["decodePng"];
  readonly cache: EditorImageImportCachePort;
  readonly elementIdSource: ElementIdSource;
  readonly commandId: () => string;
  readonly geometry: () => EditorImageImportGeometry;
  readonly revisionId: () => string;
  readonly sequence: () => number;
  readonly createdAt: () => number;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Local-only, user-initiated image import. The composition is strictly:
 * `importDurablePngAsset` + `decodeVerifiedPngAsset` via injected dependencies,
 * then a TEMP `adoptStaged` lease released in `finally` (a null adoption routes
 * through `disposeCandidate` only — the cache alone closes unowned handles).
 * The source document, identity, geometry, command id, sequence, element id,
 * publication revision, and creation time are all snapshotted synchronously
 * BEFORE `file.arrayBuffer()` or any PNG await, so caller mutations during
 * the gated async can never retarget the import, and a missing current
 * rejects before any import work. The element id result is copied behind a
 * constant thunk so caller-owned mutations cannot change the chosen id.
 * An unavailable id still rejects in the command session; a throwing id source
 * fails before any file read or asset import.
 *
 * The element is appended by
 * the existing command session's `create-element` command, serialized through
 * the canonical exporter, and published with the source bound as
 * `expectedSource` — the workspace's stable source-mismatch rejection is
 * propagated unchanged. Durable assets may remain when the import fails; the
 * JSON workflow is untouched.
 */
export function createEditorImageImportWorkflow(
  dependencies: EditorImageImportWorkflowDependencies,
): (request: EditorImportImageRequest) => Promise<void> {
  return async (request: EditorImportImageRequest): Promise<void> => {
    let snapshot: {
      arrayBuffer: () => Promise<ArrayBuffer>;
      mimeType: string;
      session: CommandSession;
      sourceDocumentId: string;
      sourceRevisionId: string;
      geometry: EditorImageImportGeometry;
      commandId: string;
      sequence: number;
      assets: DurablePngAssetPort;
      sha256: Sha256;
      decodePng: PngDecodePrimitive["decodePng"];
      adoptStaged: EditorImageImportCachePort["adoptStaged"];
      disposeCandidate: EditorImageImportCachePort["disposeCandidate"];
      publish: DurableDraftWorkspace["publish"];
      revisionId: string;
      createdAt: number;
    };
    try {
      const file = request.file;
      const current = dependencies.workspace.current;
      if (current === null) {
        throw new EditorImageImportError(
          "EDITOR_IMAGE_IMPORT_SOURCE_UNAVAILABLE",
        );
      }
      const sourceDocumentId = current.revision.documentId;
      const cache = dependencies.cache;
      const workspace = dependencies.workspace;
      // Command and publication callbacks invoke these sources later.
      // Capture before PNG awaits so caller mutations cannot retarget the
      // element id, publication revision, or creation time.
      const requestedId = dependencies.elementIdSource();
      const elementIdResult: ElementIdSourceResult = requestedId.kind === "id"
        ? { kind: "id", id: requestedId.id }
        : { kind: "unavailable" };
      const revisionId = dependencies.revisionId();
      const createdAt = dependencies.createdAt();
      snapshot = {
        mimeType: file.type,
        arrayBuffer: file.arrayBuffer.bind(file),
        session: createCommandSession(
          sourceDocumentId,
          current.revision.document,
          () => elementIdResult,
        ),
        sourceDocumentId,
        sourceRevisionId: current.revision.revisionId,
        geometry: { ...dependencies.geometry() },
        commandId: dependencies.commandId(),
        sequence: dependencies.sequence(),
        assets: dependencies.assets,
        sha256: dependencies.sha256,
        decodePng: dependencies.decodePng,
        adoptStaged: cache.adoptStaged.bind(cache),
        disposeCandidate: cache.disposeCandidate.bind(cache),
        publish: workspace.publish.bind(workspace),
        revisionId,
        createdAt,
      };
    } catch (error) {
      return Promise.reject(error);
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await snapshot.arrayBuffer());
    } catch {
      throw new EditorImageImportError("EDITOR_IMAGE_IMPORT_FILE_READ_FAILED");
    }
    const verified = await importDurablePngAsset(
      { mimeType: snapshot.mimeType, bytes },
      { assets: snapshot.assets, sha256: snapshot.sha256 },
    );
    const decoded = await decodeVerifiedPngAsset(verified, {
      decodePng: snapshot.decodePng,
    });
    const candidate = Object.freeze({
      sha256: verified.sha256,
      mimeType: verified.mimeType,
      byteLength: verified.byteLength,
      width: decoded.width,
      height: decoded.height,
      handle: decoded.handle,
    });
    // TEMP lease: staging ownership is held only for this import; the
    // publication's prehydration stages its own lease. A null adoption means
    // the cache refused the candidate — disposal is the cache's decision.
    const lease = snapshot.adoptStaged(candidate);
    if (lease === null) {
      snapshot.disposeCandidate(candidate);
      throw new EditorImageImportError(
        "EDITOR_IMAGE_IMPORT_CACHE_ADOPTION_FAILED",
      );
    }
    try {
      const result = snapshot.session.dispatch({
        commandSchemaVersion: 1,
        commandId: snapshot.commandId,
        documentId: snapshot.sourceDocumentId,
        expectedRevision: 0,
        actorCapability: "human-ui",
        payload: {
          type: "create-element",
          element: {
            type: "image",
            asset: {
              sha256: verified.sha256,
              mimeType: "image/png",
              byteLength: verified.byteLength,
              intrinsicWidth: decoded.width,
              intrinsicHeight: decoded.height,
            },
            x: snapshot.geometry.x,
            y: snapshot.geometry.y,
            width: snapshot.geometry.width,
            height: snapshot.geometry.height,
            opacity: snapshot.geometry.opacity,
          },
        },
      });
      if (!result.ok) throw new Error(result.error.code);
      let editableJson: string;
      try {
        editableJson = utf8.decode(
          canonicalizeSceneDocument.exportEditableJson(result.document),
        );
      } catch {
        throw new EditorImageImportError(
          "EDITOR_IMAGE_IMPORT_SERIALIZATION_FAILED",
        );
      }
      await snapshot.publish({
        documentId: snapshot.sourceDocumentId,
        editableJson,
        revisionId: () => snapshot.revisionId,
        sequence: snapshot.sequence,
        createdAt: () => snapshot.createdAt,
        expectedSource: {
          documentId: snapshot.sourceDocumentId,
          revisionId: snapshot.sourceRevisionId,
        },
      });
    } finally {
      lease.release();
    }
  };
}
