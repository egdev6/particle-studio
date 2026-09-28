import { CANONICALIZATION_IDENTIFIER } from "@particle-studio/scene-document";
import { snapshotIssuedCompleteRevision } from "@particle-studio/persistence";
import type { DurableDraftIdentity } from "./durable-draft-identity.js";

export interface RevisionReadPort {
  readRevision(documentId: string, revisionId: string): Promise<unknown>;
}

export interface ReferencedRevisionEnvelope {
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
  readonly document: unknown;
  readonly canonicalization: Readonly<{ identifier: typeof CANONICALIZATION_IDENTIFIER; byteLength: number }>;
  readonly canonicalBytes: Uint8Array;
}

const failure = () => new Error("EDITOR_REFERENCED_REVISION_RELOAD_FAILED");

function own<T = unknown>(value: unknown, key: string): T {
  if (value === null || typeof value !== "object") throw failure();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw failure();
  return descriptor.value as T;
}

function cloneFrozen<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value !== "object" || seen.has(value)) throw failure();
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw failure();
  seen.add(value);
  const copy: Record<string, unknown> | unknown[] = array ? [] : {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key === "__proto__") throw failure();
    if (array && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw failure();
    const child = cloneFrozen(descriptor.value as unknown, seen);
    Object.defineProperty(copy, key, { value: child, enumerable: descriptor.enumerable, writable: true, configurable: true });
  }
  seen.delete(value);
  return Object.freeze(copy) as T;
}

class Envelope implements ReferencedRevisionEnvelope {
  readonly #bytes: Uint8Array;
  constructor(
    readonly documentId: string,
    readonly revisionId: string,
    readonly sequence: number,
    readonly document: unknown,
    readonly canonicalization: ReferencedRevisionEnvelope["canonicalization"],
    bytes: Uint8Array,
  ) {
    this.#bytes = bytes;
    Object.freeze(this);
  }
  get canonicalBytes(): Uint8Array { return Uint8Array.prototype.slice.call(this.#bytes); }
}

/** Consume one referenced revision without validating document schema or canonical parity. */
export async function readReferencedRevisionEnvelope(
  identity: DurableDraftIdentity,
  persistence: RevisionReadPort,
): Promise<ReferencedRevisionEnvelope> {
  try {
    const receiver = persistence;
    const readRevision = receiver.readRevision;
    const documentId = own(identity, "documentId");
    const revisionId = own(identity, "revisionId");
    const sequence = own(identity, "sequence");
    if (typeof readRevision !== "function" || typeof documentId !== "string" || !documentId.trim() ||
      typeof revisionId !== "string" || !revisionId.trim() ||
      !Number.isSafeInteger(sequence) || (sequence as number) < 0 || own(identity, "kind") !== "draft") throw failure();
    const read = await readRevision.call(receiver, documentId, revisionId);
    const result = snapshotIssuedCompleteRevision(read) ?? read;
    if (own(result, "documentId") !== documentId || own(result, "revisionId") !== revisionId ||
      own(result, "sequence") !== sequence) throw failure();
    const document = own(result, "document");
    const canonicalization = own(result, "canonicalization");
    const identifier = own(canonicalization, "identifier");
    const byteLength = own(canonicalization, "byteLength");
    const source = own(result, "canonicalBytes");
    // Require the exact native brand before copying; never consult constructor/species.
    const intrinsicLength = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(Uint8Array.prototype), "byteLength",
    )?.get;
    if (!intrinsicLength) throw failure();
    const brand = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag,
    )?.get;
    if (!brand || brand.call(source) !== "Uint8Array") throw failure();
    const length: number = intrinsicLength.call(source);
    const bytes = new Uint8Array(length);
    Uint8Array.prototype.set.call(bytes, source as Uint8Array);
    if (identifier !== CANONICALIZATION_IDENTIFIER || !Number.isSafeInteger(byteLength) ||
      (byteLength as number) < 0 || byteLength !== bytes.byteLength) throw failure();
    return new Envelope(documentId, revisionId, sequence as number, cloneFrozen(document),
      Object.freeze({ identifier: CANONICALIZATION_IDENTIFIER, byteLength: bytes.byteLength }), bytes);
  } catch {
    throw failure();
  }
}
