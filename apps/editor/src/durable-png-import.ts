export interface DurablePngAssetPort {
  writeAsset(input: {
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<unknown>;
  readAsset(sha256: string): Promise<unknown>;
}

export type Sha256 = (bytes: Uint8Array) => Promise<string>;

export type DurablePngIntegrityErrorCode =
  | "EDITOR_PNG_MIME_TYPE_INVALID"
  | "EDITOR_PNG_ASSET_UNAVAILABLE"
  | "EDITOR_PNG_PERSISTENCE_WRITE_FAILED"
  | "EDITOR_PNG_PERSISTENCE_READ_FAILED"
  | "EDITOR_PNG_ASSET_VERIFICATION_FAILED"
  | "EDITOR_PNG_DECODE_FAILED";

export class DurablePngIntegrityError extends Error {
  constructor(readonly code: DurablePngIntegrityErrorCode) {
    super(code);
    this.name = "DurablePngIntegrityError";
  }
}

export interface VerifiedDurablePngAsset {
  readonly sha256: string;
  readonly mimeType: "image/png";
  readonly byteLength: number;
  readonly bytes: Uint8Array;
}

const PNG_MIME_TYPE = "image/png";

type AssetRecord = {
  readonly sha256: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly bytes: Uint8Array;
};

type AssetRecordObservation =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "record"; readonly record: AssetRecord };

class VerifiedPngAsset implements VerifiedDurablePngAsset {
  readonly #bytes: Uint8Array;

  constructor(
    readonly sha256: string,
    readonly mimeType: "image/png",
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

function observeAssetRecord(value: unknown): AssetRecordObservation {
  if (value === null || value === undefined) return { kind: "missing" };
  if (typeof value !== "object") return { kind: "invalid" };

  try {
    const record = value as AssetRecord;
    const sha256 = record.sha256;
    const mimeType = record.mimeType;
    const byteLength = record.byteLength;
    const bytes = record.bytes;
    if (
      typeof sha256 !== "string" ||
      typeof mimeType !== "string" ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      !(bytes instanceof Uint8Array)
    ) {
      return { kind: "invalid" };
    }

    return {
      kind: "record",
      record: {
        sha256,
        mimeType,
        byteLength,
        bytes: Uint8Array.prototype.slice.call(bytes),
      },
    };
  } catch {
    return { kind: "invalid" };
  }
}

function observedPersistenceCode(cause: unknown): string | undefined {
  if (
    cause === null ||
    (typeof cause !== "object" && typeof cause !== "function")
  ) {
    return undefined;
  }

  try {
    const code = (cause as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

function persistenceFailure(
  code:
    | "EDITOR_PNG_PERSISTENCE_WRITE_FAILED"
    | "EDITOR_PNG_PERSISTENCE_READ_FAILED",
  cause: unknown,
): DurablePngIntegrityError {
  const observedCode = observedPersistenceCode(cause);
  return new DurablePngIntegrityError(
    observedCode === code ? observedCode : code,
  );
}

function verificationFailure(): never {
  throw new DurablePngIntegrityError("EDITOR_PNG_ASSET_VERIFICATION_FAILED");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function unavailableAsset(): never {
  throw new DurablePngIntegrityError("EDITOR_PNG_ASSET_UNAVAILABLE");
}

/**
 * Writes a caller-supplied PNG through the content-addressed asset port, then
 * verifies the durable record against isolated input bytes before returning it.
 */
export async function importDurablePngAsset(
  input: { readonly mimeType: string; readonly bytes: Uint8Array },
  dependencies: {
    readonly assets: DurablePngAssetPort;
    readonly sha256: Sha256;
  },
): Promise<VerifiedDurablePngAsset> {
  if (input.mimeType !== PNG_MIME_TYPE) {
    throw new DurablePngIntegrityError("EDITOR_PNG_MIME_TYPE_INVALID");
  }

  const acceptedBytes = input.bytes.slice();
  let written: unknown;
  try {
    written = await dependencies.assets.writeAsset({
      mimeType: PNG_MIME_TYPE,
      bytes: acceptedBytes.slice(),
    });
  } catch (cause) {
    throw persistenceFailure("EDITOR_PNG_PERSISTENCE_WRITE_FAILED", cause);
  }
  const writtenObservation = observeAssetRecord(written);
  if (writtenObservation.kind === "missing") unavailableAsset();
  if (writtenObservation.kind === "invalid") verificationFailure();
  const writtenRecord = writtenObservation.record;

  let reread: unknown;
  try {
    reread = await dependencies.assets.readAsset(writtenRecord.sha256);
  } catch (cause) {
    throw persistenceFailure("EDITOR_PNG_PERSISTENCE_READ_FAILED", cause);
  }
  const rereadObservation = observeAssetRecord(reread);
  if (rereadObservation.kind === "missing") unavailableAsset();
  if (rereadObservation.kind === "invalid") verificationFailure();
  const rereadRecord = rereadObservation.record;

  const writtenBytes = writtenRecord.bytes;
  const rereadBytes = rereadRecord.bytes;
  let acceptedSha256: string;
  let rereadSha256: string;
  try {
    acceptedSha256 = await dependencies.sha256(acceptedBytes.slice());
    rereadSha256 = await dependencies.sha256(rereadBytes.slice());
  } catch {
    throw new DurablePngIntegrityError("EDITOR_PNG_ASSET_VERIFICATION_FAILED");
  }

  if (
    writtenRecord.sha256 !== acceptedSha256 ||
    rereadRecord.sha256 !== acceptedSha256 ||
    rereadSha256 !== acceptedSha256 ||
    writtenRecord.mimeType !== PNG_MIME_TYPE ||
    rereadRecord.mimeType !== PNG_MIME_TYPE ||
    writtenRecord.byteLength !== acceptedBytes.byteLength ||
    rereadRecord.byteLength !== acceptedBytes.byteLength ||
    !sameBytes(writtenBytes, acceptedBytes) ||
    !sameBytes(rereadBytes, acceptedBytes)
  ) {
    throw new DurablePngIntegrityError("EDITOR_PNG_ASSET_VERIFICATION_FAILED");
  }

  return new VerifiedPngAsset(
    acceptedSha256,
    PNG_MIME_TYPE,
    acceptedBytes.byteLength,
    rereadBytes,
  );
}
