import {
  publishImmutableFile,
  publishReplaceablePointer,
  type PreparedCreateTarget,
  type PreparedReplaceableTarget,
  type RootConfinement,
  type ResolvedPath,
} from "./index.js";
import {
  setAtomicPublicationTestConfiguration,
  type AtomicPublicationOperations,
  type AtomicPublicationTestConfiguration,
} from "./atomic-publication.js";

export type { AtomicPublicationOperations };

/** Test-only relative-import seam; it is deliberately absent from package exports. */
export function createAtomicPublicationTestOperations(
  configuration: AtomicPublicationTestConfiguration & {
    readonly finalPathForImmutable?: () => string;
  },
): {
  readonly publishImmutableFile: (
    authority: RootConfinement,
    prepared: PreparedCreateTarget,
    bytes: unknown,
  ) => Promise<ResolvedPath>;
  readonly publishReplaceablePointer: (
    authority: RootConfinement,
    prepared: PreparedReplaceableTarget,
    bytes: unknown,
  ) => Promise<ResolvedPath>;
} {
  setAtomicPublicationTestConfiguration(configuration);
  return { publishImmutableFile, publishReplaceablePointer };
}
