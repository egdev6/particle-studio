export interface DurableDraftIdentity {
  readonly kind: "draft";
  readonly documentId: string;
  readonly revisionId: string;
  readonly sequence: number;
}

export interface DraftPointerReadPort {
  readPointers(documentId: string): Promise<unknown>;
}

const failure = () => new Error("EDITOR_DURABLE_DRAFT_RELOAD_FAILED");

/** Reload only the durable draft pointer identity; revision contents remain untouched. */
export async function readDurableDraftIdentity(
  documentId: string,
  persistence: DraftPointerReadPort,
): Promise<DurableDraftIdentity> {
  try {
    // Snapshot both the invocation target and configured scalar before suspension.
    const id = documentId;
    const receiver = persistence;
    const readPointers = receiver.readPointers;
    if (typeof id !== "string" || id.trim().length === 0 || typeof readPointers !== "function")
      throw failure();

    const result: unknown = await readPointers.call(receiver, id);
    if (result === null || typeof result !== "object") throw failure();
    // Only an own data property may supply the draft; never invoke a draft getter.
    const draftDescriptor = Object.getOwnPropertyDescriptor(result, "draft");
    if (!draftDescriptor || !("value" in draftDescriptor)) throw failure();
    const draft: unknown = draftDescriptor.value;
    if (draft === null || typeof draft !== "object") throw failure();

    // Own data properties prevent inherited/accessor values from crossing the boundary.
    // Inspect no other properties of either the snapshot or pointer.
    const fields = ["kind", "documentId", "revisionId", "sequence"] as const;
    const values: unknown[] = [];
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(draft, field);
      if (!descriptor || !("value" in descriptor)) throw failure();
      // SAFETY: draft is an object and field is one of the four checked own keys.
      const value: unknown = (draft as unknown as Record<typeof field, unknown>)[field];
      if (!Object.is(value, descriptor.value)) throw failure();
      values.push(value);
    }
    const [kind, pointerDocumentId, revisionId, sequence] = values;
    if (kind !== "draft" || pointerDocumentId !== id ||
      typeof revisionId !== "string" || revisionId.trim().length === 0 ||
      !Number.isSafeInteger(sequence) || (sequence as number) < 0) throw failure();
    return Object.freeze({ kind, documentId: pointerDocumentId, revisionId,
      sequence: sequence as number });
  } catch {
    throw failure();
  }
}
