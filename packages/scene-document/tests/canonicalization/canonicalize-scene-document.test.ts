import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());
import {
  APPROVAL_ENVELOPE_IDENTIFIER,
  APPROVAL_HASH_IDENTIFIER,
  APPROVAL_POLICY_IDENTIFIER,
  CANONICALIZATION_IDENTIFIER,
  FIRST_SLICE_CANONICAL_HEX,
  FIRST_SLICE_CANONICAL_SHA256,
  FIRST_SLICE_DOCUMENT,
  canonicalizeSceneDocument,
  createApprovalEnvelope,
  readCanonicalApprovalEvidence,
  validateCanonicalApprovalEnvelope,
  validateSceneDocument,
} from "@particle-studio/scene-document";

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

describe("SceneDocument JCS canonicalization", () => {
  it("produces the reviewed jcs-1 UTF-8 bytes and SHA-256", () => {
    const canonical = canonicalizeSceneDocument(FIRST_SLICE_DOCUMENT);

    expect(CANONICALIZATION_IDENTIFIER).toBe("jcs-1");
    expect(canonical.identifier).toBe("jcs-1");
    expect(toHex(canonical.bytes)).toBe(FIRST_SLICE_CANONICAL_HEX);
    expect(sha256(canonical.bytes)).toBe(FIRST_SLICE_CANONICAL_SHA256);
  });

  it("orders nested object keys, preserves arrays, and is byte-identical after reload", () => {
    const first = canonicalizeSceneDocument(FIRST_SLICE_DOCUMENT);
    const canonicalJson = new TextDecoder().decode(first.bytes);
    const reloaded = JSON.parse(canonicalJson);
    const validated = validateSceneDocument(reloaded);

    expect(canonicalJson).toContain(
      '"elements":[{"height":80,"id":"shape-1","opacity":1',
    );
    expect(canonicalJson).toContain(
      '"keyframes":[{"timeUs":0,"value":0.25},{"timeUs":1000000,"value":0.75}]',
    );
    expect(validated).toEqual({ ok: true, value: reloaded });
    expect(toHex(canonicalizeSceneDocument(reloaded).bytes)).toBe(
      FIRST_SLICE_CANONICAL_HEX,
    );
  });

  it("requires S1.2b validation before canonicalization", () => {
    const invalid = {
      ...FIRST_SLICE_DOCUMENT,
      elements: [{ ...FIRST_SLICE_DOCUMENT.elements[0], opacity: Infinity }],
    };

    expect(() => canonicalizeSceneDocument(invalid)).toThrow(
      "SCENE_DOCUMENT_CANONICALIZATION_INVALID",
    );
  });

  it("creates a structured, versioned JCS approval envelope and hashes all its bytes", async () => {
    const approved = await createApprovalEnvelope({
      document: FIRST_SLICE_DOCUMENT,
      runtimeVersion: "runtime-v1",
      verifiedAssetManifest: [
        {
          sha256: `sha256:${"b".repeat(64)}`,
          mimeType: "image/jpeg",
          byteLength: 42,
        },
        {
          sha256: `sha256:${"a".repeat(64)}`,
          mimeType: "image/png",
          byteLength: 7,
        },
        {
          sha256: `sha256:${"a".repeat(64)}`,
          mimeType: "image/png",
          byteLength: 7,
        },
      ],
    });

    expect(APPROVAL_ENVELOPE_IDENTIFIER).toBe("approval-envelope-v1");
    expect(APPROVAL_POLICY_IDENTIFIER).toBe("approval-policy-v1");
    expect(APPROVAL_HASH_IDENTIFIER).toBe("sha256");
    expect(approved.envelope).toMatchObject({
      identifier: "approval-envelope-v1",
      policyIdentifier: "approval-policy-v1",
      canonicalizationIdentifier: "jcs-1",
      hashIdentifier: "sha256",
      schemaVersion: 1,
      runtimeVersion: "runtime-v1",
      document: FIRST_SLICE_DOCUMENT,
      verifiedAssetManifest: [
        { sha256: `sha256:${"a".repeat(64)}` },
        { sha256: `sha256:${"b".repeat(64)}` },
      ],
    });
    expect(
      JSON.parse(new TextDecoder().decode(approved.bytes)).document,
    ).toEqual(FIRST_SLICE_DOCUMENT);
    expect(sha256(approved.bytes)).toBe(approved.snapshotHash.slice(7));
  });

  it("is deterministic across manifest order and defends its document, manifest, and bytes", async () => {
    const document = JSON.parse(JSON.stringify(FIRST_SLICE_DOCUMENT));
    const manifest = [
      {
        sha256: `sha256:${"b".repeat(64)}`,
        mimeType: "image/jpeg",
        byteLength: 42,
      },
      {
        sha256: `sha256:${"a".repeat(64)}`,
        mimeType: "image/png",
        byteLength: 7,
      },
    ];
    const first = await createApprovalEnvelope({
      document,
      runtimeVersion: "runtime-v1",
      verifiedAssetManifest: manifest,
    });
    const second = await createApprovalEnvelope({
      document: FIRST_SLICE_DOCUMENT,
      runtimeVersion: "runtime-v1",
      verifiedAssetManifest: [...manifest].reverse(),
    });
    const originalBytes = first.bytes;

    document.elements[0].opacity = 0;
    manifest[0].mimeType = "image/webp";
    first.bytes.fill(0);

    expect(first.snapshotHash).toBe(second.snapshotHash);
    expect(first.bytes).toEqual(originalBytes);
    expect(first.envelope.document).toEqual(FIRST_SLICE_DOCUMENT);
    expect(first.envelope.verifiedAssetManifest).toEqual([
      {
        sha256: `sha256:${"a".repeat(64)}`,
        mimeType: "image/png",
        byteLength: 7,
      },
      {
        sha256: `sha256:${"b".repeat(64)}`,
        mimeType: "image/jpeg",
        byteLength: 42,
      },
    ]);
  });

  it("reads immutable private canonical approval evidence without reentering public authority getters", async () => {
    const approved = await createApprovalEnvelope({
      document: FIRST_SLICE_DOCUMENT,
      runtimeVersion: "runtime-v1",
      verifiedAssetManifest: [
        {
          sha256: `sha256:${"a".repeat(64)}`,
          mimeType: "image/png",
          byteLength: 7,
        },
      ],
    });
    const expectedDocumentBytes =
      canonicalizeSceneDocument(FIRST_SLICE_DOCUMENT).bytes;
    const first = readCanonicalApprovalEvidence(approved);

    expect(first.snapshotHash).toBe(approved.snapshotHash);
    expect(first.runtimeVersion).toBe("runtime-v1");
    expect(first.approvalEnvelopeBytes).toEqual(approved.bytes);
    expect(first.canonicalDocumentBytes).toEqual(expectedDocumentBytes);
    expect(first.verifiedAssetManifest).toEqual([
      {
        sha256: `sha256:${"a".repeat(64)}`,
        mimeType: "image/png",
        byteLength: 7,
      },
    ]);
    expect(Object.isFrozen(first.verifiedAssetManifest)).toBe(true);
    expect(Object.isFrozen(first.verifiedAssetManifest[0])).toBe(true);

    first.approvalEnvelopeBytes.fill(0);
    first.canonicalDocumentBytes.fill(0);
    Reflect.set(first.verifiedAssetManifest[0], "mimeType", "image/webp");
    const second = readCanonicalApprovalEvidence(approved);

    expect(second.approvalEnvelopeBytes).toEqual(approved.bytes);
    expect(second.canonicalDocumentBytes).toEqual(expectedDocumentBytes);
    expect(second.verifiedAssetManifest).toEqual([
      {
        sha256: `sha256:${"a".repeat(64)}`,
        mimeType: "image/png",
        byteLength: 7,
      },
    ]);

    let getterCalls = 0;
    const copied = {
      snapshotHash: approved.snapshotHash,
      approvalEnvelopeBytes: approved.bytes,
      canonicalDocumentBytes: expectedDocumentBytes,
      verifiedAssetManifest: approved.envelope.verifiedAssetManifest,
    };
    const hostile = Object.defineProperty({}, "bytes", {
      get() {
        getterCalls += 1;
        throw new Error("must not observe hostile evidence getter");
      },
    });
    const inheritedHostile = Object.create(
      Object.defineProperty({}, "envelope", {
        get() {
          getterCalls += 1;
          throw new Error("must not observe inherited evidence getter");
        },
      }),
    );

    for (const forged of [copied, hostile, inheritedHostile]) {
      expect(() => readCanonicalApprovalEvidence(forged)).toThrow(
        "APPROVAL_ENVELOPE_INPUT_INVALID",
      );
    }
    expect(getterCalls).toBe(0);

    const originals = {
      arrayMap: Array.prototype.map,
      arrayForEach: Array.prototype.forEach,
      arrayIterator: Array.prototype[Symbol.iterator],
      typedArraySlice: Uint8Array.prototype.slice,
      typedArraySet: Uint8Array.prototype.set,
      weakMapGet: WeakMap.prototype.get,
      weakMapSet: WeakMap.prototype.set,
      reflectApply: Reflect.apply,
      objectFreeze: Object.freeze,
    };
    let poisonedEvidence: ReturnType<typeof readCanonicalApprovalEvidence>;
    try {
      Array.prototype.map = () => {
        throw new Error("poisoned map");
      };
      Array.prototype.forEach = () => {
        throw new Error("poisoned forEach");
      };
      Array.prototype[Symbol.iterator] = () => {
        throw new Error("poisoned iterator");
      };
      Uint8Array.prototype.slice = () => {
        throw new Error("poisoned typed-array slice");
      };
      Uint8Array.prototype.set = () => {
        throw new Error("poisoned typed-array set");
      };
      WeakMap.prototype.get = () => {
        throw new Error("poisoned weak-map get");
      };
      WeakMap.prototype.set = () => {
        throw new Error("poisoned weak-map set");
      };
      Reflect.apply = () => {
        throw new Error("poisoned reflect apply");
      };
      Object.freeze = () => {
        throw new Error("poisoned freeze");
      };
      poisonedEvidence = readCanonicalApprovalEvidence(approved);
    } finally {
      Array.prototype.map = originals.arrayMap;
      Array.prototype.forEach = originals.arrayForEach;
      Array.prototype[Symbol.iterator] = originals.arrayIterator;
      Uint8Array.prototype.slice = originals.typedArraySlice;
      Uint8Array.prototype.set = originals.typedArraySet;
      WeakMap.prototype.get = originals.weakMapGet;
      WeakMap.prototype.set = originals.weakMapSet;
      Reflect.apply = originals.reflectApply;
      Object.freeze = originals.objectFreeze;
    }

    expect(poisonedEvidence!.snapshotHash).toBe(approved.snapshotHash);
    expect(poisonedEvidence!.runtimeVersion).toBe("runtime-v1");
    expect(poisonedEvidence!.approvalEnvelopeBytes).toEqual(approved.bytes);
    expect(poisonedEvidence!.canonicalDocumentBytes).toEqual(
      expectedDocumentBytes,
    );
    expect(poisonedEvidence!.verifiedAssetManifest).toEqual(
      second.verifiedAssetManifest,
    );
  });

  it("reads genuine private evidence when public envelope getters become hostile", async () => {
    const approved = await createApprovalEnvelope({
      document: FIRST_SLICE_DOCUMENT,
      runtimeVersion: "runtime-v2",
      verifiedAssetManifest: [],
    });
    const prototype = Object.getPrototypeOf(approved);
    const descriptors = {
      bytes: Object.getOwnPropertyDescriptor(prototype, "bytes")!,
      envelope: Object.getOwnPropertyDescriptor(prototype, "envelope")!,
    };
    let getterCalls = 0;

    try {
      Object.defineProperty(prototype, "bytes", {
        configurable: true,
        get() {
          getterCalls += 1;
          throw new Error("must not read public bytes");
        },
      });
      Object.defineProperty(prototype, "envelope", {
        configurable: true,
        get() {
          getterCalls += 1;
          throw new Error("must not read public envelope");
        },
      });

      const evidence = readCanonicalApprovalEvidence(approved);
      expect(evidence.snapshotHash).toBe(approved.snapshotHash);
      expect(evidence.runtimeVersion).toBe("runtime-v2");
      expect(evidence.canonicalDocumentBytes).toEqual(
        canonicalizeSceneDocument(FIRST_SLICE_DOCUMENT).bytes,
      );
      expect(evidence.verifiedAssetManifest).toEqual([]);
    } finally {
      Object.defineProperty(prototype, "bytes", descriptors.bytes);
      Object.defineProperty(prototype, "envelope", descriptors.envelope);
    }

    expect(getterCalls).toBe(0);
  });

  it("accepts only the genuine canonical approval authority without observing hostile inputs", async () => {
    const genuine = await createApprovalEnvelope({
      document: FIRST_SLICE_DOCUMENT,
      runtimeVersion: "runtime-v1",
      verifiedAssetManifest: [],
    });
    const copied = {
      envelope: genuine.envelope,
      bytes: genuine.bytes,
      snapshotHash: genuine.snapshotHash,
    };
    const prototypeForgery = Object.create(Object.getPrototypeOf(genuine));
    let ownGetterCalls = 0;
    const ownGetterForgery = Object.defineProperty({}, "bytes", {
      get() {
        ownGetterCalls += 1;
        throw new Error("must not observe own getter");
      },
    });
    let inheritedGetterCalls = 0;
    const inheritedGetterForgery = Object.create(
      Object.defineProperty({}, "envelope", {
        get() {
          inheritedGetterCalls += 1;
          throw new Error("must not observe inherited getter");
        },
      }),
    );

    expect(validateCanonicalApprovalEnvelope(genuine)).toBe(genuine);
    for (const forged of [
      null,
      1,
      "approval",
      copied,
      prototypeForgery,
      ownGetterForgery,
      inheritedGetterForgery,
    ]) {
      expect(() => validateCanonicalApprovalEnvelope(forged)).toThrow(
        "APPROVAL_ENVELOPE_INPUT_INVALID",
      );
    }
    expect(ownGetterCalls).toBe(0);
    expect(inheritedGetterCalls).toBe(0);

    const originals = {
      weakSetAdd: WeakSet.prototype.add,
      weakSetHas: WeakSet.prototype.has,
      reflectApply: Reflect.apply,
      functionBind: Function.prototype.bind,
      functionCall: Function.prototype.call,
    };
    let poisonedGenuine: unknown;
    let poisonedForgery: unknown;
    try {
      WeakSet.prototype.add = () => {
        throw new Error("poisoned add");
      };
      WeakSet.prototype.has = () => true;
      Reflect.apply = () => true as never;
      Function.prototype.bind = () => {
        throw new Error("poisoned bind");
      };
      Function.prototype.call = () => {
        throw new Error("poisoned call");
      };
      poisonedGenuine = validateCanonicalApprovalEnvelope(genuine);
      try {
        validateCanonicalApprovalEnvelope(copied);
      } catch (error) {
        poisonedForgery = error;
      }
    } finally {
      WeakSet.prototype.add = originals.weakSetAdd;
      WeakSet.prototype.has = originals.weakSetHas;
      Reflect.apply = originals.reflectApply;
      Function.prototype.bind = originals.functionBind;
      Function.prototype.call = originals.functionCall;
    }
    expect(poisonedGenuine).toBe(genuine);
    expect(poisonedForgery).toEqual(
      expect.objectContaining({ message: "APPROVAL_ENVELOPE_INPUT_INVALID" }),
    );
  });

  it("rejects a callable forgery without observing its hostile properties", () => {
    let getterCalls = 0;
    const callableForgery = Object.defineProperty(() => undefined, "bytes", {
      get() {
        getterCalls += 1;
        throw new Error("must not observe callable getter");
      },
    });

    expect(() => validateCanonicalApprovalEnvelope(callableForgery)).toThrow(
      "APPROVAL_ENVELOPE_INPUT_INVALID",
    );
    expect(getterCalls).toBe(0);
  });

  it("preserves a non-empty manifest when Array iteration is poisoned after import", async () => {
    const manifest = [
      {
        sha256: `sha256:${"c".repeat(64)}`,
        mimeType: "image/png",
        byteLength: 9,
      },
    ];
    const originalIterator = Array.prototype[Symbol.iterator];
    let approved: Awaited<ReturnType<typeof createApprovalEnvelope>>;

    try {
      Array.prototype[Symbol.iterator] = function (this: unknown[]) {
        if (this === manifest) {
          return { next: () => ({ done: true, value: undefined }) };
        }
        return originalIterator.call(this);
      } as unknown as (typeof Array.prototype)[typeof Symbol.iterator];
      approved = await createApprovalEnvelope({
        document: FIRST_SLICE_DOCUMENT,
        runtimeVersion: "runtime-v1",
        verifiedAssetManifest: manifest,
      });
    } finally {
      Array.prototype[Symbol.iterator] = originalIterator;
    }

    expect(approved!.envelope.verifiedAssetManifest).toEqual(manifest);
  });

  it("rejects invalid manifest entries and conflicting metadata for one hash", async () => {
    const valid = {
      document: FIRST_SLICE_DOCUMENT,
      runtimeVersion: "runtime-v1",
      verifiedAssetManifest: [
        {
          sha256: `sha256:${"a".repeat(64)}`,
          mimeType: "image/png",
          byteLength: 7,
        },
      ],
    };
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    digest.mockResolvedValue(new ArrayBuffer(32));
    vi.spyOn(globalThis, "structuredClone").mockReturnValue(undefined as never);
    vi.spyOn(Number, "isSafeInteger").mockReturnValue(true);
    const approved = await createApprovalEnvelope(valid);
    expect(approved.snapshotHash).toBe(`sha256:${sha256(approved.bytes)}`);
    valid.verifiedAssetManifest[0].byteLength = Number.MAX_VALUE;
    await expect(createApprovalEnvelope(valid)).rejects.toThrow(
      "APPROVAL_ENVELOPE_ASSET_MANIFEST_INVALID",
    );
    valid.verifiedAssetManifest[0].byteLength = 7;

    await expect(
      createApprovalEnvelope({
        ...valid,
        verifiedAssetManifest: [
          {
            sha256: `sha256:${"A".repeat(64)}`,
            mimeType: "image/png",
            byteLength: 7,
          },
        ],
      }),
    ).rejects.toThrow("APPROVAL_ENVELOPE_ASSET_MANIFEST_INVALID");
    await expect(
      createApprovalEnvelope({
        ...valid,
        verifiedAssetManifest: [
          ...valid.verifiedAssetManifest,
          {
            sha256: `sha256:${"a".repeat(64)}`,
            mimeType: "image/jpeg",
            byteLength: 7,
          },
        ],
      }),
    ).rejects.toThrow("APPROVAL_ENVELOPE_ASSET_MANIFEST_CONFLICT");
  });
});
