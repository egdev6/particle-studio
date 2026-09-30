import type { ElementIdSource } from "@particle-studio/commands";
import {
  createDurableCommandBridge, type DurableCommandBridge,
} from "./durable-command-bridge.js";
import type { DurableDraftWorkspace } from "./durable-draft-workspace.js";

export interface EditorDurableEditingOptions {
  readonly workspace: DurableDraftWorkspace;
  readonly revisionId: () => string;
  readonly createdAt: () => number;
  readonly commandElementIdSource?: ElementIdSource;
}

export type EditorDurableEditingResult =
  | { readonly ok: true; readonly editing: DurableCommandBridge }
  | { readonly ok: false; readonly error: { readonly code: "EDITOR_DURABLE_EDITING_INIT_FAILED" } };

/**
 * Starts synchronously from a live publication; never reloads or owns release.
 * Missing/unsuitable initial state fails with the bounded init result. Editing
 * keeps its own source binding: external publication makes it stale, not rebased.
 * Command revisions start at zero, independently of durable IDs and sequences.
 */
export function createEditorDurableEditing(
  options: EditorDurableEditingOptions,
): EditorDurableEditingResult {
  try {
    const workspace = options.workspace;
    const initial = workspace.current;
    if (initial === null) throw new Error();
    const { documentId, revisionId: sourceRevisionId, sequence } = initial.revision;
    const publish = workspace.publish.bind(workspace);
    const revisionId = options.revisionId;
    const createdAt = options.createdAt;
    const idSource = options.commandElementIdSource;
    if (
      typeof documentId !== "string" || documentId.length === 0 ||
      typeof sourceRevisionId !== "string" || sourceRevisionId.length === 0 ||
      !Number.isSafeInteger(sequence) || sequence < 0 ||
      typeof revisionId !== "function" || typeof createdAt !== "function" ||
      (idSource !== undefined && typeof idSource !== "function")
    ) throw new Error();

    let source = { documentId, revisionId: sourceRevisionId, sequence };
    const editing = createDurableCommandBridge({
      documentId,
      document: initial.revision.document,
      idSource,
      publish: async (candidate): Promise<void> => {
        const publication = await publish({
          documentId: source.documentId,
          editableJson: JSON.stringify(candidate),
          revisionId,
          sequence: source.sequence + 1,
          createdAt,
          expectedSource: { documentId: source.documentId, revisionId: source.revisionId },
        });
        // Only the successful returned publication advances the private binding.
        // Discard its facade to preserve the bridge's void-success contract.
        const next = publication.revision;
        source = { documentId: next.documentId, revisionId: next.revisionId, sequence: next.sequence };
      },
    });
    return { ok: true, editing };
  } catch {
    return { ok: false, error: { code: "EDITOR_DURABLE_EDITING_INIT_FAILED" } };
  }
}
