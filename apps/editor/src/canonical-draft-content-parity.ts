import { createCompleteRevision, type CompleteSceneRevision } from "@particle-studio/persistence";
import { canonicalizeSceneDocument } from "@particle-studio/scene-document";
import { createCanonicalReferencePlan, type CanonicalReferencePlan } from "./canonical-reference-plan.js";
import type { ReferencedRevisionEnvelope } from "./referenced-revision-envelope.js";

const failure = () => new Error("EDITOR_REFERENCED_REVISION_RELOAD_FAILED");
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function own<T>(value: unknown, key: string): T {
  if (value === null || typeof value !== "object") throw failure();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw failure();
  return descriptor.value as T;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Validate canonical payload and supplied document independently, without reloading persistence. */
export function readCanonicalDraftContentParity(envelope: ReferencedRevisionEnvelope): Readonly<{
  plan: CanonicalReferencePlan;
  revision: CompleteSceneRevision;
}> {
  try {
    if (envelope === null || typeof envelope !== "object") throw failure();
    const documentId = own<string>(envelope, "documentId");
    const revisionId = own<string>(envelope, "revisionId");
    const sequence = own<number>(envelope, "sequence");
    const document = own<ReferencedRevisionEnvelope["document"]>(envelope, "document");
    const canonicalization = own<ReferencedRevisionEnvelope["canonicalization"]>(envelope, "canonicalization");
    // The predecessor's immutable envelope exposes defensive bytes through a prototype getter.
    // Read it once, then compare both independent authorities against this single snapshot.
    const source = envelope.canonicalBytes;
    const bytes = new Uint8Array(Uint8Array.prototype.slice.call(source));
    if (typeof documentId !== "string" || typeof revisionId !== "string" ||
      !Number.isSafeInteger(sequence) || typeof canonicalization !== "object" ||
      canonicalization === null || own<number>(canonicalization, "byteLength") !== bytes.byteLength ||
      own<string>(canonicalization, "identifier") !== "jcs-1") throw failure();

    const decoded = decoder.decode(bytes);
    const planned = createCanonicalReferencePlan(decoded);
    if (!planned.ok || !equalBytes(encoder.encode(planned.value.canonicalEditableJson), bytes)) throw failure();

    // Do not substitute the decoded document: the supplied envelope document is a separate authority.
    const revision = createCompleteRevision({ documentId, revisionId, sequence, document });
    const canonical = canonicalizeSceneDocument(document);
    if (!equalBytes(canonical.bytes, bytes) || !equalBytes(revision.canonicalBytes, bytes)) throw failure();
    return Object.freeze({ plan: planned.value, revision });
  } catch {
    throw failure();
  }
}
