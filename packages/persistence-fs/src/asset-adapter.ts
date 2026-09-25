import { createHash } from "node:crypto";
import { isUint8Array } from "node:util/types";
import type { AssetPersistencePort, ContentAddressedAsset } from "@particle-studio/persistence";
import {
  prepareCreateTarget,
  publishImmutableFile,
  RootConfinementError,
  type RootConfinement,
} from "./index.js";
import { hasRootConfinementAuthority } from "./confinement-contracts.js";
import {
  ensureConfinementDirectory,
  inspectConfinementFile,
  type ConfinementFileSnapshot,
} from "./confinement-file.js";
import { domainSegment, privateRootDirectory } from "./confinement-layout.js";

export const MAX_ASSET_BYTES = 16 * 1024 * 1024;
export const MAX_ASSET_RECORD_BYTES = 24 * 1024 * 1024;

export type FileSystemAssetPersistenceErrorCode =
  | "PERSISTENCE_FS_AUTHORITY_INVALID"
  | "PERSISTENCE_FS_ASSET_MIME_TYPE_INVALID"
  | "PERSISTENCE_FS_ASSET_BYTES_INVALID"
  | "PERSISTENCE_FS_ASSET_ADDRESS_INVALID"
  | "PERSISTENCE_FS_ASSET_BYTES_OVERSIZE"
  | "PERSISTENCE_FS_ASSET_RECORD_OVERSIZE"
  | "PERSISTENCE_FS_ASSET_RECORD_MISSING"
  | "PERSISTENCE_FS_ASSET_RECORD_MALFORMED"
  | "PERSISTENCE_FS_ASSET_RECORD_CORRUPT"
  | "PERSISTENCE_FS_ASSET_RECORD_HASH_MISMATCH"
  | "PERSISTENCE_FS_ASSET_MIME_TYPE_CONFLICT"
  | "PERSISTENCE_FS_ASSET_RECORD_COLLISION"
  | "PERSISTENCE_FS_ASSET_RECORD_SYMLINK"
  | "PERSISTENCE_FS_ASSET_RECORD_UNAVAILABLE"
  | "PERSISTENCE_FS_ASSET_PUBLICATION_FAILED"
  | "PERSISTENCE_FS_ASSET_PUBLICATION_DURABILITY_UNCERTAIN";

export class FileSystemAssetPersistenceError extends Error {
  readonly name = "FileSystemAssetPersistenceError";

  constructor(readonly code: FileSystemAssetPersistenceErrorCode) {
    super(code);
  }
}

export interface FileSystemAssetPersistenceAdapterOptions {
  readonly authority: RootConfinement;
}

export interface AssetPersistenceTestConfiguration {
  readonly observe?: (event: string) => void;
}

let testConfiguration: AssetPersistenceTestConfiguration | undefined;

/** This is intentionally reachable only through a relative test-only module. */
export function setAssetPersistenceTestConfiguration(
  configuration: AssetPersistenceTestConfiguration | undefined,
): void {
  testConfiguration = configuration;
}

const assetsDirectoryName = "assets";
const assetAddressPattern = /^sha256:[a-f0-9]{64}$/;
const assetRecordVersion = 1;
const canonicalBase64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function fsError(code: FileSystemAssetPersistenceErrorCode): FileSystemAssetPersistenceError {
  return new FileSystemAssetPersistenceError(code);
}

function observe(event: string): void {
  testConfiguration?.observe?.(event);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function assetDirectorySegmentFor(address: string): string {
  return domainSegment("asset-directory", [address]);
}

function assetFileSegmentFor(address: string): string {
  return domainSegment("asset-file", [address]);
}

function assetRecordRelativePath(address: string): string {
  return `${privateRootDirectory}/${assetsDirectoryName}/${assetDirectorySegmentFor(address)}/${assetFileSegmentFor(address)}.json`;
}

/**
 * Deterministic canonical record serialization. The exact key sequence is part
 * of the record contract: a stored record round-trips byte-identically if and
 * only if every stored byte matches this regenerated canonical form.
 */
function assetRecordText(mimeType: string, byteLength: number, dataBase64: string): string {
  return JSON.stringify({
    assetVersion: assetRecordVersion,
    mimeType,
    byteLength,
    dataBase64,
  });
}

interface VerifiedAssetRecord {
  readonly mimeType: string;
  readonly byteLength: number;
  readonly bytes: Uint8Array;
}

/**
 * Verify a stored record against its content address: exact shape, canonical
 * JSON encoding, canonical padded base64, declared byte length, and SHA-256
 * identity. Every mismatch has its own stable code and never mutates storage.
 */
function parseAssetRecord(raw: Uint8Array, address: string): VerifiedAssetRecord {
  let text: string;
  try {
    text = textDecoder.decode(raw);
  } catch {
    throw fsError("PERSISTENCE_FS_ASSET_RECORD_MALFORMED");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw fsError("PERSISTENCE_FS_ASSET_RECORD_MALFORMED");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw fsError("PERSISTENCE_FS_ASSET_RECORD_MALFORMED");
  }
  // Compare the key set as an unordered JSON object shape. Key order is
  // canonical-encoding territory, enforced below by the byte-level
  // regeneration check rather than by the shape check.
  const keys = Object.keys(value);
  const expectedKeys = ["assetVersion", "mimeType", "byteLength", "dataBase64"];
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !keys.includes(key))
  ) {
    throw fsError("PERSISTENCE_FS_ASSET_RECORD_MALFORMED");
  }
  const record = value as Record<string, unknown>;
  if (record["assetVersion"] !== assetRecordVersion) {
    throw fsError("PERSISTENCE_FS_ASSET_RECORD_MALFORMED");
  }
  if (!validIdentifier(record["mimeType"]) || typeof record["byteLength"] !== "number") {
    throw fsError("PERSISTENCE_FS_ASSET_RECORD_MALFORMED");
  }
  if (
    !Number.isSafeInteger(record["byteLength"]) ||
    (record["byteLength"] as number) < 0 ||
    typeof record["dataBase64"] !== "string"
  ) {
    throw fsError("PERSISTENCE_FS_ASSET_RECORD_MALFORMED");
  }
  const mimeType = record["mimeType"] as string;
  const byteLength = record["byteLength"] as number;
  const dataBase64 = record["dataBase64"] as string;

  const regenerated = textEncoder.encode(assetRecordText(mimeType, byteLength, dataBase64));
  if (!sameBytes(regenerated, raw)) {
    throw fsError("PERSISTENCE_FS_ASSET_RECORD_CORRUPT");
  }
  if (!canonicalBase64Pattern.test(dataBase64) || dataBase64.length % 4 !== 0) {
    throw fsError("PERSISTENCE_FS_ASSET_RECORD_CORRUPT");
  }
  const decoded = Buffer.from(dataBase64, "base64");
  if (decoded.toString("base64") !== dataBase64) {
    throw fsError("PERSISTENCE_FS_ASSET_RECORD_CORRUPT");
  }
  if (decoded.byteLength !== byteLength) {
    throw fsError("PERSISTENCE_FS_ASSET_RECORD_CORRUPT");
  }
  const digest = createHash("sha256").update(decoded).digest("hex");
  if (`sha256:${digest}` !== address) {
    throw fsError("PERSISTENCE_FS_ASSET_RECORD_HASH_MISMATCH");
  }
  return { mimeType, byteLength, bytes: new Uint8Array(decoded) };
}

/**
 * Read and verify the record stored at the given address, or return null when
 * the record is absent. Symlinked, oversized, and non-regular entries fail
 * explicitly and are never read through or overwritten.
 */
async function readStoredAssetRecord(
  authority: RootConfinement,
  address: string,
): Promise<VerifiedAssetRecord | null> {
  const snapshot: ConfinementFileSnapshot = await inspectConfinementFile(
    authority,
    { role: "workspace", path: assetRecordRelativePath(address) },
    MAX_ASSET_RECORD_BYTES,
  );
  switch (snapshot.kind) {
    case "absent":
      return null;
    case "regular":
      return parseAssetRecord(snapshot.bytes, address);
    case "symlink":
      throw fsError("PERSISTENCE_FS_ASSET_RECORD_SYMLINK");
    case "oversize":
      throw fsError("PERSISTENCE_FS_ASSET_RECORD_OVERSIZE");
    default:
      throw fsError("PERSISTENCE_FS_ASSET_RECORD_UNAVAILABLE");
  }
}

class StoredFileSystemAsset implements ContentAddressedAsset {
  readonly #bytes: Uint8Array;

  constructor(
    readonly sha256: string,
    readonly mimeType: string,
    readonly byteLength: number,
    bytes: Uint8Array,
  ) {
    this.#bytes = bytes.slice();
    Object.freeze(this);
  }

  get bytes(): Uint8Array {
    return this.#bytes.slice();
  }
}

/**
 * Map every publication-phase failure into the stable adapter error surface.
 * Already-surface adapter errors pass through unchanged so record-level codes
 * keep their meaning; the durability-uncertain confinement result keeps its
 * durability distinction; every other confinement or injected failure maps to
 * the asset publication-failed code.
 */
function mapPublicationFailure(error: unknown): never {
  if (error instanceof FileSystemAssetPersistenceError) throw error;
  if (
    error instanceof RootConfinementError &&
    error.code === "PERSISTENCE_FS_PUBLICATION_DURABILITY_UNCERTAIN"
  ) {
    throw fsError("PERSISTENCE_FS_ASSET_PUBLICATION_DURABILITY_UNCERTAIN");
  }
  throw fsError("PERSISTENCE_FS_ASSET_PUBLICATION_FAILED");
}

export function createFileSystemAssetPersistenceAdapter(
  options: FileSystemAssetPersistenceAdapterOptions,
): AssetPersistencePort {
  const authority =
    options === null || typeof options !== "object" ? undefined : options.authority;
  if (!hasRootConfinementAuthority(authority)) {
    throw fsError("PERSISTENCE_FS_AUTHORITY_INVALID");
  }
  const confinement = authority as RootConfinement;

  async function writeAsset(input: {
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<ContentAddressedAsset> {
    // Validate every input and prebuild the entire record before any
    // filesystem access, so rejected writes provision nothing.
    if (!validIdentifier(input?.mimeType)) {
      throw fsError("PERSISTENCE_FS_ASSET_MIME_TYPE_INVALID");
    }
    if (!isUint8Array(input?.bytes)) {
      throw fsError("PERSISTENCE_FS_ASSET_BYTES_INVALID");
    }
    const owned = new Uint8Array(input.bytes);
    if (owned.byteLength > MAX_ASSET_BYTES) {
      throw fsError("PERSISTENCE_FS_ASSET_BYTES_OVERSIZE");
    }
    const address = `sha256:${createHash("sha256").update(owned).digest("hex")}`;
    const recordBytes = textEncoder.encode(
      assetRecordText(input.mimeType, owned.byteLength, Buffer.from(owned).toString("base64")),
    );
    if (recordBytes.byteLength > MAX_ASSET_RECORD_BYTES) {
      throw fsError("PERSISTENCE_FS_ASSET_RECORD_OVERSIZE");
    }

    try {
      // Inspect before mutating anything: a byte-identical stored record with
      // the same MIME type is reused without provisioning or rewriting; a
      // conflicting, corrupt, or otherwise unreadable record fails explicitly
      // with no filesystem mutation.
      const existing = await readStoredAssetRecord(confinement, address);
      if (existing !== null) {
        if (existing.mimeType !== input.mimeType) {
          throw fsError("PERSISTENCE_FS_ASSET_MIME_TYPE_CONFLICT");
        }
        observe("asset-record-reused");
        return new StoredFileSystemAsset(
          address,
          existing.mimeType,
          existing.byteLength,
          existing.bytes,
        );
      }

      await ensureConfinementDirectory(confinement, {
        role: "workspace",
        path: privateRootDirectory,
      });
      observe("ensure-directory:private-root");
      await ensureConfinementDirectory(confinement, {
        role: "workspace",
        path: `${privateRootDirectory}/${assetsDirectoryName}`,
      });
      observe("ensure-directory:assets");
      await ensureConfinementDirectory(confinement, {
        role: "workspace",
        path: `${privateRootDirectory}/${assetsDirectoryName}/${assetDirectorySegmentFor(address)}`,
      });
      observe("ensure-directory:assets/asset-directory");
      const prepared = await prepareCreateTarget(confinement, {
        role: "workspace",
        path: assetRecordRelativePath(address),
      });
      await publishImmutableFile(confinement, prepared, recordBytes);
      observe("asset-record-published");
      return new StoredFileSystemAsset(address, input.mimeType, owned.byteLength, owned);
    } catch (error: unknown) {
      if (
        error instanceof RootConfinementError &&
        error.code === "PERSISTENCE_FS_PUBLICATION_ALREADY_EXISTS"
      ) {
        // Already-exists race: a concurrent writer published a record at this
        // address between the absence check and the hard link. Re-read the
        // winner; a byte-identical record with the same MIME type is reused,
        // and any other stored content is a collision that is never
        // overwritten.
        let raced: VerifiedAssetRecord | null = null;
        try {
          raced = await readStoredAssetRecord(confinement, address);
        } catch {
          raced = null;
        }
        if (
          raced !== null &&
          raced.mimeType === input.mimeType &&
          sameBytes(raced.bytes, owned)
        ) {
          observe("asset-record-reused");
          return new StoredFileSystemAsset(
            address,
            raced.mimeType,
            raced.byteLength,
            raced.bytes,
          );
        }
        throw fsError("PERSISTENCE_FS_ASSET_RECORD_COLLISION");
      }
      throw mapPublicationFailure(error);
    }
  }

  async function readAsset(sha256: string): Promise<ContentAddressedAsset> {
    // Validate the address before any filesystem access: only the exact
    // content-address form reaches the deterministic workspace path.
    if (typeof sha256 !== "string" || !assetAddressPattern.test(sha256)) {
      throw fsError("PERSISTENCE_FS_ASSET_ADDRESS_INVALID");
    }
    const record = await readStoredAssetRecord(confinement, sha256);
    if (record === null) {
      throw fsError("PERSISTENCE_FS_ASSET_RECORD_MISSING");
    }
    return new StoredFileSystemAsset(sha256, record.mimeType, record.byteLength, record.bytes);
  }

  return { writeAsset, readAsset };
}
