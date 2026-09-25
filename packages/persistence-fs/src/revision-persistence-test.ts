import {
  setRevisionPersistenceTestConfiguration,
  type RevisionPersistenceTestConfiguration,
} from "./revision-adapter.js";

export type { RevisionPersistenceTestConfiguration };

/** Test-only relative-import seam; it is deliberately absent from package exports. */
export function createRevisionPersistenceTestOperations(
  configuration: RevisionPersistenceTestConfiguration | undefined,
): void {
  setRevisionPersistenceTestConfiguration(configuration);
}
