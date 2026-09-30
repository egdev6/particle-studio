import type { BrowserAgentAdapter } from "@particle-studio/webmcp-adapter";
import { createBrowserAgentWorkspaceAdapter } from "./browser-agent-workspace-port.js";
import {
  createEditorDurableEditing, type EditorDurableEditingOptions,
} from "./editor-durable-editing.js";

export type EditorBrowserAgentWorkspaceResult =
  | { readonly ok: true; readonly adapter: BrowserAgentAdapter }
  | { readonly ok: false; readonly error: { readonly code: "EDITOR_DURABLE_EDITING_INIT_FAILED" } };

/**
 * Starts the existing five tools from one live publication, without reload,
 * registration or release authority. Summary describes the retained editing
 * session: command revision starts at zero, not the durable sequence or ID,
 * and external publication does not rebase it. Existing transport timeouts
 * remain response bounds, not cancellation or rollback of durable publication.
 */
export function createEditorBrowserAgentWorkspace(
  options: EditorDurableEditingOptions,
): EditorBrowserAgentWorkspaceResult {
  try {
    // Capture declared fields once, before observing live current; getter-backed
    // options must not supply different dependencies to identity and editing.
    const captured: EditorDurableEditingOptions = {
      workspace: options.workspace,
      revisionId: options.revisionId,
      createdAt: options.createdAt,
      commandElementIdSource: options.commandElementIdSource,
    };
    const initial = captured.workspace.current;
    if (initial === null) throw new Error();
    const result = createEditorDurableEditing(captured);
    // The real workspace is frozen with a pure getter; initialization is sync.
    // Fail closed if an unsuitable surface changed current in this same tick.
    if (!result.ok || captured.workspace.current !== initial) throw new Error();
    const editing = result.editing;
    const adapter = createBrowserAgentWorkspaceAdapter({
      documentId: initial.revision.documentId,
      snapshot: async () => editing.snapshot(),
      dispatch: async (command) => ({ result: await editing.dispatch(command) }),
      undo: async () => ({ result: await editing.undo() }),
      redo: async () => ({ result: await editing.redo() }),
    });
    return { ok: true, adapter };
  } catch {
    return { ok: false, error: { code: "EDITOR_DURABLE_EDITING_INIT_FAILED" } };
  }
}
