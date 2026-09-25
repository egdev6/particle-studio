/**
 * Public subpath entry for the filesystem revision persistence adapter. It
 * exposes only the factory, the stable adapter error class, and the record
 * size limits, plus type-only re-exports of the domain port. Implementation
 * internals and the test seam stay in internal modules.
 */
export {
  MAX_POINTER_RECORD_BYTES,
  MAX_REVISION_RECORD_BYTES,
  FileSystemPersistenceError,
  createFileSystemPersistenceAdapter,
} from "./revision-adapter.js";
export type {
  FileSystemPersistenceAdapterOptions,
  FileSystemPersistenceErrorCode,
} from "./revision-adapter.js";
export type {
  CompleteSceneRevision,
  DraftRevisionPointer,
  PersistenceAdapterPort,
  RevisionPointersSnapshot,
  SavedRevisionPointer,
} from "@particle-studio/persistence";
