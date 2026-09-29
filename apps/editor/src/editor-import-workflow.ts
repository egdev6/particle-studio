import type {
  EditorImportRequest, EditorImportWorkflow,
} from "./editor-import-controls.js";
import type { DurableDraftWorkspace } from "./durable-draft-workspace.js";

/**
 * Narrow publish-only view of the writable durable draft workspace: the import
 * workflow consumes only the serial-queue `publish` and never touches reload,
 * release authority, or the current getter.
 */
export type EditorImportPublishPort = Pick<DurableDraftWorkspace, "publish">;

/** Image-import variant of the editor import request, forwarded unchanged. */
export type EditorImportImageRequest = Extract<
  EditorImportRequest,
  { readonly kind: "image-import" }
>;

export interface EditorImportWorkflowDependencies {
  /** Writable durable workspace whose existing `publish` performs the JSON import. */
  readonly workspace: EditorImportPublishPort;
  /** Required image route; image-import requests are forwarded to it unchanged. */
  readonly imageWorkflow: (request: EditorImportImageRequest) => Promise<unknown>;
  /** Caller-owned identity inputs; the sequence callback is invoked once per JSON attempt. */
  readonly documentId: string;
  readonly revisionId: () => string;
  readonly sequence: () => number;
  readonly createdAt: () => number;
}

/**
 * Stateless editor import workflow: an editable-JSON request awaits the
 * workspace's existing `publish` with the injected document identity and
 * resolves void (no release authority), while an image-import request is
 * forwarded unchanged to the image workflow with its result and rejection
 * propagated. Being async, synchronous failures surface as rejected promises.
 */
export function createEditorImportWorkflow(
  dependencies: EditorImportWorkflowDependencies,
): EditorImportWorkflow {
  return async (request: EditorImportRequest): Promise<unknown> => {
    if (request.kind === "image-import") {
      return dependencies.imageWorkflow(request);
    }
    await dependencies.workspace.publish({
      documentId: dependencies.documentId,
      editableJson: request.editableJson,
      revisionId: dependencies.revisionId,
      sequence: dependencies.sequence(),
      createdAt: dependencies.createdAt,
    });
  };
}
