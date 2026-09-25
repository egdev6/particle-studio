import {
  setHeadlessWorkspaceTestConfiguration,
  type HeadlessWorkspaceTestConfiguration,
} from "./headless-draft-workspace.js";

export type { HeadlessWorkspaceTestConfiguration };

/** Test-only relative-import seam; it is deliberately absent from package exports. */
export function configureHeadlessWorkspaceTestOperations(
  configuration: HeadlessWorkspaceTestConfiguration | undefined,
): void {
  setHeadlessWorkspaceTestConfiguration(configuration);
}
