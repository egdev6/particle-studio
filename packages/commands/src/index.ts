import {
  applyPatches,
  enablePatches,
  produceWithPatches,
  type Patch,
} from "immer";
import {
  validateSceneDocument,
  type SceneDocumentV1,
} from "@particle-studio/scene-document";

enablePatches();

type ErrorCode =
  | "MALFORMED_COMMAND"
  | "DOCUMENT_MISMATCH"
  | "REVISION_CONFLICT"
  | "TARGET_NOT_FOUND"
  | "INVALID_CANDIDATE"
  | "NOTHING_TO_UNDO"
  | "NOTHING_TO_REDO"
  | "ID_SOURCE_UNAVAILABLE"
  | "ID_SOURCE_INVALID"
  | "ID_COLLISION"
  | "LAST_KEYFRAME";

type Result =
  | {
      readonly ok: true;
      readonly revision: number;
      readonly document: SceneDocumentV1;
    }
  | { readonly ok: false; readonly error: { readonly code: ErrorCode } };

type Entry = { readonly forward: Patch[]; readonly inverse: Patch[] };
type SetKeyframeValuePayload = {
  readonly type: "set-keyframe-value";
  readonly trackId: string;
  readonly keyframeId: string;
  readonly value: number;
};
type CreateElementPayload = {
  readonly type: "create-element";
  readonly element: Record<string, unknown>;
};
type RemoveElementPayload = {
  readonly type: "remove-element";
  readonly elementId: string;
};
type ReplaceElementPayload = {
  readonly type: "replace-element";
  readonly elementId: string;
  readonly element: Record<string, unknown>;
};
type GroupElementsPayload = {
  readonly type: "group-elements";
  readonly elementIds: readonly string[];
};
type UngroupElementPayload = {
  readonly type: "ungroup-element";
  readonly groupId: string;
};
type ReparentElementPayload = {
  readonly type: "reparent-element";
  readonly elementId: string;
  readonly parentId: string | null;
  readonly position: number;
};
type TimelinePayload = {
  readonly type:
    | "create-track"
    | "remove-track"
    | "create-keyframe"
    | "change-keyframe"
    | "move-keyframe"
    | "remove-keyframe";
  readonly elementId: string;
  readonly property: "opacity" | "text.text";
  readonly interpolation?: "linear" | "step";
  readonly easing?: "linear" | "easeInQuad" | "easeOutQuad" | "easeInOutQuad";
  readonly keyframe?: { readonly timeUs: number; readonly value: unknown };
  readonly timeUs?: number;
  readonly fromTimeUs?: number;
  readonly toTimeUs?: number;
  readonly value?: unknown;
};
type Payload =
  | SetKeyframeValuePayload
  | TimelinePayload
  | CreateElementPayload
  | RemoveElementPayload
  | ReplaceElementPayload
  | GroupElementsPayload
  | UngroupElementPayload
  | ReparentElementPayload;
type Owner = {
  readonly groupId: string | null;
  readonly childrenIds: readonly string[];
};

export type ElementIdSourceResult =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "unavailable" };
export type ElementIdSource = () => ElementIdSourceResult;

export type CommandSession = {
  dispatch(command: unknown): Result;
  undo(): Result;
  redo(): Result;
  fork(): CommandSession;
  snapshot(): { readonly revision: number; readonly document: SceneDocumentV1 };
};

const error = (code: ErrorCode): Result => ({ ok: false, error: { code } });
// SAFETY: Node 24 and the supported browser baseline provide structuredClone.
const clone = <T>(value: T): T =>
  (globalThis as unknown as { structuredClone(value: T): T }).structuredClone(
    value,
  );
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown) => typeof value === "string" && value.length > 0;
const isStableElementId = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value);
const isCreateElementType = (value: unknown) =>
  value === "shape" ||
  value === "line" ||
  value === "group" ||
  value === "particle" ||
  value === "text" ||
  value === "image";
const trackId = (elementId: string) => `${elementId}:opacity`;
const keyframeId = (id: string, timeUs: number) => `${id}:${timeUs}`;
const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => key in value);
const isTimelineProperty = (value: unknown): value is "opacity" | "text.text" =>
  value === "opacity" || value === "text.text";
const isTimelineKeyframe = (
  value: unknown,
): value is { readonly timeUs: number; readonly value: unknown } =>
  isRecord(value) &&
  typeof value.timeUs === "number" &&
  Number.isSafeInteger(value.timeUs) &&
  value.timeUs >= 0 &&
  "value" in value &&
  hasExactKeys(value, ["timeUs", "value"]);

function parse(command: unknown): Payload | ErrorCode {
  if (!isRecord(command)) return "MALFORMED_COMMAND";
  if (
    command.commandSchemaVersion !== 1 ||
    !isId(command.commandId) ||
    !isId(command.documentId) ||
    !Number.isSafeInteger(command.expectedRevision) ||
    (command.actorCapability !== "human-ui" &&
      command.actorCapability !== "browser-agent" &&
      command.actorCapability !== "headless-agent") ||
    !isRecord(command.payload)
  ) {
    return "MALFORMED_COMMAND";
  }
  if (command.payload.type === "set-keyframe-value") {
    if (
      !isId(command.payload.trackId) ||
      !isId(command.payload.keyframeId) ||
      typeof command.payload.value !== "number"
    ) {
      return "MALFORMED_COMMAND";
    }
    return command.payload as SetKeyframeValuePayload;
  }
  if (
    command.payload.type === "create-track" ||
    command.payload.type === "remove-track" ||
    command.payload.type === "create-keyframe" ||
    command.payload.type === "change-keyframe" ||
    command.payload.type === "move-keyframe" ||
    command.payload.type === "remove-keyframe"
  ) {
    const payload = command.payload;
    if (!isId(payload.elementId) || !isTimelineProperty(payload.property)) {
      return "MALFORMED_COMMAND";
    }
    if (payload.type === "create-track") {
      const keys = [
        "type",
        "elementId",
        "property",
        "interpolation",
        "keyframe",
      ];
      if (payload.property === "opacity") keys.push("easing");
      if (
        !hasExactKeys(payload, keys) ||
        !isTimelineKeyframe(payload.keyframe) ||
        (payload.property === "opacity" &&
          (payload.interpolation !== "linear" ||
            !["linear", "easeInQuad", "easeOutQuad", "easeInOutQuad"].includes(
              payload.easing as string,
            ))) ||
        (payload.property === "text.text" && payload.interpolation !== "step")
      )
        return "MALFORMED_COMMAND";
    } else if (payload.type === "remove-track") {
      if (!hasExactKeys(payload, ["type", "elementId", "property"]))
        return "MALFORMED_COMMAND";
    } else if (payload.type === "create-keyframe") {
      if (
        !hasExactKeys(payload, ["type", "elementId", "property", "keyframe"]) ||
        !isTimelineKeyframe(payload.keyframe)
      )
        return "MALFORMED_COMMAND";
    } else if (payload.type === "move-keyframe") {
      if (
        !hasExactKeys(payload, [
          "type",
          "elementId",
          "property",
          "fromTimeUs",
          "toTimeUs",
        ]) ||
        typeof payload.fromTimeUs !== "number" ||
        typeof payload.toTimeUs !== "number" ||
        !Number.isSafeInteger(payload.fromTimeUs) ||
        !Number.isSafeInteger(payload.toTimeUs) ||
        payload.fromTimeUs < 0 ||
        payload.toTimeUs < 0
      )
        return "MALFORMED_COMMAND";
    } else if (
      !hasExactKeys(
        payload,
        payload.type === "change-keyframe"
          ? ["type", "elementId", "property", "timeUs", "value"]
          : ["type", "elementId", "property", "timeUs"],
      ) ||
      typeof payload.timeUs !== "number" ||
      !Number.isSafeInteger(payload.timeUs) ||
      payload.timeUs < 0
    ) {
      return "MALFORMED_COMMAND";
    }
    return payload as TimelinePayload;
  }
  if (command.payload.type === "remove-element") {
    if (
      !isId(command.payload.elementId) ||
      Object.keys(command.payload).length !== 2
    ) {
      return "MALFORMED_COMMAND";
    }
    return command.payload as RemoveElementPayload;
  }
  if (command.payload.type === "replace-element") {
    if (
      !isId(command.payload.elementId) ||
      !isRecord(command.payload.element) ||
      "id" in command.payload.element ||
      !isCreateElementType(command.payload.element.type) ||
      (command.payload.element.type === "group" &&
        (!Array.isArray(command.payload.element.childrenIds) ||
          command.payload.element.childrenIds.length !== 0)) ||
      Object.keys(command.payload).length !== 3
    ) {
      return "MALFORMED_COMMAND";
    }
    return command.payload as ReplaceElementPayload;
  }
  if (command.payload.type === "group-elements") {
    if (
      !Array.isArray(command.payload.elementIds) ||
      command.payload.elementIds.length < 2 ||
      !command.payload.elementIds.every(isId) ||
      new Set(command.payload.elementIds).size !==
        command.payload.elementIds.length ||
      Object.keys(command.payload).length !== 2
    ) {
      return "MALFORMED_COMMAND";
    }
    return command.payload as GroupElementsPayload;
  }
  if (command.payload.type === "ungroup-element") {
    if (
      !isId(command.payload.groupId) ||
      Object.keys(command.payload).length !== 2
    ) {
      return "MALFORMED_COMMAND";
    }
    return command.payload as UngroupElementPayload;
  }
  if (command.payload.type === "reparent-element") {
    const position = command.payload.position;
    if (
      !isId(command.payload.elementId) ||
      (command.payload.parentId !== null && !isId(command.payload.parentId)) ||
      typeof position !== "number" ||
      !Number.isSafeInteger(position) ||
      position < 0 ||
      Object.keys(command.payload).length !== 4
    ) {
      return "MALFORMED_COMMAND";
    }
    return command.payload as ReparentElementPayload;
  }
  if (
    command.payload.type !== "create-element" ||
    !isRecord(command.payload.element) ||
    "id" in command.payload.element ||
    !isCreateElementType(command.payload.element.type) ||
    (command.payload.element.type === "group" &&
      (!Array.isArray(command.payload.element.childrenIds) ||
        command.payload.element.childrenIds.length !== 0))
  ) {
    return "MALFORMED_COMMAND";
  }
  return command.payload as CreateElementPayload;
}

class Session implements CommandSession {
  #revision = 0;
  #undo: Entry[] = [];
  #redo: Entry[] = [];

  constructor(
    private readonly documentId: string,
    private document: SceneDocumentV1,
    private readonly idSource?: ElementIdSource,
  ) {}

  snapshot() {
    return { revision: this.#revision, document: clone(this.document) };
  }

  fork(): CommandSession {
    const fork = new Session(
      this.documentId,
      clone(this.document),
      this.idSource,
    );
    fork.#revision = this.#revision;
    fork.#undo = clone(this.#undo);
    fork.#redo = clone(this.#redo);
    return fork;
  }

  private result(): Result {
    return {
      ok: true,
      revision: this.#revision,
      document: clone(this.document),
    };
  }

  dispatch(command: unknown): Result {
    const payload = parse(command);
    if (typeof payload === "string") return error(payload);
    const envelope = command as Record<string, unknown>;
    if (envelope.documentId !== this.documentId)
      return error("DOCUMENT_MISMATCH");
    if (envelope.expectedRevision !== this.#revision) {
      return error("REVISION_CONFLICT");
    }
    if (payload.type === "create-element") return this.create(payload);
    if (payload.type === "remove-element") return this.remove(payload);
    if (payload.type === "replace-element") return this.replace(payload);
    if (payload.type === "group-elements") return this.group(payload);
    if (payload.type === "ungroup-element") return this.ungroup(payload);
    if (payload.type === "reparent-element") return this.reparent(payload);
    if (payload.type !== "set-keyframe-value") return this.timeline(payload);

    const track = this.document.tracks.find(
      (item) => trackId(item.elementId) === payload.trackId,
    );
    const keyframe = track?.keyframes.find(
      (item) => keyframeId(payload.trackId, item.timeUs) === payload.keyframeId,
    );
    if (!track || !keyframe) return error("TARGET_NOT_FOUND");

    const [candidate, forward, inverse] = produceWithPatches(
      this.document,
      (draft) => {
        const nextTrack = draft.tracks.find(
          (item) => trackId(item.elementId) === payload.trackId,
        );
        const nextKeyframe = nextTrack?.keyframes.find(
          (item) =>
            keyframeId(payload.trackId, item.timeUs) === payload.keyframeId,
        );
        if (nextKeyframe) nextKeyframe.value = payload.value;
      },
    );
    const validation = validateSceneDocument(candidate);
    if (!validation.ok) return error("INVALID_CANDIDATE");
    this.document = validation.value;
    this.#revision += 1;
    this.#undo.push({ forward, inverse });
    this.#redo = [];
    return this.result();
  }

  private timeline(payload: TimelinePayload): Result {
    const index = this.document.tracks.findIndex(
      (track) =>
        track.elementId === payload.elementId &&
        track.property === payload.property,
    );
    if (payload.type === "create-track") {
      if (index >= 0) return error("INVALID_CANDIDATE");
      return this.commitTimeline((draft) => {
        draft.tracks.push({
          elementId: payload.elementId,
          property: payload.property,
          interpolation: payload.interpolation,
          ...(payload.property === "opacity" ? { easing: payload.easing } : {}),
          keyframes: [payload.keyframe],
        } as never);
      });
    }
    if (index < 0) return error("TARGET_NOT_FOUND");
    if (payload.type === "remove-track") {
      return this.commitTimeline((draft) => {
        draft.tracks.splice(index, 1);
      });
    }
    const track = this.document.tracks[index]!;
    const keyIndex = (timeUs: number) =>
      track.keyframes.findIndex((keyframe) => keyframe.timeUs === timeUs);
    if (payload.type === "create-keyframe") {
      if (keyIndex(payload.keyframe!.timeUs) >= 0)
        return error("INVALID_CANDIDATE");
      return this.commitTimeline((draft) => {
        const keys = draft.tracks[index]!.keyframes as Array<{
          timeUs: number;
          value: unknown;
        }>;
        keys.push(payload.keyframe!);
        keys.sort((left, right) => left.timeUs - right.timeUs);
      });
    }
    const timeUs =
      payload.type === "move-keyframe" ? payload.fromTimeUs! : payload.timeUs!;
    const key = keyIndex(timeUs);
    if (key < 0) return error("TARGET_NOT_FOUND");
    if (payload.type === "remove-keyframe") {
      if (track.keyframes.length === 1) return error("LAST_KEYFRAME");
      return this.commitTimeline((draft) => {
        draft.tracks[index]!.keyframes.splice(key, 1);
      });
    }
    if (payload.type === "move-keyframe" && keyIndex(payload.toTimeUs!) >= 0)
      return error("INVALID_CANDIDATE");
    return this.commitTimeline((draft) => {
      const keyframe = draft.tracks[index]!.keyframes[key]!;
      if (payload.type === "change-keyframe")
        keyframe.value = payload.value as never;
      if (payload.type === "move-keyframe") {
        keyframe.timeUs = payload.toTimeUs!;
        draft.tracks[index]!.keyframes.sort(
          (left, right) => left.timeUs - right.timeUs,
        );
      }
    });
  }

  private commitTimeline(update: (draft: SceneDocumentV1) => void): Result {
    const [candidate, forward, inverse] = produceWithPatches(
      this.document,
      update,
    );
    const validation = validateSceneDocument(candidate);
    if (!validation.ok) return error("INVALID_CANDIDATE");
    this.document = validation.value;
    this.#revision += 1;
    this.#undo.push({ forward, inverse });
    this.#redo = [];
    return this.result();
  }

  private remove(payload: RemoveElementPayload): Result {
    const rootIndex = this.document.rootIds.indexOf(payload.elementId);
    const elementIndex = this.document.elements.findIndex(
      (element) => element.id === payload.elementId,
    );
    if (rootIndex < 0 || elementIndex < 0) return error("TARGET_NOT_FOUND");
    const target = this.document.elements[elementIndex]!;
    if (target.type === "group" && target.childrenIds.length > 0) {
      return error("INVALID_CANDIDATE");
    }

    const [candidate, forward, inverse] = produceWithPatches(
      this.document,
      (draft) => {
        draft.rootIds.splice(rootIndex, 1);
        draft.elements.splice(elementIndex, 1);
        draft.tracks = draft.tracks.filter(
          (track) => track.elementId !== payload.elementId,
        );
      },
    );
    const validation = validateSceneDocument(candidate);
    if (!validation.ok) return error("INVALID_CANDIDATE");
    this.document = validation.value;
    this.#revision += 1;
    this.#undo.push({ forward, inverse });
    this.#redo = [];
    return this.result();
  }

  private replace(payload: ReplaceElementPayload): Result {
    const rootIndex = this.document.rootIds.indexOf(payload.elementId);
    const elementIndex = this.document.elements.findIndex(
      (element) => element.id === payload.elementId,
    );
    if (rootIndex < 0 || elementIndex < 0) return error("TARGET_NOT_FOUND");
    const target = this.document.elements[elementIndex]!;
    if (target.type === "group" && target.childrenIds.length > 0) {
      return error("INVALID_CANDIDATE");
    }
    const supplied = this.nextElementId();
    if (!supplied.ok) return error(supplied.error);
    if (this.document.elements.some((element) => element.id === supplied.id)) {
      return error("ID_COLLISION");
    }
    const [candidate, forward, inverse] = produceWithPatches(
      this.document,
      (draft) => {
        draft.rootIds[rootIndex] = supplied.id;
        draft.elements[elementIndex] = clone({
          ...payload.element,
          id: supplied.id,
        }) as never;
        for (const track of draft.tracks) {
          if (track.elementId === payload.elementId) {
            track.elementId = supplied.id;
          }
        }
      },
    );
    const validation = validateSceneDocument(candidate);
    if (!validation.ok) return error("INVALID_CANDIDATE");
    this.document = validation.value;
    this.#revision += 1;
    this.#undo.push({ forward, inverse });
    this.#redo = [];
    return this.result();
  }

  private ownerOf(elementId: string): Owner | undefined {
    const owners: Owner[] = [];
    if (this.document.rootIds.includes(elementId)) {
      owners.push({ groupId: null, childrenIds: this.document.rootIds });
    }
    for (const element of this.document.elements) {
      if (element.type === "group" && element.childrenIds.includes(elementId)) {
        owners.push({ groupId: element.id, childrenIds: element.childrenIds });
      }
    }
    return owners.length === 1 ? owners[0] : undefined;
  }

  private worldMatrix(elementId: string): number[] | undefined {
    const matrices: number[][] = [];
    let currentId = elementId;
    for (let depth = 0; depth < this.document.elements.length; depth += 1) {
      const element = this.document.elements.find(({ id }) => id === currentId);
      const owner = this.ownerOf(currentId);
      if (!element || !owner) return undefined;
      const matrix = element.transform ?? [1, 0, 0, 1, 0, 0];
      if (matrix.length !== 6 || !matrix.every(Number.isFinite))
        return undefined;
      matrices.unshift(matrix);
      if (owner.groupId === null) {
        return matrices.reduce(
          (parent, child) => [
            parent[0]! * child[0]! + parent[2]! * child[1]!,
            parent[1]! * child[0]! + parent[3]! * child[1]!,
            parent[0]! * child[2]! + parent[2]! * child[3]!,
            parent[1]! * child[2]! + parent[3]! * child[3]!,
            parent[0]! * child[4]! + parent[2]! * child[5]! + parent[4]!,
            parent[1]! * child[4]! + parent[3]! * child[5]! + parent[5]!,
          ],
          [1, 0, 0, 1, 0, 0],
        );
      }
      currentId = owner.groupId;
    }
    return undefined;
  }

  private effectiveVisibility(elementId: string): boolean | undefined {
    let currentId = elementId;
    for (let depth = 0; depth < this.document.elements.length; depth += 1) {
      const element = this.document.elements.find(({ id }) => id === currentId);
      const owner = this.ownerOf(currentId);
      if (!element || !owner) return undefined;
      if (element.visible === false) return false;
      if (owner.groupId === null) return true;
      currentId = owner.groupId;
    }
    return undefined;
  }

  private reparent(payload: ReparentElementPayload): Result {
    if (payload.parentId !== null) return this.reparentToGroup(payload);
    const element = this.document.elements.find(
      ({ id }) => id === payload.elementId,
    );
    const owner = this.ownerOf(payload.elementId);
    const sourceIndex = owner?.childrenIds.indexOf(payload.elementId) ?? -1;
    const world = this.worldMatrix(payload.elementId);
    const visible = this.effectiveVisibility(payload.elementId);
    const finalLength =
      this.document.rootIds.length - (owner?.groupId === null ? 1 : 0);
    if (
      !element ||
      !owner ||
      sourceIndex < 0 ||
      !world ||
      visible === undefined ||
      payload.position > finalLength
    ) {
      return error(element ? "INVALID_CANDIDATE" : "TARGET_NOT_FOUND");
    }
    const [candidate, forward, inverse] = produceWithPatches(
      this.document,
      (draft) => {
        let sourceChildren: string[] | undefined;
        if (owner.groupId === null) {
          sourceChildren = draft.rootIds;
        } else {
          const sourceGroup = draft.elements.find(
            ({ id }) => id === owner.groupId,
          );
          if (sourceGroup?.type === "group") {
            sourceChildren = sourceGroup.childrenIds;
          }
        }
        const moved = draft.elements.find(({ id }) => id === payload.elementId);
        if (!sourceChildren || !moved) return;
        sourceChildren.splice(sourceIndex, 1);
        draft.rootIds.splice(payload.position, 0, payload.elementId);
        moved.transform = world;
        moved.visible = visible;
      },
    );
    const validation = validateSceneDocument(candidate);
    if (!validation.ok) return error("INVALID_CANDIDATE");
    this.document = validation.value;
    this.#revision += 1;
    this.#undo.push({ forward, inverse });
    this.#redo = [];
    return this.result();
  }

  private reparentToGroup(payload: ReparentElementPayload): Result {
    const element = this.document.elements.find(
      ({ id }) => id === payload.elementId,
    );
    const sourceOwner = this.ownerOf(payload.elementId);
    const sourceIndex =
      sourceOwner?.childrenIds.indexOf(payload.elementId) ?? -1;
    const target = this.document.elements.find(
      ({ id }) => id === payload.parentId,
    );
    if (!element || !target) return error("TARGET_NOT_FOUND");
    if (
      !sourceOwner ||
      sourceIndex < 0 ||
      target.type !== "group" ||
      target.id === element.id ||
      !this.ownerOf(target.id)
    ) {
      return error("INVALID_CANDIDATE");
    }
    let ancestorId = target.id;
    for (let depth = 0; depth < this.document.elements.length; depth += 1) {
      const ancestorOwner = this.ownerOf(ancestorId);
      if (!ancestorOwner) return error("INVALID_CANDIDATE");
      if (ancestorOwner.groupId === element.id)
        return error("INVALID_CANDIDATE");
      if (ancestorOwner.groupId === null) break;
      ancestorId = ancestorOwner.groupId;
    }
    const sameOwner = sourceOwner.groupId === target.id;
    const finalLength = target.childrenIds.length - Number(sameOwner);
    if (payload.position > finalLength) return error("INVALID_CANDIDATE");
    if (sameOwner) {
      return this.commitReparent((draft) => {
        const targetGroup = draft.elements.find(({ id }) => id === target.id);
        if (targetGroup?.type !== "group") return;
        targetGroup.childrenIds.splice(sourceIndex, 1);
        targetGroup.childrenIds.splice(payload.position, 0, payload.elementId);
      });
    }
    const world = this.worldMatrix(payload.elementId);
    const targetWorld = this.worldMatrix(target.id);
    const visible = this.effectiveVisibility(payload.elementId);
    const targetVisible = this.effectiveVisibility(target.id);
    if (
      !world ||
      !targetWorld ||
      visible === undefined ||
      targetVisible === undefined
    ) {
      return error("INVALID_CANDIDATE");
    }
    const determinant =
      targetWorld[0]! * targetWorld[3]! - targetWorld[1]! * targetWorld[2]!;
    if (
      !Number.isFinite(determinant) ||
      determinant === 0 ||
      (visible && !targetVisible)
    ) {
      return error("INVALID_CANDIDATE");
    }
    const inverse = [
      targetWorld[3]! / determinant,
      -targetWorld[1]! / determinant,
      -targetWorld[2]! / determinant,
      targetWorld[0]! / determinant,
      (targetWorld[2]! * targetWorld[5]! - targetWorld[3]! * targetWorld[4]!) /
        determinant,
      (targetWorld[1]! * targetWorld[4]! - targetWorld[0]! * targetWorld[5]!) /
        determinant,
    ];
    const local = [
      inverse[0]! * world[0]! + inverse[2]! * world[1]!,
      inverse[1]! * world[0]! + inverse[3]! * world[1]!,
      inverse[0]! * world[2]! + inverse[2]! * world[3]!,
      inverse[1]! * world[2]! + inverse[3]! * world[3]!,
      inverse[0]! * world[4]! + inverse[2]! * world[5]! + inverse[4]!,
      inverse[1]! * world[4]! + inverse[3]! * world[5]! + inverse[5]!,
    ];
    if (!local.every(Number.isFinite)) return error("INVALID_CANDIDATE");
    return this.commitReparent((draft) => {
      const sourceGroup = draft.elements.find(
        ({ id }) => id === sourceOwner.groupId,
      );
      const sourceChildren =
        sourceOwner.groupId === null
          ? draft.rootIds
          : sourceGroup?.type === "group"
            ? sourceGroup.childrenIds
            : undefined;
      const targetGroup = draft.elements.find(({ id }) => id === target.id);
      const moved = draft.elements.find(({ id }) => id === payload.elementId);
      if (!sourceChildren || targetGroup?.type !== "group" || !moved) return;
      sourceChildren.splice(sourceIndex, 1);
      targetGroup.childrenIds.splice(payload.position, 0, payload.elementId);
      moved.transform = local;
      moved.visible = visible;
    });
  }

  private commitReparent(update: (draft: SceneDocumentV1) => void): Result {
    const [candidate, forward, inverse] = produceWithPatches(
      this.document,
      update,
    );
    const validation = validateSceneDocument(candidate);
    if (!validation.ok) return error("INVALID_CANDIDATE");
    this.document = validation.value;
    this.#revision += 1;
    this.#undo.push({ forward, inverse });
    this.#redo = [];
    return this.result();
  }

  private ungroup(payload: UngroupElementPayload): Result {
    const group = this.document.elements.find(
      ({ id }) => id === payload.groupId,
    );
    if (!group) return error("TARGET_NOT_FOUND");
    if (group.type !== "group") return error("INVALID_CANDIDATE");
    const owner = this.ownerOf(group.id);
    const slot = owner?.childrenIds.indexOf(group.id) ?? -1;
    const parentWorld =
      owner?.groupId === null
        ? [1, 0, 0, 1, 0, 0]
        : this.worldMatrix(owner?.groupId ?? "");
    if (!owner || slot < 0 || !parentWorld) return error("INVALID_CANDIDATE");
    const determinant =
      parentWorld[0]! * parentWorld[3]! - parentWorld[1]! * parentWorld[2]!;
    if (!Number.isFinite(determinant) || determinant === 0) {
      return error("INVALID_CANDIDATE");
    }
    const inverse = [
      parentWorld[3]! / determinant,
      -parentWorld[1]! / determinant,
      -parentWorld[2]! / determinant,
      parentWorld[0]! / determinant,
      (parentWorld[2]! * parentWorld[5]! - parentWorld[3]! * parentWorld[4]!) /
        determinant,
      (parentWorld[1]! * parentWorld[4]! - parentWorld[0]! * parentWorld[5]!) /
        determinant,
    ];
    const promoted = group.childrenIds.map((id) => {
      const child = this.document.elements.find((element) => element.id === id);
      const world = this.worldMatrix(id);
      if (!child || this.ownerOf(id)?.groupId !== group.id || !world)
        return undefined;
      const local = [
        inverse[0]! * world[0]! + inverse[2]! * world[1]!,
        inverse[1]! * world[0]! + inverse[3]! * world[1]!,
        inverse[0]! * world[2]! + inverse[2]! * world[3]!,
        inverse[1]! * world[2]! + inverse[3]! * world[3]!,
        inverse[0]! * world[4]! + inverse[2]! * world[5]! + inverse[4]!,
        inverse[1]! * world[4]! + inverse[3]! * world[5]! + inverse[5]!,
      ];
      return local.every(Number.isFinite) ? { id, local } : undefined;
    });
    if (
      new Set(group.childrenIds).size !== group.childrenIds.length ||
      promoted.some((child) => child === undefined)
    ) {
      return error("INVALID_CANDIDATE");
    }
    const [candidate, forward, inversePatches] = produceWithPatches(
      this.document,
      (draft) => {
        const parent = draft.elements.find(({ id }) => id === owner.groupId);
        const children =
          owner.groupId === null
            ? draft.rootIds
            : parent?.type === "group"
              ? parent.childrenIds
              : undefined;
        if (!children) return;
        children.splice(slot, 1, ...group.childrenIds);
        for (const child of promoted) {
          const element = draft.elements.find(({ id }) => id === child!.id);
          if (!element) return;
          element.transform = child!.local;
          if (group.visible === false) element.visible = false;
        }
        draft.elements = draft.elements.filter(({ id }) => id !== group.id);
      },
    );
    const validation = validateSceneDocument(candidate);
    if (!validation.ok) return error("INVALID_CANDIDATE");
    this.document = validation.value;
    this.#revision += 1;
    this.#undo.push({ forward, inverse: inversePatches });
    this.#redo = [];
    return this.result();
  }

  private group(payload: GroupElementsPayload): Result {
    const selected = new Set(payload.elementIds);
    if (
      !payload.elementIds.every((id) =>
        this.document.elements.some((element) => element.id === id),
      )
    ) {
      return error("TARGET_NOT_FOUND");
    }
    const owner = this.ownerOf(payload.elementIds[0]!);
    if (
      !owner ||
      !payload.elementIds.every((id) => {
        const candidate = this.ownerOf(id);
        return candidate?.groupId === owner.groupId;
      })
    ) {
      return error("INVALID_CANDIDATE");
    }
    const selectedInOrder = owner.childrenIds.filter((id) => selected.has(id));
    const insertionIndex = owner.childrenIds.indexOf(selectedInOrder[0]!);
    if (
      selectedInOrder.length !== payload.elementIds.length ||
      insertionIndex < 0
    ) {
      return error("INVALID_CANDIDATE");
    }
    const supplied = this.nextElementId();
    if (!supplied.ok) return error(supplied.error);
    if (this.document.elements.some((element) => element.id === supplied.id)) {
      return error("ID_COLLISION");
    }
    const [candidate, forward, inverse] = produceWithPatches(
      this.document,
      (draft) => {
        let children: string[];
        if (owner.groupId === null) {
          children = draft.rootIds;
        } else {
          const parent = draft.elements.find(
            (element) => element.id === owner.groupId,
          );
          if (!parent || parent.type !== "group") return;
          children = parent.childrenIds;
        }
        const remaining = children.filter((id) => !selected.has(id));
        children.splice(0, children.length, ...remaining);
        children.splice(insertionIndex, 0, supplied.id);
        draft.elements.push({
          id: supplied.id,
          type: "group",
          childrenIds: selectedInOrder,
        } as never);
      },
    );
    const validation = validateSceneDocument(candidate);
    if (!validation.ok) return error("INVALID_CANDIDATE");
    this.document = validation.value;
    this.#revision += 1;
    this.#undo.push({ forward, inverse });
    this.#redo = [];
    return this.result();
  }

  private create(payload: CreateElementPayload): Result {
    const supplied = this.nextElementId();
    if (!supplied.ok) return error(supplied.error);
    if (this.document.elements.some((element) => element.id === supplied.id)) {
      return error("ID_COLLISION");
    }
    const [candidate, forward, inverse] = produceWithPatches(
      this.document,
      (draft) => {
        draft.elements.push(
          clone({ ...payload.element, id: supplied.id }) as never,
        );
        draft.rootIds.push(supplied.id);
      },
    );
    const validation = validateSceneDocument(candidate);
    if (!validation.ok) return error("INVALID_CANDIDATE");
    this.document = validation.value;
    this.#revision += 1;
    this.#undo.push({ forward, inverse });
    this.#redo = [];
    return this.result();
  }

  private nextElementId():
    | { readonly ok: true; readonly id: string }
    | { readonly ok: false; readonly error: ErrorCode } {
    if (!this.idSource) return { ok: false, error: "ID_SOURCE_UNAVAILABLE" };
    try {
      const result: unknown = this.idSource();
      if (!isRecord(result)) return { ok: false, error: "ID_SOURCE_INVALID" };
      if (result.kind === "unavailable" && Object.keys(result).length === 1) {
        return { ok: false, error: "ID_SOURCE_UNAVAILABLE" };
      }
      if (
        result.kind !== "id" ||
        Object.keys(result).length !== 2 ||
        typeof result.id !== "string" ||
        !isStableElementId(result.id)
      ) {
        return { ok: false, error: "ID_SOURCE_INVALID" };
      }
      return { ok: true, id: result.id };
    } catch {
      return { ok: false, error: "ID_SOURCE_UNAVAILABLE" };
    }
  }

  undo(): Result {
    return this.apply(this.#undo, this.#redo, "NOTHING_TO_UNDO", "inverse");
  }

  redo(): Result {
    return this.apply(this.#redo, this.#undo, "NOTHING_TO_REDO", "forward");
  }

  private apply(
    source: Entry[],
    destination: Entry[],
    empty: ErrorCode,
    patch: keyof Entry,
  ): Result {
    const entry = source.at(-1);
    if (!entry) return error(empty);
    const candidate = applyPatches(this.document, entry[patch]);
    const validation = validateSceneDocument(candidate);
    if (!validation.ok) return error("INVALID_CANDIDATE");
    source.pop();
    destination.push(entry);
    this.document = validation.value;
    this.#revision += 1;
    return this.result();
  }
}

export function createCommandSession(
  documentId: string,
  document: SceneDocumentV1,
  idSource?: ElementIdSource,
): CommandSession {
  if (!isId(documentId) || !validateSceneDocument(document).ok) {
    throw new TypeError("INVALID_INITIAL_SESSION");
  }
  return new Session(documentId, clone(document), idSource);
}
