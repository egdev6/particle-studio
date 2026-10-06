import { describe, expect, it } from "vitest";
import { createCommandSession, type CommandSession } from "@particle-studio/commands";
import { FIRST_SLICE_DOCUMENT, type SceneDocumentV1 } from "@particle-studio/scene-document";

function document(): SceneDocumentV1 {
  const doc = structuredClone(FIRST_SLICE_DOCUMENT) as SceneDocumentV1;
  doc.playbackRange = { startUs: 100, endUs: 900_000 };
  doc.elements[0]!.transform = [1, 0.5, 0, 2, 10, -20];
  doc.elements[0]!.visible = false;
  doc.rootIds.push("group-1", "line-1", "particle-1", "text-1", "image-1");
  doc.elements.push(
    {
      id: "group-1", type: "group", childrenIds: ["nested-shape"],
      transform: [0, 2, -3, 0, 100, 200], visible: true,
    },
    {
      id: "nested-shape", type: "shape", x: 8, y: -9,
      width: 31, height: 47, opacity: 0.6,
      transform: [1, 0, 0.5, 1, -7, 11], visible: false,
    },
    {
      id: "line-1", type: "line", x1: 1, y1: 2, x2: 3, y2: 4,
      opacity: 0.5,
    },
    {
      id: "particle-1", type: "particle", count: 2, x: 5, y: 6,
      velocityX: 3, velocityY: 4, spread: 1, size: 2,
      opacity: 0.5, lifetimeSteps: 12,
    },
    {
      id: "text-1", type: "text", text: "Keep this text", x: 7, y: 8,
      fontSize: 12, opacity: 0.75,
    },
    {
      id: "image-1", type: "image", x: 9, y: 10,
      width: 32, height: 16, opacity: 0.8, visible: true,
      asset: {
        sha256: `sha256:${"a".repeat(64)}`, mimeType: "image/png",
        byteLength: 120, intrinsicWidth: 64, intrinsicHeight: 32,
      },
    },
  );
  doc.tracks.push({
    elementId: "text-1", property: "text.text", interpolation: "step",
    keyframes: [{ timeUs: 0, value: "Keep this text" }],
  });
  return doc;
}

const payload = (elementId = "shape-1", fillColor = "#3fa9f5") => ({
  type: "set-shape-fill-color", elementId, fillColor,
});
const command = (body: unknown = payload(), expectedRevision = 0) => ({
  commandSchemaVersion: 1,
  commandId: "fill-color-command",
  documentId: "document-1",
  expectedRevision,
  actorCapability: "human-ui",
  payload: body,
});
const keyframeCommand = (value: number, revision: number) => command({
  type: "set-keyframe-value", trackId: "shape-1:opacity",
  keyframeId: "shape-1:opacity:0", value,
}, revision);

function withFillColor(doc: SceneDocumentV1, id: string, fillColor?: string) {
  const expected = structuredClone(doc);
  const shape = expected.elements.find((element) => element.id === id);
  if (!shape || shape.type !== "shape") throw new Error("Invalid test target");
  if (fillColor === undefined) delete shape.fillColor;
  else shape.fillColor = fillColor;
  return expected;
}

function assertState(
  session: CommandSession,
  result: ReturnType<CommandSession["dispatch"]>,
  revision: number,
  expected: SceneDocumentV1,
) {
  expect(result).toStrictEqual({ ok: true, revision, document: expected });
  expect(session.snapshot()).toStrictEqual({ revision, document: expected });
}

// Every rejection is exercised with both an undo entry and a redo entry.
function assertRejected(request: unknown, code: string) {
  const original = document();
  const first = structuredClone(original);
  first.tracks[0]!.keyframes[0]!.value = 0.4;
  const second = structuredClone(first);
  second.tracks[0]!.keyframes[0]!.value = 0.6;
  let idCalls = 0;
  const session = createCommandSession("document-1", original, () => {
    idCalls += 1;
    return { kind: "unavailable" };
  });
  assertState(session, session.dispatch(keyframeCommand(0.4, 0)), 1, first);
  assertState(session, session.dispatch(keyframeCommand(0.6, 1)), 2, second);
  assertState(session, session.undo(), 3, first);

  expect(session.dispatch(request)).toEqual({ ok: false, error: { code } });
  expect(session.snapshot()).toStrictEqual({ revision: 3, document: first });
  assertState(session, session.undo(), 4, original);
  expect(session.undo()).toEqual({ ok: false, error: { code: "NOTHING_TO_UNDO" } });
  assertState(session, session.redo(), 5, first);
  assertState(session, session.redo(), 6, second);
  assertState(session, session.undo(), 7, first);
  const changed = withFillColor(first, "shape-1", "#3fa9f5");
  assertState(session, session.dispatch(command(payload(), 7)), 8, changed);
  expect(session.redo()).toEqual({ ok: false, error: { code: "NOTHING_TO_REDO" } });
  assertState(session, session.undo(), 9, first);
  assertState(session, session.redo(), 10, changed);
  expect(original).toEqual(document());
  expect(idCalls).toBe(0);
}

// The existing checker accepts inherited required fields; fill color must not.
const inheritedFields = ["type", "elementId", "fillColor"] as const;
const inheritedPayloads = inheritedFields.map((field): [string, unknown] => {
  const values: Record<string, unknown> = {
    type: "set-shape-fill-color", elementId: "shape-1", fillColor: "#3fa9f5",
  };
  const own: Record<string, unknown> = { world: true };
  for (const key of inheritedFields) if (key !== field) own[key] = values[key];
  return [
    `inherited ${field}`,
    Object.assign(Object.create({ [field]: values[field] }), own),
  ];
});

const malformedPayloads: Array<[string, unknown]> = [
  ["missing type", { elementId: "shape-1", fillColor: "#3fa9f5" }],
  ["unknown type", { ...payload(), type: "set-fill-color" }],
  ["empty element ID", { ...payload(), elementId: "" }],
  ["nonstring element ID", { ...payload(), elementId: 1 }],
  ["missing element ID", { type: "set-shape-fill-color", fillColor: "#3fa9f5" }],
  ["missing fillColor", { type: "set-shape-fill-color", elementId: "shape-1" }],
  ["extra ID", { ...payload(), id: "replacement-id" }],
  ["unknown key", { ...payload(), world: true }],
  ["non-enumerable fillColor with an extra key", Object.defineProperty(
    { ...payload(), world: true }, "fillColor", { enumerable: false },
  )],
  ["color: three-digit hex shorthand", { ...payload(), fillColor: "#3a9" }],
  ["color: eight-digit hex with alpha", { ...payload(), fillColor: "#3fa9f5ff" }],
  ["color: named CSS color", { ...payload(), fillColor: "rebeccapurple" }],
  ["color: non-hex character", { ...payload(), fillColor: "#3fa9fg" }],
  ["color: leading whitespace", { ...payload(), fillColor: " #3fa9f5" }],
  ["color: trailing whitespace", { ...payload(), fillColor: "#3fa9f5 " }],
  ["color: final newline", { ...payload(), fillColor: "#3fa9f5\n" }],
  ["color: a number", { ...payload(), fillColor: 0x3fa9f5 }],
  ["color: null", { ...payload(), fillColor: null }],
  ["color: boolean", { ...payload(), fillColor: true }],
  ["color: an array", { ...payload(), fillColor: ["#3fa9f5"] }],
  ["color: an object", { ...payload(), fillColor: { hex: "#3fa9f5" } }],
  ...inheritedPayloads,
];

const malformedEnvelopes: Array<[string, Record<string, unknown>]> = [
  ["browser agent", { actorCapability: "browser-agent" }],
  ["headless agent", { actorCapability: "headless-agent" }],
  ["unknown actor", { actorCapability: "robot" }],
  ["absent actor", { actorCapability: undefined }],
  ["null actor", { actorCapability: null }],
];

const rejectedTargets: Array<[string, string]> = [
  ["missing-shape", "TARGET_NOT_FOUND"],
  [" ", "TARGET_NOT_FOUND"],
  ["line-1", "INVALID_CANDIDATE"],
  ["group-1", "INVALID_CANDIDATE"],
  ["particle-1", "INVALID_CANDIDATE"],
  ["text-1", "INVALID_CANDIDATE"],
  ["image-1", "INVALID_CANDIDATE"],
];

const successfulColors: Array<[string, string | undefined, string]> = [
  ["shape-1", undefined, "#3fa9f5"],
  ["shape-1", undefined, "#3FA9F5"],
  ["nested-shape", undefined, "#00ff00"],
  ["shape-1", "#3fa9f5", "#3FA9F5"],
  ["nested-shape", "#000000", "#ffffff"],
];

describe("set-shape-fill-color", () => {
  it.each(["human-ui", "browser-agent", "headless-agent"])(
    "retains healthy keyframe history for %s",
    (actorCapability) => {
      const original = document();
      const expected = structuredClone(original);
      expected.tracks[0]!.keyframes[0]!.value = 0.4;
      const session = createCommandSession("document-1", original);
      assertState(session, session.dispatch({
        ...keyframeCommand(0.4, 0), actorCapability,
      }), 1, expected);
      assertState(session, session.undo(), 2, original);
      assertState(session, session.redo(), 3, expected);
    },
  );

  it.each(successfulColors)(
    "sets authored fill color on %s from %s to %s, preserving and restoring the full document",
    (id, initial, fillColor) => {
      const input = withFillColor(document(), id, initial);
      if (initial === undefined) expect(input).toEqual(document());
      const original = structuredClone(input);
      let idCalls = 0;
      const session = createCommandSession("document-1", input, () => {
        idCalls += 1;
        return { kind: "id", id: "" };
      });
      expect(session.snapshot()).toStrictEqual({ revision: 0, document: original });
      const expected = withFillColor(original, id, fillColor);
      assertState(session, session.dispatch(command(payload(id, fillColor))), 1, expected);
      expect(input).toEqual(original);
      assertState(session, session.undo(), 2, original);
      expect(session.undo()).toEqual({ ok: false, error: { code: "NOTHING_TO_UNDO" } });
      assertState(session, session.redo(), 3, expected);
      expect(session.redo()).toEqual({ ok: false, error: { code: "NOTHING_TO_REDO" } });
      expect(idCalls).toBe(0);
    },
  );

  it.each(malformedPayloads)("rejects malformed payload: %s", (_label, body) => {
    assertRejected(command(body, 3), "MALFORMED_COMMAND");
  });

  it.each(malformedEnvelopes)("rejects envelope: %s", (label, overrides) => {
    const request: Record<string, unknown> = { ...command(payload(), 3), ...overrides };
    if (label === "absent actor") delete request.actorCapability;
    assertRejected(request, "MALFORMED_COMMAND");
  });

  it.each(rejectedTargets)("rejects target %s with %s", (id, code) => {
    assertRejected(command(payload(id), 3), code);
  });

  it("checks document identity before editing", () => {
    assertRejected({ ...command(payload(), 3), documentId: "other-document" }, "DOCUMENT_MISMATCH");
  });

  it.each([2, 4])("checks conflicting revision %s before editing", (revision) => {
    assertRejected(command(payload(), revision), "REVISION_CONFLICT");
  });

  it.each(["shape-1", "nested-shape"])(
    "records a case change on %s as an edit and an equal color as an undo entry",
    (id) => {
      const original = withFillColor(document(), id, "#3fa9f5");
      const changed = withFillColor(original, id, "#3FA9F5");
      const session = createCommandSession("document-1", original);
      assertState(session, session.dispatch(command(payload(id, "#3FA9F5"))), 1, changed);
      assertState(session, session.dispatch(command(payload(id, "#3FA9F5"), 1)), 2, changed);
      assertState(session, session.undo(), 3, changed);
      assertState(session, session.undo(), 4, original);
      expect(session.undo()).toEqual({ ok: false, error: { code: "NOTHING_TO_UNDO" } });
      assertState(session, session.redo(), 5, changed);
      assertState(session, session.redo(), 6, changed);
      expect(session.redo()).toEqual({ ok: false, error: { code: "NOTHING_TO_REDO" } });
    },
  );

  it("forks and detaches inputs, results, and snapshots independently", () => {
    const original = document();
    const changed = withFillColor(original, "shape-1", "#3fa9f5");
    const nested = withFillColor(changed, "nested-shape", "#00ff00");
    const session = createCommandSession("document-1", original);
    assertState(session, session.dispatch(command()), 1, changed);
    assertState(session, session.dispatch(command(payload("nested-shape", "#00ff00"), 1)), 2, nested);
    assertState(session, session.undo(), 3, changed);
    const fork = session.fork();
    expect(fork.snapshot()).toStrictEqual({ revision: 3, document: changed });
    assertState(fork, fork.undo(), 4, original);
    expect(session.snapshot()).toStrictEqual({ revision: 3, document: changed });
    assertState(fork, fork.redo(), 5, changed);
    assertState(fork, fork.redo(), 6, nested);
    expect(session.snapshot()).toStrictEqual({ revision: 3, document: changed });
    const forkEdit = withFillColor(nested, "shape-1", "#ffffff");
    assertState(fork, fork.dispatch(command(payload("shape-1", "#ffffff"), 6)), 7, forkEdit);
    assertState(session, session.redo(), 4, nested);
    expect(fork.snapshot()).toStrictEqual({ revision: 7, document: forkEdit });
    assertState(session, session.undo(), 5, changed);
    expect(fork.snapshot()).toStrictEqual({ revision: 7, document: forkEdit });
    const input = document();
    const before = structuredClone(input);
    const expected = withFillColor(before, "shape-1", "#3fa9f5");
    const detachedSession = createCommandSession("document-1", input);
    const result = detachedSession.dispatch(command());
    assertState(detachedSession, result, 1, expected);
    expect(input).toEqual(before);
    if (!result.ok) throw new Error("Expected supported human-ui command");
    const snapshot = detachedSession.snapshot();
    for (const detached of [input, result.document, snapshot.document]) {
      const shape = detached.elements.find((element) => element.id === "nested-shape");
      if (!shape || shape.type !== "shape") throw new Error("Invalid test shape");
      shape.fillColor = "#111111";
      shape.transform![0] = 7;
      const image = detached.elements.find((element) => element.type === "image");
      if (!image || image.type !== "image") throw new Error("Invalid test image");
      image.asset.byteLength = 999;
      detached.playbackRange.startUs = 200;
      detached.rootIds.reverse();
      detached.tracks[0]!.keyframes[0]!.value = 0.9;
    }
    expect(detachedSession.snapshot()).toStrictEqual({ revision: 1, document: expected });
    assertState(detachedSession, detachedSession.undo(), 2, before);
    assertState(detachedSession, detachedSession.redo(), 3, expected);
  });
});
