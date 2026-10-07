import { describe, expect, it } from "vitest";
import { createCommandSession, type CommandSession } from "@particle-studio/commands";
import { FIRST_SLICE_DOCUMENT, type SceneDocumentV1 } from "@particle-studio/scene-document";

function shape(doc: SceneDocumentV1, id: string) {
  const element = doc.elements.find((candidate) => candidate.id === id);
  if (!element || element.type !== "shape") throw new Error("Invalid test target");
  return element;
}

function document(): SceneDocumentV1 {
  const doc = structuredClone(FIRST_SLICE_DOCUMENT) as SceneDocumentV1;
  doc.playbackRange = { startUs: 100, endUs: 900_000 };
  doc.elements[0]!.transform = [1, 0.5, 0, 2, 10, -20];
  doc.elements[0]!.visible = false;
  shape(doc, "shape-1").fillColor = "#3FA9F5";
  doc.rootIds.push("group-1", "line-1", "particle-1", "text-1", "image-1");
  doc.elements.push(
    { id: "group-1", type: "group", childrenIds: ["nested-shape"], transform: [0, 2, -3, 0, 100, 200], visible: false },
    { id: "nested-shape", type: "shape", x: 8, y: -9, width: 31, height: 47, opacity: 0.6, transform: [1, 0, 0.5, 1, -7, 11], visible: true, fillColor: "#00ff00" },
    { id: "line-1", type: "line", x1: 1, y1: 2, x2: 3, y2: 4, opacity: 0.5 },
    { id: "particle-1", type: "particle", count: 2, x: 5, y: 6, velocityX: 3, velocityY: 4, spread: 1, size: 2, opacity: 0.5, lifetimeSteps: 12 },
    { id: "text-1", type: "text", text: "Keep this text", x: 7, y: 8, fontSize: 12, opacity: 0.75 },
    { id: "image-1", type: "image", x: 9, y: 10, width: 32, height: 16, opacity: 0.8, visible: true, asset: { sha256: `sha256:${"a".repeat(64)}`, mimeType: "image/png", byteLength: 120, intrinsicWidth: 64, intrinsicHeight: 32 } },
  );
  doc.tracks.push({ elementId: "text-1", property: "text.text", interpolation: "step", keyframes: [{ timeUs: 0, value: "Keep this text" }] });
  return doc;
}

const payload = (elementId = "shape-1", visible = true) => ({ type: "set-shape-visibility", elementId, visible });
const command = (body: unknown = payload(), expectedRevision = 0) => ({
  commandSchemaVersion: 1,
  commandId: "visibility-command",
  documentId: "document-1",
  expectedRevision,
  actorCapability: "human-ui",
  payload: body,
});
const keyframeCommand = (value: number, revision: number) => command({ type: "set-keyframe-value", trackId: "shape-1:opacity", keyframeId: "shape-1:opacity:0", value }, revision);

function withVisibility(doc: SceneDocumentV1, id: string, visible?: boolean) {
  const expected = structuredClone(doc);
  const target = shape(expected, id);
  if (visible === undefined) delete target.visible;
  else target.visible = visible;
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
  const changed = withVisibility(first, "shape-1", true);
  assertState(session, session.dispatch(command(payload(), 7)), 8, changed);
  expect(session.redo()).toEqual({ ok: false, error: { code: "NOTHING_TO_REDO" } });
  assertState(session, session.undo(), 9, first);
  assertState(session, session.redo(), 10, changed);
  expect(original).toStrictEqual(document());
  expect(idCalls).toBe(0);
}

const inheritedFields = ["type", "elementId", "visible"] as const;
const inheritedPayloads = inheritedFields.map((field): [string, unknown] => {
  const values: Record<string, unknown> = { type: "set-shape-visibility", elementId: "shape-1", visible: true };
  const own: Record<string, unknown> = { world: true };
  for (const key of inheritedFields) if (key !== field) own[key] = values[key];
  return [`inherited ${field}`, Object.assign(Object.create({ [field]: values[field] }), own)];
});

const badVisible: Array<[string, unknown]> = [
  ["visible: string true", { ...payload(), visible: "true" }],
  ["visible: string false", { ...payload(), visible: "false" }],
  ["visible: 0", { ...payload(), visible: 0 }],
  ["visible: 1", { ...payload(), visible: 1 }],
  ["visible: null", { ...payload(), visible: null }],
  ["visible: undefined", { ...payload(), visible: undefined }],
  ["visible: NaN", { ...payload(), visible: NaN }],
  ["visible: array", { ...payload(), visible: [] }],
  ["visible: object", { ...payload(), visible: {} }],
  ["visible: Boolean object", { ...payload(), visible: new Boolean(false) }],
];

const malformedPayloads: Array<[string, unknown]> = [
  ["unknown type", { ...payload(), type: "set-shape-visibility-unknown" }],
  ["empty element ID", { ...payload(), elementId: "" }],
  ["nonstring element ID", { ...payload(), elementId: 0 }],
  ["missing type", { elementId: "shape-1", visible: true }],
  ["missing element ID", { type: "set-shape-visibility", visible: true }],
  ["missing visible", { type: "set-shape-visibility", elementId: "shape-1" }],
  ...badVisible,
  ["extra key", { ...payload(), world: true }],
  ["non-enumerable visible with an extra key", Object.defineProperty({ ...payload(), world: true }, "visible", { enumerable: false })],
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

const visibilityCases: Array<[string, boolean | undefined, boolean]> = [];
for (const id of ["shape-1", "nested-shape"]) {
  for (const before of [undefined, true, false] as const) {
    for (const after of [true, false]) visibilityCases.push([id, before, after]);
  }
}
const equalCases: Array<[string, boolean]> = [
  ["shape-1", true], ["shape-1", false],
  ["nested-shape", true], ["nested-shape", false],
];

describe("set-shape-visibility", () => {
  it.each(visibilityCases)(
    "sets visible on %s from %s to %s, preserving the full document and history",
    (id, before, after) => {
      const input = withVisibility(document(), id, before);
      const original = structuredClone(input);
      let idCalls = 0;
      const session = createCommandSession("document-1", input, () => {
        idCalls += 1;
        return { kind: "id", id: "" };
      });
      expect(session.snapshot()).toStrictEqual({ revision: 0, document: original });
      const expected = withVisibility(original, id, after);
      assertState(session, session.dispatch(command(payload(id, after))), 1, expected);
      expect(input).toStrictEqual(original);
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

  it.each(equalCases)(
    "records an equal visible value on %s (%s) as an edit that clears redo",
    (id, visible) => {
      const original = withVisibility(document(), id, visible);
      const session = createCommandSession("document-1", original);
      assertState(session, session.dispatch(command(payload(id, visible))), 1, original);
      assertState(session, session.dispatch(command(payload(id, visible), 1)), 2, original);
      assertState(session, session.undo(), 3, original);
      assertState(session, session.undo(), 4, original);
      expect(session.undo()).toEqual({ ok: false, error: { code: "NOTHING_TO_UNDO" } });
      assertState(session, session.redo(), 5, original);
      assertState(session, session.redo(), 6, original);
      expect(session.redo()).toEqual({ ok: false, error: { code: "NOTHING_TO_REDO" } });
      assertState(session, session.undo(), 7, original);
      assertState(session, session.dispatch(command(payload(id, visible), 7)), 8, original);
      expect(session.redo()).toEqual({ ok: false, error: { code: "NOTHING_TO_REDO" } });
      assertState(session, session.undo(), 9, original);
      assertState(session, session.redo(), 10, original);
    },
  );

  it("forks and detaches inputs, results, snapshots, and payloads", () => {
    const original = document();
    const before = structuredClone(original);
    const changed = withVisibility(before, "shape-1", true);
    let idCalls = 0;
    const session = createCommandSession("document-1", original, () => {
      idCalls += 1;
      return { kind: "unavailable" };
    });
    const body = payload("shape-1", true);
    const result = session.dispatch(command(body));
    assertState(session, result, 1, changed);
    expect(original).toStrictEqual(before);
    if (!result.ok) throw new Error("Expected supported human-ui command");
    const snapshot = session.snapshot();
    const fork = session.fork();
    assertState(fork, fork.undo(), 2, before);
    expect(session.snapshot()).toStrictEqual({ revision: 1, document: changed });
    assertState(fork, fork.redo(), 3, changed);
    body.visible = false;
    for (const detached of [original, result.document, snapshot.document]) {
      const target = detached.elements.find((element) => element.id === "nested-shape");
      if (!target || target.type !== "shape") throw new Error("Invalid test shape");
      target.visible = false;
      target.fillColor = "#111111";
      target.transform![0] = 7;
      const image = detached.elements.find((element) => element.type === "image");
      if (!image || image.type !== "image") throw new Error("Invalid test image");
      image.asset.byteLength = 999;
      const group = detached.elements.find((element) => element.type === "group");
      if (!group || group.type !== "group") throw new Error("Invalid test group");
      group.childrenIds.push("detached-only");
      detached.playbackRange.startUs = 200;
      detached.rootIds.reverse();
      detached.tracks[0]!.keyframes[0]!.value = 0.9;
    }
    expect(session.snapshot()).toStrictEqual({ revision: 1, document: changed });
    assertState(session, session.undo(), 2, before);
    assertState(session, session.redo(), 3, changed);
    assertState(fork, fork.undo(), 4, before);
    expect(session.snapshot()).toStrictEqual({ revision: 3, document: changed });
    expect(idCalls).toBe(0);
  });
});
