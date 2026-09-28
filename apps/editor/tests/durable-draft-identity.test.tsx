import { describe, expect, it, vi } from "vitest";
import { readDurableDraftIdentity } from "../src/durable-draft-identity.js";

const draft = { kind: "draft", documentId: "doc-1", revisionId: "rev-1", sequence: 2 };
const failure = "EDITOR_DURABLE_DRAFT_RELOAD_FAILED";

function port(value: unknown) {
  return { readPointers: vi.fn(async () => value) };
}

describe("durable draft identity reload", () => {
  it("reads once and returns a frozen defensive identity without observing saved or extras", async () => {
    const input = { ...draft, extra: "ignored" };
    const saved = Object.defineProperty({}, "documentId", { get() { throw Error("saved read"); } });
    const pointers = { draft: input, get saved() { throw Error("saved read"); } };
    const persistence = port(pointers);
    const result = await readDurableDraftIdentity("doc-1", persistence);
    expect(result).toEqual(draft);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).not.toBe(input);
    input.revisionId = "changed";
    expect(result.revisionId).toBe("rev-1");
    expect(persistence.readPointers).toHaveBeenCalledExactlyOnceWith("doc-1");
    expect(saved).toBeDefined();
  });

  it("captures the port receiver and method before the first await", async () => {
    let resolve!: (value: unknown) => void;
    const persistence = { readPointers: vi.fn(function (this: unknown) {
      expect(this).toBe(persistence);
      return new Promise<unknown>((done) => { resolve = done; });
    }) };
    const pending = readDurableDraftIdentity("doc-1", persistence);
    persistence.readPointers = vi.fn(async () => { throw Error("replaced"); });
    resolve({ draft });
    expect(await pending).toEqual(draft);
  });

  it.each([null, {}, { draft: null }, { draft: { ...draft, kind: "saved" } },
    { draft: { ...draft, documentId: "other" } },
    { draft: { ...draft, revisionId: "" } },
    { draft: { ...draft, sequence: -1 } },
    { draft: { ...draft, sequence: 1.5 } },
    { draft: Object.defineProperty({ ...draft }, "revisionId", { get() { throw Error("secret"); } }) },
  ])("maps invalid pointer input to one public failure", async (value) => {
    await expect(readDurableDraftIdentity("doc-1", port(value))).rejects.toThrow(failure);
  });

  it.each(["", "  \t\n "]) ("rejects blank configured document identifiers (%j)", async (id) => {
    const persistence = port({ draft });
    await expect(readDurableDraftIdentity(id, persistence)).rejects.toThrow(failure);
    expect(persistence.readPointers).not.toHaveBeenCalled();
  });

  it("rejects blank revision identifiers", async () => {
    await expect(readDurableDraftIdentity("doc-1", port({ draft: { ...draft, revisionId: " \t " } })))
      .rejects.toThrow(failure);
  });

  it.each(["own", "inherited"] as const)("does not invoke an %s draft getter", async (placement) => {
    const getter = vi.fn(() => draft);
    const pointers = placement === "own"
      ? Object.defineProperty({}, "draft", { get: getter })
      : Object.create(Object.defineProperty({}, "draft", { get: getter }));
    const persistence = port(pointers);
    await expect(readDurableDraftIdentity("doc-1", persistence)).rejects.toThrow(failure);
    expect(getter).not.toHaveBeenCalled();
    expect(persistence.readPointers).toHaveBeenCalledExactlyOnceWith("doc-1");
  });

  it("rejects an inherited draft data property", async () => {
    await expect(readDurableDraftIdentity("doc-1", port(Object.create({ draft }))))
      .rejects.toThrow(failure);
  });

  it("maps read rejection and invalid dependency to the same failure", async () => {
    await expect(readDurableDraftIdentity("doc-1", {
      readPointers: async () => { throw Error("secret"); },
    })).rejects.toThrow(failure);
    await expect(readDurableDraftIdentity("doc-1", null as never)).rejects.toThrow(failure);
  });
});
