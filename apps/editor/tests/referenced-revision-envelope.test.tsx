import { describe, expect, it, vi } from "vitest";
import { FIRST_SLICE_DOCUMENT } from "@particle-studio/scene-document";
import { createCompleteRevision } from "@particle-studio/persistence";
import { readReferencedRevisionEnvelope } from "../src/referenced-revision-envelope.js";

const identity = Object.freeze({ kind: "draft" as const, documentId: "doc", revisionId: "rev", sequence: 3 });
const record = () => ({ documentId: "doc", revisionId: "rev", sequence: 3,
  document: { nested: { value: 1 } }, canonicalization: { identifier: "jcs-1", byteLength: 2 },
  canonicalBytes: new Uint8Array([1, 2]) });
const failure = "EDITOR_REFERENCED_REVISION_RELOAD_FAILED";
const port = (value: unknown) => ({ readRevision: vi.fn(async () => value) });

describe("referenced revision envelope", () => {
  it("accepts a genuine persistence revision and defensively copies its data", async () => {
    const stored = createCompleteRevision({ documentId: "doc", revisionId: "rev", sequence: 3,
      document: FIRST_SLICE_DOCUMENT });
    const dependency = port(stored);
    const result = await readReferencedRevisionEnvelope(identity, dependency);
    expect(result.document).toEqual(FIRST_SLICE_DOCUMENT);
    expect(Array.from(result.canonicalBytes)).toEqual(Array.from(stored.canonicalBytes));
    const original = result.canonicalBytes[0];
    result.canonicalBytes[0] = 255;
    expect(result.canonicalBytes[0]).toBe(original);
    expect(Object.isFrozen(result.document)).toBe(true);
    expect(dependency.readRevision).toHaveBeenCalledOnce();
  });

  it("does not invoke mutable persistence prototype getters for an issued revision", async () => {
    const stored = createCompleteRevision({ documentId: "doc", revisionId: "rev", sequence: 3,
      document: FIRST_SLICE_DOCUMENT });
    const prototype = Object.getPrototypeOf(stored) as object;
    const documentDescriptor = Object.getOwnPropertyDescriptor(prototype, "document")!;
    const bytesDescriptor = Object.getOwnPropertyDescriptor(prototype, "canonicalBytes")!;
    const getter = vi.fn(() => { throw Error("hostile prototype getter"); });
    try {
      Object.defineProperty(prototype, "document", { ...documentDescriptor, get: getter });
      Object.defineProperty(prototype, "canonicalBytes", { ...bytesDescriptor, get: getter });
      const result = await readReferencedRevisionEnvelope(identity, port(stored));
      expect(result.document).toEqual(FIRST_SLICE_DOCUMENT);
      expect(result.canonicalBytes.byteLength).toBeGreaterThan(0);
      expect(getter).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(prototype, "document", documentDescriptor);
      Object.defineProperty(prototype, "canonicalBytes", bytesDescriptor);
    }
  });

  it("ignores replacement of the reachable static snapshot method", async () => {
    const stored = createCompleteRevision({ documentId: "doc", revisionId: "rev", sequence: 3,
      document: FIRST_SLICE_DOCUMENT });
    const constructor = stored.constructor as typeof stored.constructor & { snapshot: (...args: unknown[]) => unknown };
    const original = constructor.snapshot;
    const replacement = vi.fn(() => { throw Error("hostile static method"); });
    try {
      constructor.snapshot = replacement;
      const result = await readReferencedRevisionEnvelope(identity, port(stored));
      expect(result.document).toEqual(FIRST_SLICE_DOCUMENT);
      expect(replacement).not.toHaveBeenCalled();
    } finally {
      constructor.snapshot = original;
    }
  });

  it("rejects forged persistence prototypes and proxies", async () => {
    const stored = createCompleteRevision({ documentId: "doc", revisionId: "rev", sequence: 3,
      document: FIRST_SLICE_DOCUMENT });
    for (const forged of [Object.create(Object.getPrototypeOf(stored)), new Proxy(stored, {})]) {
      const dependency = port(forged);
      await expect(readReferencedRevisionEnvelope(identity, dependency)).rejects.toThrow(failure);
      expect(dependency.readRevision).toHaveBeenCalledOnce();
    }
  });
  it("captures receiver and method, reads once, and isolates frozen structure and bytes", async () => {
    let resolve!: (value: unknown) => void;
    const dependency = { readRevision: vi.fn(function (this: unknown, doc: string, rev: string) {
      expect(this).toBe(dependency);
      expect([doc, rev]).toEqual(["doc", "rev"]);
      return new Promise<unknown>((done) => { resolve = done; });
    }) };
    const pending = readReferencedRevisionEnvelope(identity, dependency);
    dependency.readRevision = vi.fn(async () => { throw Error("replaced"); });
    const input = record();
    resolve(input);
    const result = await pending;
    input.document.nested.value = 9;
    input.canonicalBytes[0] = 9;
    result.canonicalBytes[0] = 8;
    expect(result.document).toEqual({ nested: { value: 1 } });
    expect(result.canonicalBytes).toEqual(new Uint8Array([1, 2]));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen((result.document as { nested: object }).nested)).toBe(true);
    expect(Object.isFrozen(result.canonicalization)).toBe(true);
    expect(dependency.readRevision).not.toHaveBeenCalled();
    const subclass = new (class extends Uint8Array { static get [Symbol.species]() { throw Error("secret"); } })([1, 2]);
    expect((await readReferencedRevisionEnvelope(identity, port({ ...record(), canonicalBytes: subclass })))
      .canonicalBytes).toEqual(new Uint8Array([1, 2]));
  });

  it.each([null, {}, { ...record(), documentId: "other" },
    { ...record(), revisionId: "other" }, { ...record(), sequence: 4 },
    { ...record(), canonicalization: { identifier: "other", byteLength: 2 } },
    { ...record(), canonicalization: { identifier: "jcs-1", byteLength: 1 } },
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN].map((byteLength) =>
      ({ ...record(), canonicalization: { identifier: "jcs-1", byteLength } })),
    { ...record(), document: { nested: Object.defineProperty({}, "value", {
      get() { throw Error("secret nested getter"); },
    }) } },
    { ...record(), canonicalBytes: new Proxy(new Uint8Array([1, 2]), {}) },
    { ...record(), canonicalBytes: new Uint16Array([1, 2]) },
    { ...record(), canonicalBytes: Object.setPrototypeOf(new Uint16Array([1, 2]), Uint8Array.prototype) },
    { ...record(), canonicalBytes: Object.setPrototypeOf({ 0: 1, 1: 2 }, Uint8Array.prototype) },
    Object.defineProperty(record(), "canonicalBytes", { get() { throw Error("secret"); } }),
    { ...record(), canonicalBytes: { 0: 1, 1: 2, length: 2 } },
    Object.create(record()),
    Object.defineProperty(record(), "document", { get() { throw Error("secret"); } }),
    new Proxy(record(), { getOwnPropertyDescriptor() { throw Error("secret"); } }),
  ])("rejects incomplete, mismatched, or hostile records with one public error", async (value) => {
    const dependency = port(value);
    await expect(readReferencedRevisionEnvelope(identity, dependency)).rejects.toThrow(failure);
    expect(dependency.readRevision).toHaveBeenCalledOnce();
  });

  it("maps a rejected read to a fresh public error without leaking its cause", async () => {
    const secret = Error("secret rejection");
    const dependency = { readRevision: vi.fn(async () => { throw secret; }) };
    try {
      await readReferencedRevisionEnvelope(identity, dependency);
      throw Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(failure);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
      expect(error).not.toBe(secret);
    }
    expect(dependency.readRevision).toHaveBeenCalledExactlyOnceWith("doc", "rev");
  });

  it.each([null, {}, { readRevision: 42 },
    Object.defineProperty({}, "readRevision", { get() { throw Error("secret port getter"); } }),
  ])("rejects an absent or invalid port before invocation", async (dependency) => {
    await expect(readReferencedRevisionEnvelope(identity, dependency as never)).rejects.toThrow(failure);
  });

  it("does not invoke a nested document accessor", async () => {
    const getter = vi.fn(() => 1);
    const dependency = port({ ...record(), document: { nested: Object.defineProperty({}, "value", { get: getter }) } });
    await expect(readReferencedRevisionEnvelope(identity, dependency)).rejects.toThrow(failure);
    expect(getter).not.toHaveBeenCalled();
  });
});
