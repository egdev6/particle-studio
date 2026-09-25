/**
 * Public subpath entry for the filesystem asset persistence adapter. It
 * exposes only the factory, the stable adapter error class, and the asset
 * size limits, plus type-only re-exports of the domain asset port. The
 * package root stays free of asset code; implementation internals and the
 * test seam stay in internal modules.
 */
export {
  MAX_ASSET_BYTES,
  MAX_ASSET_RECORD_BYTES,
  FileSystemAssetPersistenceError,
  createFileSystemAssetPersistenceAdapter,
} from "./asset-adapter.js";
export type {
  FileSystemAssetPersistenceAdapterOptions,
  FileSystemAssetPersistenceErrorCode,
} from "./asset-adapter.js";
export type {
  AssetPersistencePort,
  ContentAddressedAsset,
} from "@particle-studio/persistence";
