import {
  setAssetPersistenceTestConfiguration,
  type AssetPersistenceTestConfiguration,
} from "./asset-adapter.js";

export type { AssetPersistenceTestConfiguration };

/** Test-only relative-import seam; it is deliberately absent from package exports. */
export function createAssetPersistenceTestOperations(
  configuration: AssetPersistenceTestConfiguration | undefined,
): void {
  setAssetPersistenceTestConfiguration(configuration);
}
