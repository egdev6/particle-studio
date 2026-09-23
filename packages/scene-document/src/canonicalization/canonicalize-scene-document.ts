import { canonicalize } from "json-canonicalize";

import { validateSceneDocument } from "../validation/validate-scene-document.js";

export const CANONICALIZATION_IDENTIFIER = "jcs-1" as const;

// SAFETY: Node 24 and supported browsers expose the standard TextEncoder API.
const utf8Encoder = new (
  globalThis as unknown as {
    TextEncoder: new () => { encode(value: string): Uint8Array };
  }
).TextEncoder();
// SAFETY: Node 24 and supported browsers expose the standard TextDecoder API.
const utf8Decoder = new (
  globalThis as unknown as {
    TextDecoder: new () => { decode(value: Uint8Array): string };
  }
).TextDecoder();
// SAFETY: Node 24 and supported browsers expose standard structured cloning.
const structuredClone = (
  globalThis as unknown as { structuredClone: <Value>(value: Value) => Value }
).structuredClone;
const isSafeInteger = Number.isSafeInteger;

export interface CanonicalSceneDocument {
  readonly identifier: typeof CANONICALIZATION_IDENTIFIER;
  readonly bytes: Uint8Array;
}

export const APPROVAL_ENVELOPE_IDENTIFIER = "approval-envelope-v1" as const;
export const APPROVAL_POLICY_IDENTIFIER = "approval-policy-v1" as const;
export const APPROVAL_HASH_IDENTIFIER = "sha256" as const;

export interface VerifiedAssetManifestEntry {
  readonly sha256: string;
  readonly mimeType: string;
  readonly byteLength: number;
}

export interface ApprovalEnvelope {
  readonly identifier: typeof APPROVAL_ENVELOPE_IDENTIFIER;
  readonly policyIdentifier: typeof APPROVAL_POLICY_IDENTIFIER;
  readonly canonicalizationIdentifier: typeof CANONICALIZATION_IDENTIFIER;
  readonly hashIdentifier: typeof APPROVAL_HASH_IDENTIFIER;
  readonly schemaVersion: 1;
  readonly runtimeVersion: string;
  readonly document: object;
  readonly verifiedAssetManifest: readonly VerifiedAssetManifestEntry[];
}

export interface CanonicalApprovalEnvelope {
  readonly envelope: ApprovalEnvelope;
  readonly bytes: Uint8Array;
  readonly snapshotHash: string;
}

export interface ValidatedCanonicalApprovalEvidence {
  readonly snapshotHash: string;
  readonly runtimeVersion: string;
  readonly approvalEnvelopeBytes: Uint8Array;
  readonly canonicalDocumentBytes: Uint8Array;
  readonly verifiedAssetManifest: readonly VerifiedAssetManifestEntry[];
}

type StoredCanonicalApprovalEvidence = Omit<
  ValidatedCanonicalApprovalEvidence,
  "approvalEnvelopeBytes" | "canonicalDocumentBytes"
> & {
  readonly approvalEnvelopeBytes: Uint8Array;
  readonly canonicalDocumentBytes: Uint8Array;
};

const freezeObject = Object.freeze;
const reflectApply = Reflect.apply;
const typedArraySlice = Uint8Array.prototype.slice;
const copyUint8Array = (value: Uint8Array): Uint8Array =>
  reflectApply(typedArraySlice, value, []) as Uint8Array;
const canonicalApprovalEvidence = new WeakMap<
  object,
  StoredCanonicalApprovalEvidence
>();
const weakMapSet = WeakMap.prototype.set;
const weakMapGet = WeakMap.prototype.get;
const storeCanonicalApprovalEvidence = (
  key: CanonicalApprovalEnvelope,
  evidence: StoredCanonicalApprovalEvidence,
): void => {
  reflectApply(weakMapSet, canonicalApprovalEvidence, [key, evidence]);
};
const getCanonicalApprovalEvidence = (
  key: CanonicalApprovalEnvelope,
): StoredCanonicalApprovalEvidence | undefined =>
  reflectApply(weakMapGet, canonicalApprovalEvidence, [key]) as
    | StoredCanonicalApprovalEvidence
    | undefined;

const canonicalApprovalEnvelopeBrand = new WeakSet<object>();
const brandCanonicalApprovalEnvelope = WeakSet.prototype.add.bind(
  canonicalApprovalEnvelopeBrand,
);
const hasCanonicalApprovalEnvelopeBrand = WeakSet.prototype.has.bind(
  canonicalApprovalEnvelopeBrand,
);

export function validateCanonicalApprovalEnvelope(
  value: unknown,
): CanonicalApprovalEnvelope {
  if (
    value === null ||
    typeof value !== "object" ||
    !hasCanonicalApprovalEnvelopeBrand(value)
  ) {
    fail("APPROVAL_ENVELOPE_INPUT_INVALID");
  }
  return value as CanonicalApprovalEnvelope;
}

function copyVerifiedAssetManifest(
  manifest: readonly VerifiedAssetManifestEntry[],
): readonly VerifiedAssetManifestEntry[] {
  const copy: VerifiedAssetManifestEntry[] = [];
  let index = 0;
  while (index < manifest.length) {
    const entry = manifest[index];
    if (entry === undefined) fail("APPROVAL_ENVELOPE_INPUT_INVALID");
    copy[index] = freezeObject({
      sha256: entry.sha256,
      mimeType: entry.mimeType,
      byteLength: entry.byteLength,
    });
    index += 1;
  }
  return freezeObject(copy);
}

/**
 * Reads construction-time approval evidence without consulting public authority
 * accessors, so callers cannot alter or reconstruct the approved snapshot.
 */
export function readCanonicalApprovalEvidence(
  value: unknown,
): ValidatedCanonicalApprovalEvidence {
  const authority = validateCanonicalApprovalEnvelope(value);
  const evidence = getCanonicalApprovalEvidence(authority);
  if (evidence === undefined) fail("APPROVAL_ENVELOPE_INPUT_INVALID");
  return {
    snapshotHash: evidence.snapshotHash,
    runtimeVersion: evidence.runtimeVersion,
    approvalEnvelopeBytes: copyUint8Array(evidence.approvalEnvelopeBytes),
    canonicalDocumentBytes: copyUint8Array(evidence.canonicalDocumentBytes),
    verifiedAssetManifest: copyVerifiedAssetManifest(
      evidence.verifiedAssetManifest,
    ),
  };
}

function fail(code: string): never {
  throw new Error(code);
}

interface ApprovalEnvelopeInput {
  readonly document: unknown;
  readonly runtimeVersion: unknown;
  readonly verifiedAssetManifest: unknown;
}

function readApprovalInput(value: unknown): ApprovalEnvelopeInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("APPROVAL_ENVELOPE_INPUT_INVALID");
  }
  try {
    // SAFETY: the object guard above permits only property observation here.
    const input = value as Record<string, unknown>;
    return {
      document: input.document,
      runtimeVersion: input.runtimeVersion,
      verifiedAssetManifest: input.verifiedAssetManifest,
    };
  } catch {
    return fail("APPROVAL_ENVELOPE_INPUT_INVALID");
  }
}

function copyFrozen<T>(value: T): T {
  // SAFETY: these values are JSON-compatible after SceneDocument validation.
  const copy = structuredClone(value);
  const freeze = (candidate: unknown): void => {
    if (candidate !== null && typeof candidate === "object") {
      for (const child of Object.values(candidate)) freeze(child);
      Object.freeze(candidate);
    }
  };
  freeze(copy);
  return copy;
}

function validatedManifest(
  value: unknown,
): readonly VerifiedAssetManifestEntry[] {
  if (!Array.isArray(value)) fail("APPROVAL_ENVELOPE_ASSET_MANIFEST_INVALID");

  const entries = new Map<string, VerifiedAssetManifestEntry>();
  let index = 0;
  while (index < value.length) {
    const valueEntry = value[index];
    if (
      valueEntry === null ||
      typeof valueEntry !== "object" ||
      Array.isArray(valueEntry)
    ) {
      fail("APPROVAL_ENVELOPE_ASSET_MANIFEST_INVALID");
    }
    let sha256: unknown;
    let mimeType: unknown;
    let byteLength: unknown;
    try {
      // SAFETY: the object guard above permits only property observation here.
      const entry = valueEntry as Record<string, unknown>;
      sha256 = entry.sha256;
      mimeType = entry.mimeType;
      byteLength = entry.byteLength;
    } catch {
      fail("APPROVAL_ENVELOPE_ASSET_MANIFEST_INVALID");
    }
    if (
      typeof sha256 !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(sha256) ||
      typeof mimeType !== "string" ||
      mimeType.trim().length === 0 ||
      typeof byteLength !== "number" ||
      !isSafeInteger(byteLength) ||
      byteLength < 0
    ) {
      fail("APPROVAL_ENVELOPE_ASSET_MANIFEST_INVALID");
    }
    const entry = Object.freeze({ sha256, mimeType, byteLength });
    const prior = entries.get(sha256);
    if (
      prior !== undefined &&
      (prior.mimeType !== mimeType || prior.byteLength !== byteLength)
    ) {
      fail("APPROVAL_ENVELOPE_ASSET_MANIFEST_CONFLICT");
    }
    entries.set(sha256, entry);
    index += 1;
  }
  return Object.freeze(
    [...entries.values()].sort((left, right) =>
      left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0,
    ),
  );
}

const sha256 = (() => {
  // SAFETY: Node 24 and the supported browser baseline expose Web Crypto.
  const cryptoLike = globalThis as unknown as {
    readonly crypto: {
      readonly subtle: {
        digest(name: string, data: Uint8Array): Promise<ArrayBuffer>;
      };
    };
  };
  const digest = cryptoLike.crypto.subtle.digest.bind(cryptoLike.crypto.subtle);
  return async (bytes: Uint8Array): Promise<string> => {
    const hashBytes = await digest("SHA-256", bytes)
      .then((value) => new Uint8Array(value))
      .catch(() => fail("APPROVAL_ENVELOPE_HASH_INVALID"));
    if (hashBytes.byteLength !== 32) fail("APPROVAL_ENVELOPE_HASH_INVALID");
    return `sha256:${Array.from(hashBytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")}`;
  };
})();

class StoredApprovalEnvelope implements CanonicalApprovalEnvelope {
  readonly #bytes: Uint8Array;
  readonly #envelope: ApprovalEnvelope;
  readonly snapshotHash: string;

  constructor(
    envelope: ApprovalEnvelope,
    bytes: Uint8Array,
    snapshotHash: string,
    canonicalDocumentBytes: Uint8Array,
  ) {
    this.#envelope = copyFrozen(envelope);
    this.#bytes = copyUint8Array(bytes);
    this.snapshotHash = snapshotHash;
    storeCanonicalApprovalEvidence(this, {
      snapshotHash,
      runtimeVersion: envelope.runtimeVersion,
      approvalEnvelopeBytes: copyUint8Array(bytes),
      canonicalDocumentBytes: copyUint8Array(canonicalDocumentBytes),
      verifiedAssetManifest: copyVerifiedAssetManifest(
        envelope.verifiedAssetManifest,
      ),
    });
    brandCanonicalApprovalEnvelope(this);
    freezeObject(this);
  }

  get envelope(): ApprovalEnvelope {
    return copyFrozen(this.#envelope);
  }

  get bytes(): Uint8Array {
    return copyUint8Array(this.#bytes);
  }
}

export function canonicalizeSceneDocument(
  value: unknown,
): CanonicalSceneDocument {
  const validated = validateSceneDocument(value);
  if (!validated.ok) {
    throw new Error("SCENE_DOCUMENT_CANONICALIZATION_INVALID");
  }

  return {
    identifier: CANONICALIZATION_IDENTIFIER,
    bytes: utf8Encoder.encode(canonicalize(validated.value)),
  };
}

export async function createApprovalEnvelope(
  input: unknown,
): Promise<CanonicalApprovalEnvelope> {
  const approvalInput = readApprovalInput(input);
  const { document: documentInput, runtimeVersion } = approvalInput;
  if (
    typeof runtimeVersion !== "string" ||
    runtimeVersion.trim().length === 0
  ) {
    fail("APPROVAL_ENVELOPE_RUNTIME_VERSION_INVALID");
  }

  const canonicalDocument = canonicalizeSceneDocument(documentInput);
  let document: object;
  try {
    document = JSON.parse(
      utf8Decoder.decode(canonicalDocument.bytes),
    ) as object;
  } catch {
    fail("APPROVAL_ENVELOPE_DOCUMENT_INVALID");
  }
  const envelope: ApprovalEnvelope = {
    identifier: APPROVAL_ENVELOPE_IDENTIFIER,
    policyIdentifier: APPROVAL_POLICY_IDENTIFIER,
    canonicalizationIdentifier: CANONICALIZATION_IDENTIFIER,
    hashIdentifier: APPROVAL_HASH_IDENTIFIER,
    schemaVersion: 1,
    runtimeVersion,
    document,
    verifiedAssetManifest: validatedManifest(
      approvalInput.verifiedAssetManifest,
    ),
  };
  const bytes = utf8Encoder.encode(canonicalize(envelope));
  return new StoredApprovalEnvelope(
    envelope,
    bytes,
    await sha256(bytes),
    canonicalDocument.bytes,
  );
}
