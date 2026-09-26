import {
  createBrowserAgentAdapter,
  type BrowserAgentAdapter,
  type BrowserAgentWorkspacePort,
} from "@particle-studio/webmcp-adapter";
import {
  validateSceneDocument,
  type SceneDocumentV1,
} from "@particle-studio/scene-document";

export type BrowserAgentWorkspaceCommandSurface = {
  readonly documentId: string;
  snapshot(): Promise<{
    readonly revision: number;
    readonly document: SceneDocumentV1;
  } | null>;
  dispatch(command: unknown): Promise<{ readonly result: unknown }>;
  undo(): Promise<{ readonly result: unknown }>;
  redo(): Promise<{ readonly result: unknown }>;
};

type DraftSummary = {
  readonly documentId: string;
  readonly revision: number;
  readonly schemaVersion: number;
  readonly durationUs: number;
  readonly playbackRange: { startUs: number; endUs: number };
  readonly loop: boolean;
  readonly elementCount: number;
  readonly trackCount: number;
};

type DraftSummaryResult =
  | { readonly ok: true; readonly summary: DraftSummary }
  | {
      readonly ok: false;
      readonly error: { readonly code: "DURABLE_COMMAND_UNAVAILABLE" };
    };

const unavailable = (): DraftSummaryResult => ({
  ok: false,
  error: { code: "DURABLE_COMMAND_UNAVAILABLE" },
});

/**
 * Narrows editor command composition to the read/validate/command operations
 * accepted by the browser-agent adapter. Durable workspace authority remains
 * outside this boundary.
 */
export function createBrowserAgentWorkspacePort(
  surface: BrowserAgentWorkspaceCommandSurface,
): BrowserAgentWorkspacePort {
  return {
    async getDraftSummary(): Promise<DraftSummaryResult> {
      const snapshot = await surface.snapshot();
      if (snapshot === null) return unavailable();

      const { document, revision } = snapshot;
      return {
        ok: true,
        summary: {
          documentId: surface.documentId,
          revision,
          schemaVersion: document.schemaVersion,
          durationUs: document.durationUs,
          playbackRange: {
            startUs: document.playbackRange.startUs,
            endUs: document.playbackRange.endUs,
          },
          loop: document.loop,
          elementCount: document.elements.length,
          trackCount: document.tracks.length,
        },
      };
    },
    validateDraft(document: unknown) {
      return validateSceneDocument(document);
    },
    async dispatch(command: unknown): Promise<unknown> {
      return (await surface.dispatch(command)).result;
    },
    async undo(): Promise<unknown> {
      return (await surface.undo()).result;
    },
    async redo(): Promise<unknown> {
      return (await surface.redo()).result;
    },
  };
}

/** Creates the complete, bounded browser-agent API without registering a host. */
export function createBrowserAgentWorkspaceAdapter(
  surface: BrowserAgentWorkspaceCommandSurface,
): BrowserAgentAdapter {
  return createBrowserAgentAdapter(createBrowserAgentWorkspacePort(surface));
}
