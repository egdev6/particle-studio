import { describe, expect, it } from "vitest";

import {
  createCommandSession,
  type CommandSession,
} from "@particle-studio/commands";
import {
  FIRST_SLICE_DOCUMENT,
  type SceneDocumentV1,
} from "@particle-studio/scene-document";

import {
  createDurableCommandBridge,
  type DurableCommandBridgeOptions,
} from "../src/durable-command-bridge.js";

const document = () => structuredClone(FIRST_SLICE_DOCUMENT) as SceneDocumentV1;

const command = (value: number, revision = 0) => ({
  commandSchemaVersion: 1,
  commandId: `command-${revision}-${value}`,
  documentId: "document-1",
  expectedRevision: revision,
  actorCapability: "human-ui",
  payload: {
    type: "set-keyframe-value" as const,
    trackId: "shape-1:opacity",
    keyframeId: "shape-1:opacity:0",
    value,
  },
});

const createCommand = (revision = 0) => ({
  commandSchemaVersion: 1,
  commandId: `create-${revision}`,
  documentId: "document-1",
  expectedRevision: revision,
  actorCapability: "human-ui",
  payload: {
    type: "create-element" as const,
    element: { type: "group", childrenIds: [] },
  },
});

const valueAtZero = (snapshot: ReturnType<CommandSession["snapshot"]>) =>
  snapshot.document.tracks[0]!.keyframes[0]!.value;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("durable command bridge", () => {
  it("keeps the prior active snapshot visible until publication resolves", async () => {
    const pending = deferred();
    const bridge = createDurableCommandBridge({
      documentId: "document-1",
      document: document(),
      publish: () => pending.promise,
    });

    const beforePublication = bridge.snapshot();
    const operation = bridge.dispatch(command(0.25));
    await Promise.resolve();

    expect(bridge.snapshot()).toEqual(beforePublication);

    pending.resolve();
    await expect(operation).resolves.toMatchObject({ ok: true, revision: 1 });
    expect(valueAtZero(bridge.snapshot())).toBe(0.25);
  });

  it("preserves the active redo history after a durable publication failure", async () => {
    let attempts = 0;
    const bridge = createDurableCommandBridge({
      documentId: "document-1",
      document: document(),
      publish: async () => {
        attempts += 1;
        if (attempts === 3) throw new Error("durable backend unavailable");
      },
    });

    await expect(bridge.dispatch(command(0.25))).resolves.toMatchObject({
      ok: true,
      revision: 1,
    });
    await expect(bridge.undo()).resolves.toMatchObject({
      ok: true,
      revision: 2,
    });
    const beforeFailure = bridge.snapshot();

    await expect(bridge.redo()).resolves.toEqual({
      ok: false,
      error: { code: "DURABLE_PUBLISH_FAILED" },
    });
    expect(bridge.snapshot()).toEqual(beforeFailure);

    await expect(bridge.redo()).resolves.toMatchObject({
      ok: true,
      revision: 3,
    });
    expect(valueAtZero(bridge.snapshot())).toBe(0.25);
  });

  it.each([
    ["object", { committed: true }],
    ["string", "committed"],
    ["null", null],
  ])(
    "rejects a publisher that fulfills with %s without committing its candidate",
    async (_description, invalidFulfillment) => {
      let publications = 0;
      const bridge = createDurableCommandBridge({
        documentId: "document-1",
        document: document(),
        publish: (async (_candidate: SceneDocumentV1) => {
          publications += 1;
          return publications === 3 ? invalidFulfillment : undefined;
        }) as DurableCommandBridgeOptions["publish"],
      });

      await expect(bridge.dispatch(command(0.2))).resolves.toMatchObject({
        ok: true,
        revision: 1,
      });
      await expect(bridge.undo()).resolves.toMatchObject({
        ok: true,
        revision: 2,
      });
      const beforeFailedRedo = bridge.snapshot();

      await expect(bridge.redo()).resolves.toEqual({
        ok: false,
        error: { code: "DURABLE_PUBLISH_FAILED" },
      });
      expect(bridge.snapshot()).toEqual(beforeFailedRedo);

      await expect(bridge.redo()).resolves.toMatchObject({
        ok: true,
        revision: 3,
      });
      await expect(bridge.undo()).resolves.toMatchObject({
        ok: true,
        revision: 4,
      });
      await expect(bridge.redo()).resolves.toMatchObject({
        ok: true,
        revision: 5,
      });
      await expect(bridge.dispatch(command(0.6, 5))).resolves.toMatchObject({
        ok: true,
        revision: 6,
      });
    },
  );

  it("rejects a hostile thenable getter without poisoning later operations", async () => {
    let publications = 0;
    let thenReads = 0;
    const hostileThenable = {
      get then() {
        thenReads += 1;
        return (resolve: (value: unknown) => void) =>
          resolve({ committed: true });
      },
    };
    const bridge = createDurableCommandBridge({
      documentId: "document-1",
      document: document(),
      publish: (() => {
        publications += 1;
        return publications === 1 ? hostileThenable : undefined;
      }) as unknown as DurableCommandBridgeOptions["publish"],
    });
    const beforeFailure = bridge.snapshot();

    await expect(bridge.dispatch(command(0.2))).resolves.toEqual({
      ok: false,
      error: { code: "DURABLE_PUBLISH_FAILED" },
    });
    expect(thenReads).toBe(1);
    expect(bridge.snapshot()).toEqual(beforeFailure);
    await expect(bridge.dispatch(command(0.2))).resolves.toMatchObject({
      ok: true,
      revision: 1,
    });
  });

  it("serializes concurrent dispatches in invocation order", async () => {
    const firstPublication = deferred();
    const published: SceneDocumentV1[] = [];
    let publications = 0;
    const bridge = createDurableCommandBridge({
      documentId: "document-1",
      document: document(),
      publish: async (candidate) => {
        published.push(candidate);
        publications += 1;
        if (publications === 1) await firstPublication.promise;
      },
    });

    const first = bridge.dispatch(command(0.25));
    await Promise.resolve();
    const second = bridge.dispatch(command(0.5, 1));

    expect(bridge.snapshot()).toMatchObject({ revision: 0 });
    firstPublication.resolve();

    await expect(first).resolves.toMatchObject({ ok: true, revision: 1 });
    await expect(second).resolves.toMatchObject({ ok: true, revision: 2 });
    expect(
      published.map((candidate) => candidate.tracks[0]!.keyframes[0]!.value),
    ).toEqual([0.25, 0.5]);
    expect(valueAtZero(bridge.snapshot())).toBe(0.5);
  });

  it("returns rejected command results without publishing", async () => {
    let publishes = 0;
    const direct = createCommandSession("document-1", document());
    const rejected = command(0.25, 1);
    const bridge = createDurableCommandBridge({
      documentId: "document-1",
      document: document(),
      publish: async () => {
        publishes += 1;
      },
    });

    await expect(bridge.dispatch(rejected)).resolves.toEqual(
      direct.dispatch(rejected),
    );
    expect(publishes).toBe(0);
    expect(bridge.snapshot()).toEqual(direct.snapshot());
  });

  it("returns successful domain results exactly and isolates caller-owned values", async () => {
    const input = document();
    const direct = createCommandSession("document-1", document());
    const published: SceneDocumentV1[] = [];
    const bridge = createDurableCommandBridge({
      documentId: "document-1",
      document: input,
      publish: async (candidate) => {
        published.push(candidate);
        candidate.tracks[0]!.keyframes[0]!.value = 0.75;
      },
    });
    input.tracks[0]!.keyframes[0]!.value = 0.5;

    const request = command(0.25);
    const expected = direct.dispatch(command(0.25));
    const operation = bridge.dispatch(request);
    request.payload.value = 0.5;
    const actual = await operation;

    expect(actual).toEqual(expected);
    expect(published[0]!.tracks[0]!.keyframes[0]!.value).toBe(0.75);
    if (actual.ok) actual.document.tracks[0]!.keyframes[0]!.value = 0.5;
    const snapshot = bridge.snapshot();
    snapshot.document.tracks[0]!.keyframes[0]!.value = 0.5;
    expect(valueAtZero(bridge.snapshot())).toBe(0.25);
  });

  it("does not reuse IDs consumed by discarded publication forks", async () => {
    const ids = ["discarded-id", "committed-id"];
    let calls = 0;
    let fail = true;
    const bridge = createDurableCommandBridge({
      documentId: "document-1",
      document: document(),
      idSource: () => ({ kind: "id", id: ids[calls++]! }),
      publish: async () => {
        if (fail) {
          fail = false;
          throw new Error("first write failed");
        }
      },
    });

    await expect(bridge.dispatch(createCommand())).resolves.toEqual({
      ok: false,
      error: { code: "DURABLE_PUBLISH_FAILED" },
    });
    await expect(bridge.dispatch(createCommand())).resolves.toMatchObject({
      ok: true,
      revision: 1,
    });
    expect(calls).toBe(2);
    expect(bridge.snapshot().document.rootIds).toEqual([
      "shape-1",
      "committed-id",
    ]);
  });
});
