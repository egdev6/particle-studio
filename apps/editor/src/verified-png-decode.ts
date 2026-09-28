import {
  DurablePngIntegrityError,
  type VerifiedDurablePngAsset,
} from "./durable-png-import.js";

export interface VerifiedDecodedPngAsset extends VerifiedDurablePngAsset {
  readonly width: number;
  readonly height: number;
  readonly handle: unknown;
}

export interface PngDecodePrimitive {
  decodePng(bytes: Uint8Array): Promise<unknown> | unknown;
}

class VerifiedDecodedPng implements VerifiedDecodedPngAsset {
  readonly #bytes: Uint8Array;

  constructor(
    readonly sha256: string,
    readonly mimeType: "image/png",
    readonly byteLength: number,
    bytes: Uint8Array,
    readonly width: number,
    readonly height: number,
    readonly handle: unknown,
  ) {
    this.#bytes = bytes.slice();
    Object.freeze(this);
  }

  get bytes(): Uint8Array {
    return this.#bytes.slice();
  }
}

type DecodedPngObservation =
  | { readonly kind: "invalid" }
  | {
      readonly kind: "decoded";
      readonly width: number;
      readonly height: number;
      readonly handle: unknown;
    };

function isPositiveFiniteDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function observeDecodedPng(value: unknown): DecodedPngObservation {
  if (value === null || typeof value !== "object") {
    return { kind: "invalid" };
  }

  try {
    const decoded = value as {
      readonly width: unknown;
      readonly height: unknown;
      readonly handle: unknown;
    };
    const width = decoded.width;
    const height = decoded.height;
    const handle = decoded.handle;
    if (
      !isPositiveFiniteDimension(width) ||
      !isPositiveFiniteDimension(height) ||
      handle === null ||
      handle === undefined
    ) {
      return { kind: "invalid" };
    }

    return { kind: "decoded", width, height, handle };
  } catch {
    return { kind: "invalid" };
  }
}

function decodeFailure(): never {
  throw new DurablePngIntegrityError("EDITOR_PNG_DECODE_FAILED");
}

/** Decode isolated verified bytes through an injected primitive. */
export async function decodeVerifiedPngAsset(
  asset: VerifiedDurablePngAsset,
  dependencies: PngDecodePrimitive,
): Promise<VerifiedDecodedPngAsset> {
  const sha256 = asset.sha256;
  const mimeType = asset.mimeType;
  const byteLength = asset.byteLength;
  const verifiedBytes = asset.bytes.slice();
  let decoded: unknown;
  try {
    decoded = await dependencies.decodePng(verifiedBytes.slice());
  } catch {
    decodeFailure();
  }

  const observation = observeDecodedPng(decoded);
  if (observation.kind === "invalid") decodeFailure();

  return new VerifiedDecodedPng(
    sha256,
    mimeType,
    byteLength,
    verifiedBytes,
    observation.width,
    observation.height,
    observation.handle,
  );
}
