/**
 * Public entry for the headless draft workspace. It exposes only the
 * result-only workspace factory, its port types, and the startup error type.
 * The test seam stays in the relative test-only module.
 */
export {
  createHeadlessDraftWorkspace,
  HeadlessWorkspaceError,
  type HeadlessCommandErrorCode,
  type HeadlessDraftSummary,
  type HeadlessDraftSummaryResult,
  type HeadlessDraftWorkspace,
  type HeadlessDraftWorkspaceOptions,
  type HeadlessMutationResult,
  type HeadlessWorkspaceErrorCode,
} from "./headless-draft-workspace.js";
