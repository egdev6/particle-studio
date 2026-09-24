import { describe, expect, it } from "vitest";
import {
  createCommandSession,
  type CommandSession,
} from "@particle-studio/commands";
import {
  FIRST_SLICE_DOCUMENT,
  canonicalizeSceneDocument,
  type SceneDocumentV1,
} from "@particle-studio/scene-document";

const document = () => structuredClone(FIRST_SLICE_DOCUMENT) as SceneDocumentV1;

const firstValue = (session: ReturnType<typeof createCommandSession>) =>
  session.snapshot().document.tracks[0]!.keyframes[0]!.value;
const secondValue = (session: ReturnType<typeof createCommandSession>) =>
  session.snapshot().document.tracks[0]!.keyframes[1]!.value;
const mutate = (result: ReturnType<CommandSession["dispatch"]>) => {
  if (result.ok) result.document.tracks[0]!.keyframes[0]!.value = 0;
  return result;
};

function command(
  value: number,
  revision = 0,
  actorCapability = "human-ui",
  timeUs = 0,
) {
  return {
    commandSchemaVersion: 1,
    commandId: "command-1",
    documentId: "document-1",
    expectedRevision: revision,
    actorCapability,
    payload: {
      type: "set-keyframe-value" as const,
      trackId: "shape-1:opacity",
      keyframeId: `shape-1:opacity:${timeUs}`,
      value,
    },
  };
}

const createCommand = (
  element: Record<string, unknown>,
  revision = 0,
  actorCapability = "human-ui",
) => ({
  commandSchemaVersion: 1,
  commandId: "create-command",
  documentId: "document-1",
  expectedRevision: revision,
  actorCapability,
  payload: { type: "create-element" as const, element },
});

const removeCommand = (
  elementId: string,
  revision = 0,
  actorCapability = "human-ui",
) => ({
  commandSchemaVersion: 1,
  commandId: "remove-command",
  documentId: "document-1",
  expectedRevision: revision,
  actorCapability,
  payload: { type: "remove-element" as const, elementId },
});

const replaceCommand = (
  elementId: string,
  element: Record<string, unknown>,
  revision = 0,
  actorCapability = "human-ui",
) => ({
  commandSchemaVersion: 1,
  commandId: "replace-command",
  documentId: "document-1",
  expectedRevision: revision,
  actorCapability,
  payload: { type: "replace-element" as const, elementId, element },
});

const groupCommand = (
  elementIds: readonly string[],
  revision = 0,
  actorCapability = "human-ui",
) => ({
  commandSchemaVersion: 1,
  commandId: "group-command",
  documentId: "document-1",
  expectedRevision: revision,
  actorCapability,
  payload: { type: "group-elements" as const, elementIds },
});

const ungroupCommand = (
  groupId: string,
  revision = 0,
  actorCapability = "human-ui",
) => ({
  commandSchemaVersion: 1,
  commandId: "ungroup-command",
  documentId: "document-1",
  expectedRevision: revision,
  actorCapability,
  payload: { type: "ungroup-element" as const, groupId },
});

const reparentCommand = (
  elementId: string,
  position: number,
  revision = 0,
  actorCapability = "human-ui",
) => ({
  commandSchemaVersion: 1,
  commandId: "reparent-command",
  documentId: "document-1",
  expectedRevision: revision,
  actorCapability,
  payload: {
    type: "reparent-element" as const,
    elementId,
    parentId: null,
    position,
  },
});

const groupReparentCommand = (
  elementId: string,
  parentId: string,
  position: number,
  revision = 0,
  actorCapability = "human-ui",
) => ({
  commandSchemaVersion: 1,
  commandId: "group-reparent-command",
  documentId: "document-1",
  expectedRevision: revision,
  actorCapability,
  payload: {
    type: "reparent-element" as const,
    elementId,
    parentId,
    position,
  },
});

const rootElements = (): Array<Record<string, unknown>> => [
  { type: "shape", x: 1, y: 2, width: 3, height: 4, opacity: 0.5 },
  { type: "line", x1: 1, y1: 2, x2: 3, y2: 4, opacity: 0.5 },
  { type: "group", childrenIds: [] },
  {
    type: "particle",
    count: 1,
    x: 1,
    y: 2,
    velocityX: 3,
    velocityY: 4,
    spread: 0,
    size: 1,
    opacity: 0.5,
    lifetimeSteps: 1,
  },
  { type: "text", text: "hello", x: 1, y: 2, fontSize: 12, opacity: 0.5 },
  {
    type: "image",
    asset: {
      sha256: `sha256:${"a".repeat(64)}`,
      mimeType: "image/png",
      byteLength: 1,
      intrinsicWidth: 1,
      intrinsicHeight: 1,
    },
    x: 1,
    y: 2,
    width: 3,
    height: 4,
    opacity: 0.5,
  },
];

describe("command session", () => {
  it("commits an immutable valid keyframe mutation at revision one", () => {
    const input = document();
    const session = createCommandSession("document-1", input);
    input.tracks[0]!.keyframes[1]!.value = 0.5;

    const result = mutate(session.dispatch(command(0.25)));

    expect(result).toMatchObject({ ok: true, revision: 1 });
    if (!result.ok) return;
    expect(result.document).not.toBe(input);
    expect(
      result.document.tracks[0]?.keyframes.map(({ value }) => value),
    ).toEqual([0, 0.75]);
    const snapshot = session.snapshot();
    snapshot.document.tracks[0]!.keyframes[0]!.value = 0.5;
    expect(session.snapshot().document.tracks[0]?.keyframes[0]?.value).toBe(
      0.25,
    );
    expect(input.tracks[0]?.keyframes.map(({ value }) => value)).toEqual([
      0.25, 0.5,
    ]);
  });

  it("creates a source-ID shape in the root slot", () => {
    const session = createCommandSession("document-1", document(), () => ({
      kind: "id",
      id: "shape-2",
    }));

    expect(
      session.dispatch(
        createCommand({
          type: "shape",
          x: 1,
          y: 2,
          width: 3,
          height: 4,
          opacity: 0.5,
        }),
      ),
    ).toMatchObject({ ok: true, revision: 1 });
    expect(session.snapshot().document.rootIds).toEqual(["shape-1", "shape-2"]);
  });

  it("removes an existing root element without calling its ID source", () => {
    let calls = 0;
    const session = createCommandSession("document-1", document(), () => {
      calls += 1;
      return { kind: "id", id: "group-2" };
    });
    expect(
      session.dispatch(createCommand({ type: "group", childrenIds: [] })),
    ).toMatchObject({ ok: true, revision: 1 });

    const result = session.dispatch(removeCommand("group-2", 1));

    expect(result).toMatchObject({ ok: true, revision: 2 });
    expect(session.snapshot().document.rootIds).toEqual(["shape-1"]);
    expect(session.snapshot().document.elements.map(({ id }) => id)).toEqual([
      "shape-1",
    ]);
    expect(calls).toBe(1);
  });

  it("removes every root union member with equivalent actors and exact history", () => {
    const elements = rootElements();
    expect(elements).toHaveLength(6);
    for (const [index, element] of elements.entries()) {
      let calls = 0;
      const id = `removable-${index}`;
      const session = createCommandSession("document-1", document(), () => {
        calls += 1;
        return { kind: "id", id };
      });
      expect(session.dispatch(createCommand(element))).toMatchObject({
        ok: true,
        revision: 1,
      });
      const beforeRemove = session.snapshot().document;
      expect(session.dispatch(removeCommand(id, 1))).toMatchObject({
        ok: true,
        revision: 2,
      });
      const afterRemove = session.snapshot().document;
      expect(afterRemove.rootIds).toEqual(["shape-1"]);
      expect(
        afterRemove.elements.map(({ id: elementId }) => elementId),
      ).toEqual(["shape-1"]);
      expect(afterRemove.tracks.map(({ elementId }) => elementId)).toEqual([
        "shape-1",
      ]);
      expect(calls).toBe(1);
      expect(session.undo()).toMatchObject({ ok: true, revision: 3 });
      expect(session.snapshot().document).toEqual(beforeRemove);
      expect(session.redo()).toMatchObject({ ok: true, revision: 4 });
      expect(session.snapshot().document).toEqual(afterRemove);
    }
    const results = ["human-ui", "browser-agent", "headless-agent"].map(
      (actor) => {
        const session = createCommandSession("document-1", document(), () => ({
          kind: "id",
          id: "actor-root",
        }));
        session.dispatch(createCommand({ type: "group", childrenIds: [] }));
        return session.dispatch(removeCommand("actor-root", 1, actor));
      },
    );
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
    const firstResult = results[0]!;
    const canonical = canonicalizeSceneDocument(
      firstResult.ok ? firstResult.document : document(),
    ).bytes;
    const reloaded = JSON.parse(new TextDecoder().decode(canonical));
    expect(canonicalizeSceneDocument(reloaded).bytes).toEqual(canonical);
  });

  it("replaces each root union member and retargets only direct tracks", () => {
    const elements = rootElements();
    expect(elements).toHaveLength(6);
    for (const [index, target] of elements.entries()) {
      let calls = 0;
      const targetId = `target-${index}`;
      const input = document();
      input.rootIds.push(targetId);
      input.elements.push({ ...target, id: targetId } as never);
      const session = createCommandSession("document-1", input, () => {
        calls += 1;
        return { kind: "id", id: `replacement-${index}` };
      });
      const before = session.snapshot().document;

      expect(
        session.dispatch(
          replaceCommand(targetId, elements[(index + 1) % elements.length]!),
        ),
      ).toMatchObject({ ok: true, revision: 1 });
      const after = session.snapshot().document;
      expect(after.rootIds).toEqual(["shape-1", `replacement-${index}`]);
      expect(after.elements.map(({ id }) => id)).toEqual([
        "shape-1",
        `replacement-${index}`,
      ]);
      expect(after.tracks.map(({ elementId }) => elementId)).toEqual([
        "shape-1",
      ]);
      expect(calls).toBe(1);
      expect(session.undo()).toMatchObject({ ok: true, revision: 2 });
      expect(session.snapshot().document).toEqual(before);
      expect(session.redo()).toMatchObject({ ok: true, revision: 3 });
      expect(session.snapshot().document).toEqual(after);
      expect(calls).toBe(1);
    }
    const actors = ["human-ui", "browser-agent", "headless-agent"].map(
      (actor) =>
        createCommandSession("document-1", document(), () => ({
          kind: "id",
          id: "actor-replacement",
        })).dispatch(replaceCommand("shape-1", rootElements()[0]!, 0, actor)),
    );
    expect(actors[0]).toEqual(actors[1]);
    expect(actors[1]).toEqual(actors[2]);
    const result = actors[0]!;
    expect(result.ok && result.document.tracks[0]!.elementId).toBe(
      "actor-replacement",
    );
    const canonical = canonicalizeSceneDocument(
      result.ok ? result.document : document(),
    ).bytes;
    const reloaded = JSON.parse(new TextDecoder().decode(canonical));
    expect(canonicalizeSceneDocument(reloaded).bytes).toEqual(canonical);

    const ids = ["redo-first", "redo-second"];
    const redoSession = createCommandSession("document-1", document(), () => ({
      kind: "id",
      id: ids.shift()!,
    }));
    expect(
      redoSession.dispatch(replaceCommand("shape-1", rootElements()[0]!)),
    ).toMatchObject({ ok: true, revision: 1 });
    expect(redoSession.undo()).toMatchObject({ ok: true, revision: 2 });
    expect(
      redoSession.dispatch(replaceCommand("shape-1", rootElements()[0]!, 2)),
    ).toMatchObject({ ok: true, revision: 3 });
    expect(redoSession.redo()).toEqual({
      ok: false,
      error: { code: "NOTHING_TO_REDO" },
    });
  });

  it("consumes replacement IDs only after root preconditions and preserves rejected history", () => {
    let calls = 0;
    const supplied: unknown[] = [
      { kind: "id", id: "candidate" },
      { kind: "unavailable" },
      { kind: "id", id: "" },
      { kind: "id", id: "shape-1" },
    ];
    const session = createCommandSession("document-1", document(), () => {
      calls += 1;
      return supplied.shift() as never;
    });
    const before = session.snapshot();
    const cases: Array<[unknown, string, number]> = [
      [{}, "MALFORMED_COMMAND", 0],
      [
        replaceCommand("shape-1", { ...rootElements()[0], id: "forged" }),
        "MALFORMED_COMMAND",
        0,
      ],
      [
        {
          ...replaceCommand("shape-1", rootElements()[0]!),
          documentId: "other",
        },
        "DOCUMENT_MISMATCH",
        0,
      ],
      [
        replaceCommand("shape-1", rootElements()[0]!, 1),
        "REVISION_CONFLICT",
        0,
      ],
      [replaceCommand("missing", rootElements()[0]!), "TARGET_NOT_FOUND", 0],
      [
        replaceCommand("shape-1", { ...rootElements()[0], width: Infinity }),
        "INVALID_CANDIDATE",
        1,
      ],
      [
        replaceCommand("shape-1", rootElements()[0]!),
        "ID_SOURCE_UNAVAILABLE",
        2,
      ],
      [replaceCommand("shape-1", rootElements()[0]!), "ID_SOURCE_INVALID", 3],
      [replaceCommand("shape-1", rootElements()[0]!), "ID_COLLISION", 4],
    ];
    for (const [input, code, expectedCalls] of cases) {
      expect(session.dispatch(input)).toEqual({ ok: false, error: { code } });
      expect(calls).toBe(expectedCalls);
      expect(session.snapshot()).toEqual(before);
    }
    const grouped = document();
    grouped.rootIds = ["group-1"];
    grouped.elements.push({
      id: "group-1",
      type: "group",
      childrenIds: ["shape-1"],
    });
    const groupedCalls = { value: 0 };
    const groupedSession = createCommandSession("document-1", grouped, () => {
      groupedCalls.value += 1;
      return { kind: "id", id: "unused" };
    });
    const groupedBefore = groupedSession.snapshot();
    expect(
      groupedSession.dispatch(replaceCommand("shape-1", rootElements()[0]!)),
    ).toEqual({ ok: false, error: { code: "TARGET_NOT_FOUND" } });
    expect(
      groupedSession.dispatch(replaceCommand("group-1", rootElements()[0]!)),
    ).toEqual({ ok: false, error: { code: "INVALID_CANDIDATE" } });
    expect(groupedCalls.value).toBe(0);
    expect(groupedSession.snapshot()).toEqual(groupedBefore);

    let throwingCalls = 0;
    const throwingSession = createCommandSession(
      "document-1",
      document(),
      () => {
        throwingCalls += 1;
        throw new Error("source failure");
      },
    );
    const throwingBefore = throwingSession.snapshot();
    expect(
      throwingSession.dispatch(replaceCommand("shape-1", rootElements()[0]!)),
    ).toEqual({ ok: false, error: { code: "ID_SOURCE_UNAVAILABLE" } });
    expect(throwingCalls).toBe(1);
    expect(throwingSession.snapshot()).toEqual(throwingBefore);
  });

  it("rejects malformed and unsafe root removals without history changes", () => {
    let calls = 0;
    const session = createCommandSession("document-1", document(), () => {
      calls += 1;
      return { kind: "id", id: "unused" };
    });
    const before = session.snapshot();
    const cases: Array<[unknown, string]> = [
      [{}, "MALFORMED_COMMAND"],
      [removeCommand(""), "MALFORMED_COMMAND"],
      [
        {
          ...removeCommand("shape-1"),
          payload: {
            type: "remove-element",
            elementId: "shape-1",
            extra: true,
          },
        },
        "MALFORMED_COMMAND",
      ],
      [
        { ...removeCommand("shape-1"), documentId: "other" },
        "DOCUMENT_MISMATCH",
      ],
      [removeCommand("shape-1", 1), "REVISION_CONFLICT"],
      [removeCommand("missing"), "TARGET_NOT_FOUND"],
      [removeCommand("shape-1"), "INVALID_CANDIDATE"],
    ];
    for (const [input, code] of cases) {
      expect(session.dispatch(input)).toEqual({ ok: false, error: { code } });
      expect(session.snapshot()).toEqual(before);
      expect(calls).toBe(0);
    }
    expect(session.undo()).toEqual({
      ok: false,
      error: { code: "NOTHING_TO_UNDO" },
    });
    expect(session.redo()).toEqual({
      ok: false,
      error: { code: "NOTHING_TO_REDO" },
    });

    const grouped = document();
    grouped.rootIds = ["group-1"];
    grouped.elements.push({
      id: "group-1",
      type: "group",
      childrenIds: ["shape-1"],
    });
    const groupedSession = createCommandSession("document-1", grouped);
    const groupedBefore = groupedSession.snapshot();
    expect(groupedSession.dispatch(removeCommand("shape-1"))).toEqual({
      ok: false,
      error: { code: "TARGET_NOT_FOUND" },
    });
    expect(groupedSession.dispatch(removeCommand("group-1"))).toEqual({
      ok: false,
      error: { code: "INVALID_CANDIDATE" },
    });
    expect(groupedSession.snapshot()).toEqual(groupedBefore);
  });

  it("creates every supported root element with equivalent actor results", () => {
    const elements = rootElements();
    expect(elements).toHaveLength(6);
    for (const [index, element] of elements.entries()) {
      const id = `created-${index}`;
      const result = createCommandSession("document-1", document(), () => ({
        kind: "id",
        id,
      })).dispatch(createCommand(element));
      expect(result).toMatchObject({ ok: true, revision: 1 });
      if (result.ok) {
        expect(result.document.rootIds.at(-1)).toBe(id);
        expect(result.document.elements.at(-1)).toMatchObject({
          id,
          type: element.type,
        });
      }
    }
    const states = ["human-ui", "browser-agent", "headless-agent"].map(
      (actor) =>
        createCommandSession("document-1", document(), () => ({
          kind: "id",
          id: "actor-created",
        })).dispatch(
          createCommand({ type: "group", childrenIds: [] }, 0, actor),
        ),
    );
    expect(states[0]).toEqual(states[1]);
    expect(states[1]).toEqual(states[2]);
  });

  it("rejects forged, early, source, collision, and invalid-candidate creates atomically", () => {
    const supplied: unknown[] = [
      { kind: "id", id: "candidate" },
      { kind: "unavailable" },
      "source-error",
      { kind: "id", id: "" },
      { kind: "id", id: "1-unstable" },
      { kind: "id", id: "shape-1" },
    ];
    let calls = 0;
    const session = createCommandSession("document-1", document(), () => {
      calls += 1;
      return supplied.shift() as never;
    });
    const before = session.snapshot();
    const cases: Array<[unknown, string, number]> = [
      [
        createCommand({
          type: "shape",
          id: "forged",
          x: 1,
          y: 2,
          width: 3,
          height: 4,
          opacity: 0.5,
        }),
        "MALFORMED_COMMAND",
        0,
      ],
      [
        createCommand({ type: "group", childrenIds: ["shape-1"] }),
        "MALFORMED_COMMAND",
        0,
      ],
      [
        {
          ...createCommand({ type: "group", childrenIds: [] }),
          documentId: "other",
        },
        "DOCUMENT_MISMATCH",
        0,
      ],
      [
        createCommand({ type: "group", childrenIds: [] }, 1),
        "REVISION_CONFLICT",
        0,
      ],
      [
        createCommand({
          type: "shape",
          x: 1,
          y: 2,
          width: Infinity,
          height: 4,
          opacity: 0.5,
        }),
        "INVALID_CANDIDATE",
        1,
      ],
      [
        createCommand({ type: "group", childrenIds: [] }),
        "ID_SOURCE_UNAVAILABLE",
        2,
      ],
      [
        createCommand({ type: "group", childrenIds: [] }),
        "ID_SOURCE_INVALID",
        3,
      ],
      [
        createCommand({ type: "group", childrenIds: [] }),
        "ID_SOURCE_INVALID",
        4,
      ],
      [
        createCommand({ type: "group", childrenIds: [] }),
        "ID_SOURCE_INVALID",
        5,
      ],
      [createCommand({ type: "group", childrenIds: [] }), "ID_COLLISION", 6],
    ];
    for (const [input, code, expectedCalls] of cases) {
      expect(session.dispatch(input)).toEqual({ ok: false, error: { code } });
      expect(calls).toBe(expectedCalls);
      expect(session.snapshot()).toEqual(before);
    }
    expect(session.undo()).toEqual({
      ok: false,
      error: { code: "NOTHING_TO_UNDO" },
    });
    expect(
      createCommandSession("document-1", document()).dispatch(
        createCommand({ type: "group", childrenIds: [] }),
      ),
    ).toEqual({ ok: false, error: { code: "ID_SOURCE_UNAVAILABLE" } });
  });

  it("replays generated IDs without a source recall and clears redo after a create", () => {
    const ids = ["shape-2", "group-2"];
    let calls = 0;
    const session = createCommandSession("document-1", document(), () => {
      calls += 1;
      return { kind: "id", id: ids[calls - 1]! };
    });
    expect(
      session.dispatch(createCommand({ type: "group", childrenIds: [] })),
    ).toMatchObject({ ok: true, revision: 1 });
    expect(session.undo()).toMatchObject({ ok: true, revision: 2 });
    expect(session.redo()).toMatchObject({ ok: true, revision: 3 });
    expect(calls).toBe(1);
    expect(session.snapshot().document.rootIds.at(-1)).toBe("shape-2");
    expect(session.undo()).toMatchObject({ ok: true, revision: 4 });
    expect(
      session.dispatch(createCommand({ type: "group", childrenIds: [] }, 4)),
    ).toMatchObject({ ok: true, revision: 5 });
    expect(calls).toBe(2);
    expect(session.redo()).toEqual({
      ok: false,
      error: { code: "NOTHING_TO_REDO" },
    });
    const canonical = canonicalizeSceneDocument(
      session.snapshot().document,
    ).bytes;
    const reloaded = JSON.parse(new TextDecoder().decode(canonical));
    expect(canonicalizeSceneDocument(reloaded).bytes).toEqual(canonical);
  });

  it("rejects malformed, mismatched, stale, missing, and invalid commands atomically", () => {
    const session = createCommandSession("document-1", document());
    const before = session.snapshot();
    const cases: Array<[unknown, string]> = [
      [{}, "MALFORMED_COMMAND"],
      [{ ...command(0.2), documentId: "other" }, "DOCUMENT_MISMATCH"],
      [command(0.2, 1), "REVISION_CONFLICT"],
      [
        {
          ...command(0.2),
          payload: { ...command(0.2).payload, trackId: "missing" },
        },
        "TARGET_NOT_FOUND",
      ],
      [command(Infinity), "INVALID_CANDIDATE"],
    ];

    for (const [input, code] of cases) {
      expect(session.dispatch(input)).toEqual({ ok: false, error: { code } });
      expect(session.snapshot()).toEqual(before);
    }
    expect(session.undo().ok).toBe(false);
  });

  it("groups root siblings at their earliest slot in original order", () => {
    const input = document();
    input.rootIds = ["shape-1", "line-2", "shape-3"];
    input.elements.push(
      {
        id: "line-2",
        type: "line",
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        opacity: 0.5,
      },
      {
        id: "shape-3",
        type: "shape",
        x: 5,
        y: 6,
        width: 7,
        height: 8,
        opacity: 0.5,
      },
    );
    let calls = 0;
    const session = createCommandSession("document-1", input, () => {
      calls += 1;
      return { kind: "id", id: "group-1" };
    });

    const result = session.dispatch(groupCommand(["shape-3", "shape-1"]));

    expect(result).toMatchObject({ ok: true, revision: 1 });
    expect(session.snapshot().document.rootIds).toEqual(["group-1", "line-2"]);
    expect(
      session.snapshot().document.elements.find(({ id }) => id === "group-1"),
    ).toEqual({
      id: "group-1",
      type: "group",
      childrenIds: ["shape-1", "shape-3"],
    });
    const grouped = session.snapshot().document;
    expect(calls).toBe(1);
    expect(session.undo()).toMatchObject({ ok: true, revision: 2 });
    expect(session.snapshot().document).toEqual(input);
    expect(session.redo()).toMatchObject({ ok: true, revision: 3 });
    expect(session.snapshot().document).toEqual(grouped);
    expect(calls).toBe(1);
    const canonical = canonicalizeSceneDocument(grouped).bytes;
    const reloaded = JSON.parse(new TextDecoder().decode(canonical));
    expect(canonicalizeSceneDocument(reloaded).bytes).toEqual(canonical);
  });

  it("groups nested siblings and rejects invalid requests before consuming IDs", () => {
    const input = document();
    input.rootIds = ["owner"];
    input.elements.push(
      {
        id: "line-2",
        type: "line",
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        opacity: 0.5,
      },
      { id: "owner", type: "group", childrenIds: ["shape-1", "line-2"] },
    );
    let calls = 0;
    const supplied: unknown[] = [
      { kind: "unavailable" },
      { kind: "id", id: "" },
      { kind: "id", id: "owner" },
      { kind: "id", id: "nested-group" },
    ];
    const session = createCommandSession("document-1", input, () => {
      calls += 1;
      return supplied.shift() as never;
    });
    const before = session.snapshot();
    const rejected: Array<[unknown, string]> = [
      [{}, "MALFORMED_COMMAND"],
      [groupCommand(["shape-1"]), "MALFORMED_COMMAND"],
      [groupCommand(["shape-1", "shape-1"]), "MALFORMED_COMMAND"],
      [
        { ...groupCommand(["shape-1", "line-2"]), documentId: "other" },
        "DOCUMENT_MISMATCH",
      ],
      [groupCommand(["shape-1", "line-2"], 1), "REVISION_CONFLICT"],
      [groupCommand(["shape-1", "missing"]), "TARGET_NOT_FOUND"],
      [groupCommand(["owner", "shape-1"]), "INVALID_CANDIDATE"],
      [
        {
          ...groupCommand(["shape-1", "line-2"]),
          payload: {
            ...groupCommand(["shape-1", "line-2"]).payload,
            position: 1,
          },
        },
        "MALFORMED_COMMAND",
      ],
    ];
    for (const [command, code] of rejected) {
      expect(session.dispatch(command)).toEqual({ ok: false, error: { code } });
      expect(session.snapshot()).toEqual(before);
    }
    expect(calls).toBe(0);
    for (const code of [
      "ID_SOURCE_UNAVAILABLE",
      "ID_SOURCE_INVALID",
      "ID_COLLISION",
    ]) {
      expect(session.dispatch(groupCommand(["line-2", "shape-1"]))).toEqual({
        ok: false,
        error: { code },
      });
      expect(session.snapshot()).toEqual(before);
    }
    expect(session.dispatch(groupCommand(["line-2", "shape-1"]))).toMatchObject(
      { ok: true, revision: 1 },
    );
    expect(session.snapshot().document.rootIds).toEqual(["owner"]);
    expect(
      session.snapshot().document.elements.find(({ id }) => id === "owner"),
    ).toEqual({
      id: "owner",
      type: "group",
      childrenIds: ["nested-group"],
    });
    expect(calls).toBe(4);
    const actorResults = ["human-ui", "browser-agent", "headless-agent"].map(
      (actor) =>
        createCommandSession("document-1", input, () => ({
          kind: "id",
          id: "actor-group",
        })).dispatch(groupCommand(["shape-1", "line-2"], 0, actor)),
    );
    expect(actorResults[0]).toEqual(actorResults[1]);
    expect(actorResults[1]).toEqual(actorResults[2]);
  });

  it("ungroups a root group at its slot with world matrices and hidden visibility", () => {
    const input = document();
    input.rootIds = ["group-1", "shape-2"];
    input.elements.push(
      {
        id: "line-2",
        type: "line",
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        opacity: 0.5,
      },
      {
        id: "shape-2",
        type: "shape",
        x: 5,
        y: 6,
        width: 7,
        height: 8,
        opacity: 0.5,
      },
      {
        id: "group-1",
        type: "group",
        childrenIds: ["shape-1", "line-2"],
        transform: [2, 0, 0, 3, 10, 20],
        visible: false,
      },
    );
    let calls = 0;
    const session = createCommandSession("document-1", input, () => {
      calls += 1;
      return { kind: "id", id: "unused" };
    });
    const before = session.snapshot().document;

    expect(session.dispatch(ungroupCommand("group-1"))).toMatchObject({
      ok: true,
      revision: 1,
    });
    const after = session.snapshot().document;
    expect(after.rootIds).toEqual(["shape-1", "line-2", "shape-2"]);
    expect(after.elements.map(({ id }) => id)).toEqual([
      "shape-1",
      "line-2",
      "shape-2",
    ]);
    expect(after.elements.find(({ id }) => id === "shape-1")).toMatchObject({
      transform: [2, 0, 0, 3, 10, 20],
      visible: false,
    });
    expect(after.elements.find(({ id }) => id === "line-2")).toMatchObject({
      transform: [2, 0, 0, 3, 10, 20],
      visible: false,
    });
    expect(after.tracks).toEqual(before.tracks);
    expect(calls).toBe(0);
    expect(session.undo()).toMatchObject({ ok: true, revision: 2 });
    expect(session.snapshot().document).toEqual(before);
    expect(session.redo()).toMatchObject({ ok: true, revision: 3 });
    expect(session.snapshot().document).toEqual(after);
    expect(session.undo()).toMatchObject({ ok: true, revision: 4 });
    expect(session.dispatch(ungroupCommand("group-1", 4))).toMatchObject({
      ok: true,
      revision: 5,
    });
    expect(session.redo()).toEqual({
      ok: false,
      error: { code: "NOTHING_TO_REDO" },
    });
    const canonical = canonicalizeSceneDocument(after).bytes;
    expect(
      canonicalizeSceneDocument(JSON.parse(new TextDecoder().decode(canonical)))
        .bytes,
    ).toEqual(canonical);
  });

  it("ungroups nested groups or rejects unsafe requests without source calls", () => {
    const input = document();
    input.rootIds = ["outer"];
    input.elements.push(
      {
        id: "outer",
        type: "group",
        childrenIds: ["inner"],
        transform: [2, 0, 0, 3, 0, 0],
      },
      {
        id: "inner",
        type: "group",
        childrenIds: ["shape-1"],
        transform: [4, 0, 0, 5, 1, 2],
        visible: false,
      },
    );
    let calls = 0;
    const session = createCommandSession("document-1", input, () => {
      calls += 1;
      return { kind: "id", id: "unused" };
    });
    const before = session.snapshot();
    for (const [request, code] of [
      [{}, "MALFORMED_COMMAND"],
      [ungroupCommand(""), "MALFORMED_COMMAND"],
      [
        { ...ungroupCommand("inner"), documentId: "other" },
        "DOCUMENT_MISMATCH",
      ],
      [ungroupCommand("inner", 1), "REVISION_CONFLICT"],
      [ungroupCommand("missing"), "TARGET_NOT_FOUND"],
      [ungroupCommand("shape-1"), "INVALID_CANDIDATE"],
    ] as const) {
      expect(session.dispatch(request)).toEqual({ ok: false, error: { code } });
      expect(session.snapshot()).toEqual(before);
    }
    expect(session.dispatch(ungroupCommand("inner"))).toMatchObject({
      ok: true,
      revision: 1,
    });
    expect(
      session.snapshot().document.elements.find(({ id }) => id === "outer"),
    ).toMatchObject({ childrenIds: ["shape-1"] });
    expect(
      session.snapshot().document.elements.find(({ id }) => id === "shape-1"),
    ).toMatchObject({
      transform: [4, 0, 0, 5, 1, 2],
      visible: false,
    });
    expect(calls).toBe(0);
    const actorResults = ["human-ui", "browser-agent", "headless-agent"].map(
      (actor) =>
        createCommandSession("document-1", input, () => {
          calls += 1;
          return { kind: "id", id: "unused" };
        }).dispatch(ungroupCommand("inner", 0, actor)),
    );
    expect(actorResults[0]).toEqual(actorResults[1]);
    expect(actorResults[1]).toEqual(actorResults[2]);
    expect(calls).toBe(0);

    const noninvertible = structuredClone(input);
    (
      noninvertible.elements.find(({ id }) => id === "outer") as {
        transform: number[];
      }
    ).transform = [0, 0, 0, 0, 0, 0];
    const blocked = createCommandSession("document-1", noninvertible, () => {
      calls += 1;
      return { kind: "id", id: "unused" };
    });
    const blockedBefore = blocked.snapshot();
    expect(blocked.dispatch(ungroupCommand("inner"))).toEqual({
      ok: false,
      error: { code: "INVALID_CANDIDATE" },
    });
    expect(blocked.snapshot()).toEqual(blockedBefore);
    expect(calls).toBe(0);
  });

  it("reparents a grouped element to root with its world affine, visibility, and tracks", () => {
    const input = document();
    input.rootIds = ["group-1", "shape-2"];
    input.elements.push(
      {
        id: "shape-2",
        type: "shape",
        x: 5,
        y: 6,
        width: 7,
        height: 8,
        opacity: 0.5,
      },
      {
        id: "group-1",
        type: "group",
        childrenIds: ["shape-1"],
        transform: [2, 0, 0, 3, 10, 20],
        visible: false,
      },
    );
    const session = createCommandSession("document-1", input);

    expect(session.dispatch(reparentCommand("shape-1", 1))).toMatchObject({
      ok: true,
      revision: 1,
    });
    const after = session.snapshot().document;
    expect(after.rootIds).toEqual(["group-1", "shape-1", "shape-2"]);
    expect(after.elements.find(({ id }) => id === "group-1")).toMatchObject({
      childrenIds: [],
    });
    expect(after.elements.find(({ id }) => id === "shape-1")).toMatchObject({
      transform: [2, 0, 0, 3, 10, 20],
      visible: false,
    });
    expect(after.tracks).toEqual(input.tracks);
    expect(session.undo()).toMatchObject({ ok: true, revision: 2 });
    expect(session.snapshot().document).toEqual(input);
    expect(session.redo()).toMatchObject({ ok: true, revision: 3 });
    expect(session.snapshot().document).toEqual(after);
    const canonical = canonicalizeSceneDocument(after).bytes;
    expect(
      canonicalizeSceneDocument(JSON.parse(new TextDecoder().decode(canonical)))
        .bytes,
    ).toEqual(canonical);
    const actors = ["human-ui", "browser-agent", "headless-agent"].map(
      (actor) =>
        createCommandSession("document-1", input).dispatch(
          reparentCommand("shape-1", 1, 0, actor),
        ),
    );
    expect(actors[0]).toEqual(actors[1]);
    expect(actors[1]).toEqual(actors[2]);
  });

  it("reorders root elements using final-list positions and preserves no-op content", () => {
    const input = document();
    input.rootIds = ["shape-1", "line-2", "shape-3"];
    input.elements.push(
      {
        id: "line-2",
        type: "line",
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        opacity: 0.5,
      },
      {
        id: "shape-3",
        type: "shape",
        x: 5,
        y: 6,
        width: 7,
        height: 8,
        opacity: 0.5,
      },
    );
    const session = createCommandSession("document-1", input);

    expect(session.dispatch(reparentCommand("shape-1", 2))).toMatchObject({
      ok: true,
      revision: 1,
    });
    expect(session.snapshot().document.rootIds).toEqual([
      "line-2",
      "shape-3",
      "shape-1",
    ]);
    const beforeNoOp = session.snapshot().document;
    expect(session.dispatch(reparentCommand("shape-1", 2, 1))).toMatchObject({
      ok: true,
      revision: 2,
    });
    expect(session.snapshot().document).toEqual(beforeNoOp);
  });

  it("reparents a deep hidden source without changing its tracks", () => {
    const input = document();
    input.rootIds = ["outer", "shape-2"];
    input.elements[0]!.transform = [1, 0, 0, 1, 3, 4];
    input.elements.push(
      {
        id: "shape-2",
        type: "shape",
        x: 5,
        y: 6,
        width: 7,
        height: 8,
        opacity: 0.5,
      },
      {
        id: "outer",
        type: "group",
        childrenIds: ["inner"],
        transform: [2, 0, 0, 3, 10, 20],
      },
      {
        id: "inner",
        type: "group",
        childrenIds: ["shape-1"],
        transform: [4, 0, 0, 5, 1, 2],
        visible: false,
      },
    );
    const session = createCommandSession("document-1", input);

    expect(session.dispatch(reparentCommand("shape-1", 1))).toMatchObject({
      ok: true,
      revision: 1,
    });
    expect(session.snapshot().document.rootIds).toEqual([
      "outer",
      "shape-1",
      "shape-2",
    ]);
    expect(
      session.snapshot().document.elements.find(({ id }) => id === "inner"),
    ).toMatchObject({ childrenIds: [] });
    expect(
      session.snapshot().document.elements.find(({ id }) => id === "shape-1"),
    ).toMatchObject({
      transform: [8, 0, 0, 15, 36, 86],
      visible: false,
    });
    expect(session.snapshot().document.tracks).toEqual(input.tracks);
  });

  it("rejects unsupported root reparent requests atomically", () => {
    const session = createCommandSession("document-1", document());
    const before = session.snapshot();
    const cases: Array<[unknown, string]> = [
      [{}, "MALFORMED_COMMAND"],
      [
        {
          ...reparentCommand("shape-1", 0),
          payload: {
            ...reparentCommand("shape-1", 0).payload,
            parentId: "group-1",
          },
        },
        "TARGET_NOT_FOUND",
      ],
      [reparentCommand("shape-1", 0.5), "MALFORMED_COMMAND"],
      [reparentCommand("shape-1", 1), "INVALID_CANDIDATE"],
      [reparentCommand("missing", 0), "TARGET_NOT_FOUND"],
      [
        { ...reparentCommand("shape-1", 0), documentId: "other" },
        "DOCUMENT_MISMATCH",
      ],
      [reparentCommand("shape-1", 0, 1), "REVISION_CONFLICT"],
    ];
    for (const [request, code] of cases) {
      expect(session.dispatch(request)).toEqual({ ok: false, error: { code } });
      expect(session.snapshot()).toEqual(before);
    }
  });

  it("reparents a root element into a nested group with its world affine and tracks", () => {
    const input = document();
    input.rootIds = ["shape-1", "outer", "outer-2"];
    input.elements[0]!.transform = [3, 0, 0, 6, 9, 11];
    input.elements[0]!.visible = false;
    input.elements.push(
      {
        id: "outer",
        type: "group",
        childrenIds: ["target"],
        transform: [2, 0, 0, 3, 10, 20],
      },
      {
        id: "target",
        type: "group",
        childrenIds: [],
        transform: [4, 0, 0, 5, 1, 2],
      },
      {
        id: "outer-2",
        type: "group",
        childrenIds: ["target-2"],
        transform: [3, 0, 0, 2, 5, 7],
      },
      {
        id: "target-2",
        type: "group",
        childrenIds: [],
        transform: [2, 0, 0, 4, 1, 3],
      },
    );
    const session = createCommandSession("document-1", input);
    const before = session.snapshot().document;

    expect(
      session.dispatch(groupReparentCommand("shape-1", "target", 0)),
    ).toMatchObject({ ok: true, revision: 1 });
    const afterRootMove = session.snapshot().document;
    expect(afterRootMove.rootIds).toEqual(["outer", "outer-2"]);
    expect(
      afterRootMove.elements.find(({ id }) => id === "target"),
    ).toMatchObject({ childrenIds: ["shape-1"] });
    expect(
      afterRootMove.elements.find(({ id }) => id === "shape-1"),
    ).toMatchObject({
      transform: [0.375, 0, 0, 0.4, -0.375, -1],
      visible: false,
    });

    expect(
      session.dispatch(groupReparentCommand("shape-1", "target-2", 0, 1)),
    ).toMatchObject({ ok: true, revision: 2 });
    const after = session.snapshot().document;
    expect(after.elements.find(({ id }) => id === "target")).toMatchObject({
      childrenIds: [],
    });
    expect(after.elements.find(({ id }) => id === "target-2")).toMatchObject({
      childrenIds: ["shape-1"],
    });
    expect(after.elements.find(({ id }) => id === "shape-1")).toMatchObject({
      transform: [0.5, 0, 0, 0.75, 0.16666666666666674, -0.25],
      visible: false,
    });
    expect(after.tracks).toEqual(before.tracks);
    expect(session.undo()).toMatchObject({ ok: true, revision: 3 });
    expect(session.snapshot().document).toEqual(afterRootMove);
    expect(session.redo()).toMatchObject({ ok: true, revision: 4 });
    expect(session.snapshot().document).toEqual(after);
    const canonical = canonicalizeSceneDocument(after).bytes;
    expect(
      canonicalizeSceneDocument(JSON.parse(new TextDecoder().decode(canonical)))
        .bytes,
    ).toEqual(canonical);
    const actors = ["human-ui", "browser-agent", "headless-agent"].map(
      (actor) =>
        createCommandSession("document-1", input).dispatch(
          groupReparentCommand("shape-1", "target", 0, 0, actor),
        ),
    );
    expect(actors[0]).toEqual(actors[1]);
    expect(actors[1]).toEqual(actors[2]);
  });

  it("reorders within a singular hidden group without changing local semantics", () => {
    const input = document();
    input.rootIds = ["group-1"];
    input.elements.push(
      {
        id: "line-2",
        type: "line",
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        opacity: 0.5,
      },
      {
        id: "group-1",
        type: "group",
        childrenIds: ["shape-1", "line-2"],
        transform: [0, 0, 0, 0, 4, 5],
        visible: false,
      },
    );
    input.elements[0]!.transform = [3, 1, 2, 4, 5, 6];
    const session = createCommandSession("document-1", input);

    expect(
      session.dispatch(groupReparentCommand("shape-1", "group-1", 1)),
    ).toMatchObject({ ok: true, revision: 1 });
    expect(
      session.snapshot().document.elements.find(({ id }) => id === "group-1"),
    ).toMatchObject({ childrenIds: ["line-2", "shape-1"] });
    expect(
      session.snapshot().document.elements.find(({ id }) => id === "shape-1"),
    ).toMatchObject({ transform: [3, 1, 2, 4, 5, 6] });
    expect(
      "visible" in
        (session
          .snapshot()
          .document.elements.find(({ id }) => id === "shape-1") ?? {}),
    ).toBe(false);
  });

  it("rejects unsafe group destinations atomically without calling an ID source", () => {
    const base = document();
    base.rootIds = ["shape-1", "target"];
    base.elements.push({ id: "target", type: "group", childrenIds: [] });
    let calls = 0;
    const session = createCommandSession("document-1", base, () => {
      calls += 1;
      return { kind: "id", id: "unused" };
    });
    const before = session.snapshot();
    const requests: Array<[unknown, string]> = [
      [{}, "MALFORMED_COMMAND"],
      [groupReparentCommand("shape-1", "target", 0.5), "MALFORMED_COMMAND"],
      [groupReparentCommand("shape-1", "target", 1), "INVALID_CANDIDATE"],
      [groupReparentCommand("shape-1", "missing", 0), "TARGET_NOT_FOUND"],
      [groupReparentCommand("shape-1", "shape-1", 0), "INVALID_CANDIDATE"],
      [
        {
          ...groupReparentCommand("shape-1", "target", 0),
          documentId: "other",
        },
        "DOCUMENT_MISMATCH",
      ],
      [groupReparentCommand("shape-1", "target", 0, 1), "REVISION_CONFLICT"],
    ];
    for (const [request, code] of requests) {
      expect(session.dispatch(request)).toEqual({ ok: false, error: { code } });
      expect(session.snapshot()).toEqual(before);
    }
    expect(calls).toBe(0);

    const singular = structuredClone(base);
    (
      singular.elements.find(({ id }) => id === "target") as {
        transform: number[];
      }
    ).transform = [0, 0, 0, 0, 0, 0];
    const singularSession = createCommandSession("document-1", singular);
    expect(
      singularSession.dispatch(groupReparentCommand("shape-1", "target", 0)),
    ).toEqual({ ok: false, error: { code: "INVALID_CANDIDATE" } });

    const hidden = structuredClone(base);
    (
      hidden.elements.find(({ id }) => id === "target") as { visible: boolean }
    ).visible = false;
    const hiddenSession = createCommandSession("document-1", hidden);
    expect(
      hiddenSession.dispatch(groupReparentCommand("shape-1", "target", 0)),
    ).toEqual({ ok: false, error: { code: "INVALID_CANDIDATE" } });

    const cycle = document();
    cycle.rootIds = ["outer", "shape-1"];
    cycle.elements.push(
      { id: "outer", type: "group", childrenIds: ["inner"] },
      { id: "inner", type: "group", childrenIds: [] },
    );
    const cycleSession = createCommandSession("document-1", cycle);
    expect(
      cycleSession.dispatch(groupReparentCommand("outer", "inner", 0)),
    ).toEqual({ ok: false, error: { code: "INVALID_CANDIDATE" } });
  });

  it("rejects a distinct non-group reparent destination atomically", () => {
    const input = document();
    input.rootIds.push("shape-2");
    input.elements.push({
      id: "shape-2",
      type: "shape",
      x: 5,
      y: 6,
      width: 7,
      height: 8,
      opacity: 0.5,
    });
    const session = createCommandSession("document-1", input);
    const before = session.snapshot();

    expect(
      session.dispatch(groupReparentCommand("shape-1", "shape-2", 0)),
    ).toEqual({ ok: false, error: { code: "INVALID_CANDIDATE" } });
    expect(session.snapshot()).toEqual(before);
  });

  it("rejects finite transforms that overflow composition or inversion atomically", () => {
    const transforms: Array<{
      readonly child: number[];
      readonly source: number[];
      readonly target: number[];
    }> = [
      {
        child: [1e308, 0, 0, 1, 0, 0],
        source: [1e308, 0, 0, 1, 0, 0],
        target: [1, 0, 0, 1, 0, 0],
      },
      {
        child: [1, 0, 0, 1, 0, 0],
        source: [1, 0, 0, 1, 0, 0],
        target: [Number.MIN_VALUE, 0, 0, 1, 0, 0],
      },
    ];

    for (const { child, source, target } of transforms) {
      const input = document();
      input.rootIds = ["source", "target"];
      input.elements[0]!.transform = child;
      input.elements.push(
        {
          id: "source",
          type: "group",
          childrenIds: ["shape-1"],
          transform: source,
        },
        { id: "target", type: "group", childrenIds: [], transform: target },
      );
      const session = createCommandSession("document-1", input);
      const before = session.snapshot();

      expect(
        session.dispatch(groupReparentCommand("shape-1", "target", 0)),
      ).toEqual({ ok: false, error: { code: "INVALID_CANDIDATE" } });
      expect(session.snapshot()).toEqual(before);
    }
  });

  it("keeps equivalent actor mutations equal and advances undo and redo revisions", () => {
    const states = ["human-ui", "browser-agent", "headless-agent"].map(
      (actor) => {
        const result = createCommandSession("document-1", document()).dispatch(
          command(0.25, 0, actor),
        );
        return result.ok ? result.document : result;
      },
    );
    expect(states[0]).toEqual(states[1]);
    expect(states[1]).toEqual(states[2]);

    let sourceCalls = 0;
    const session = createCommandSession("document-1", document(), () => {
      sourceCalls += 1;
      return { kind: "id", id: "unused" };
    });
    expect(session.undo().ok).toBe(false);
    expect(session.redo().ok).toBe(false);
    expect(mutate(session.dispatch(command(0.2)))).toMatchObject({
      ok: true,
      revision: 1,
    });
    expect(sourceCalls).toBe(0);
    expect(
      mutate(session.dispatch(command(0.8, 1, "human-ui", 1_000_000))),
    ).toMatchObject({ ok: true, revision: 2 });
    expect(mutate(session.undo())).toMatchObject({ ok: true, revision: 3 });
    expect(firstValue(session)).toBe(0.2);
    expect(secondValue(session)).toBe(0.75);
    expect(mutate(session.redo())).toMatchObject({ ok: true, revision: 4 });
    expect(firstValue(session)).toBe(0.2);
    expect(secondValue(session)).toBe(0.8);
    expect(mutate(session.undo())).toMatchObject({ ok: true, revision: 5 });
    expect(secondValue(session)).toBe(0.75);
    expect(
      mutate(session.dispatch(command(0.6, 5, "human-ui", 1_000_000))),
    ).toMatchObject({ ok: true, revision: 6 });
    expect(secondValue(session)).toBe(0.6);
    expect(session.redo()).toEqual({
      ok: false,
      error: { code: "NOTHING_TO_REDO" },
    });
  });

  it("forks document, revision, and undo/redo topology without coupling later operations", () => {
    const parent = createCommandSession("document-1", document());
    expect(parent.dispatch(command(0.2))).toMatchObject({
      ok: true,
      revision: 1,
    });
    expect(
      parent.dispatch(command(0.8, 1, "human-ui", 1_000_000)),
    ).toMatchObject({
      ok: true,
      revision: 2,
    });
    expect(parent.undo()).toMatchObject({ ok: true, revision: 3 });

    const fork = parent.fork();
    expect(fork.snapshot()).toEqual(parent.snapshot());
    expect(fork.redo()).toMatchObject({ ok: true, revision: 4 });
    expect(secondValue(fork)).toBe(0.8);
    expect(secondValue(parent)).toBe(0.75);
    expect(fork.undo()).toMatchObject({ ok: true, revision: 5 });
    expect(fork.dispatch(command(0.6, 5, "human-ui", 1_000_000))).toMatchObject(
      { ok: true, revision: 6 },
    );
    expect(parent.redo()).toMatchObject({ ok: true, revision: 4 });
    expect(secondValue(parent)).toBe(0.8);
    expect(secondValue(fork)).toBe(0.6);
    expect(parent.undo()).toMatchObject({ ok: true, revision: 5 });
    expect(secondValue(parent)).toBe(0.75);
    expect(secondValue(fork)).toBe(0.6);
  });

  it("shares its non-reversible ID source across isolated nested forks", () => {
    const ids = ["fork-shape", "nested-group", "parent-shape"];
    let calls = 0;
    const parent = createCommandSession("document-1", document(), () => {
      const id = ids[calls];
      calls += 1;
      return { kind: "id", id: id! };
    });
    const fork = parent.fork();
    expect(
      fork.dispatch(createCommand({ type: "group", childrenIds: [] })),
    ).toMatchObject({ ok: true, revision: 1 });
    const nested = fork.fork();
    expect(
      nested.dispatch(createCommand({ type: "group", childrenIds: [] }, 1)),
    ).toMatchObject({ ok: true, revision: 2 });
    expect(
      parent.dispatch(createCommand({ type: "group", childrenIds: [] })),
    ).toMatchObject({ ok: true, revision: 1 });
    expect(calls).toBe(3);
    expect(parent.snapshot().document.rootIds).toEqual([
      "shape-1",
      "parent-shape",
    ]);
    expect(fork.snapshot().document.rootIds).toEqual(["shape-1", "fork-shape"]);
    expect(nested.snapshot().document.rootIds).toEqual([
      "shape-1",
      "fork-shape",
      "nested-group",
    ]);
    expect(fork.undo()).toMatchObject({ ok: true, revision: 2 });
    expect(fork.redo()).toMatchObject({ ok: true, revision: 3 });
    expect(calls).toBe(3);
    expect(parent.snapshot().document.rootIds).toEqual([
      "shape-1",
      "parent-shape",
    ]);
  });

  it("edits a text step track atomically and retains its last key", () => {
    const input = document();
    input.rootIds.push("text-1");
    input.elements.push({
      id: "text-1",
      type: "text",
      text: "before",
      x: 4,
      y: 8,
      fontSize: 16,
      opacity: 1,
    });
    const session = createCommandSession("document-1", input);
    const dispatch = (payload: Record<string, unknown>, revision: number) =>
      session.dispatch({
        commandSchemaVersion: 1,
        commandId: `timeline-${revision}`,
        documentId: "document-1",
        expectedRevision: revision,
        actorCapability: "human-ui",
        payload,
      });

    expect(
      dispatch(
        {
          type: "create-track",
          elementId: "text-1",
          property: "text.text",
          interpolation: "step",
          keyframe: { timeUs: 0, value: "before" },
        },
        0,
      ),
    ).toMatchObject({ ok: true, revision: 1 });
    expect(
      dispatch(
        {
          type: "create-keyframe",
          elementId: "text-1",
          property: "text.text",
          keyframe: { timeUs: 750_000, value: "after" },
        },
        1,
      ),
    ).toMatchObject({ ok: true, revision: 2 });
    expect(
      dispatch(
        {
          type: "change-keyframe",
          elementId: "text-1",
          property: "text.text",
          timeUs: 750_000,
          value: "changed",
        },
        2,
      ),
    ).toMatchObject({ ok: true, revision: 3 });
    expect(
      dispatch(
        {
          type: "move-keyframe",
          elementId: "text-1",
          property: "text.text",
          fromTimeUs: 750_000,
          toTimeUs: 500_000,
        },
        3,
      ),
    ).toMatchObject({ ok: true, revision: 4 });
    expect(session.snapshot().document.tracks.at(-1)?.keyframes).toEqual([
      { timeUs: 0, value: "before" },
      { timeUs: 500_000, value: "changed" },
    ]);
    expect(
      dispatch(
        {
          type: "remove-keyframe",
          elementId: "text-1",
          property: "text.text",
          timeUs: 500_000,
        },
        4,
      ),
    ).toMatchObject({ ok: true, revision: 5 });
    const beforeLastKey = session.snapshot();
    expect(
      dispatch(
        {
          type: "remove-keyframe",
          elementId: "text-1",
          property: "text.text",
          timeUs: 0,
        },
        5,
      ),
    ).toEqual({ ok: false, error: { code: "LAST_KEYFRAME" } });
    expect(session.snapshot()).toEqual(beforeLastKey);
    expect(
      dispatch(
        { type: "remove-track", elementId: "text-1", property: "text.text" },
        5,
      ),
    ).toMatchObject({ ok: true, revision: 6 });
    const removed = session.snapshot().document;
    expect(session.undo()).toMatchObject({ ok: true, revision: 7 });
    expect(session.redo()).toMatchObject({ ok: true, revision: 8 });
    expect(session.snapshot().document).toEqual(removed);
    const bytes = canonicalizeSceneDocument(removed).bytes;
    expect(
      canonicalizeSceneDocument(JSON.parse(new TextDecoder().decode(bytes)))
        .bytes,
    ).toEqual(bytes);
  });
});
