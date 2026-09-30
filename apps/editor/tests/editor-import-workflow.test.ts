import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIRST_SLICE_DOCUMENT, type SceneDocumentV1 } from "@particle-studio/scene-document";
import { createCompleteRevision } from "@particle-studio/persistence";
import {
  createIndexedDbPersistenceAdapter, deleteIndexedDbPersistenceDatabase,
} from "@particle-studio/persistence-indexeddb";
import { createPngImageCache } from "../src/png-image-cache.js";
import { createDurableDraftWorkspace } from "../src/durable-draft-workspace.js";
import type { DurableDraftPublication, DurableDraftPublishInput } from "../src/durable-draft-workspace.js";
import { createEditorImportWorkflow } from "../src/editor-import-workflow.js";
import { createEditorImageImportWorkflow } from "../src/editor-image-import-workflow.js";
import type {
  EditorImportImageRequest, EditorImportWorkflowDependencies,
} from "../src/editor-import-workflow.js";
import type { EditorImportRequest } from "../src/editor-import-controls.js";

const validDocumentJson = JSON.stringify(FIRST_SLICE_DOCUMENT);

const jsonRequest = (editableJson: string): EditorImportRequest =>
  ({ kind: "editable-json-import", editableJson });

const imageRequest = (): EditorImportImageRequest => ({
  kind: "image-import",
  file: new File([new Uint8Array([1, 2, 3])], "particles.png", { type: "image/png" }),
});

// Minimal frozen publication facade so fake publish ports keep the genuine contract.
const fakePublication = (): DurableDraftPublication => Object.freeze({
  revision: createCompleteRevision({
    documentId: "doc-1", revisionId: "fake-revision", sequence: 0,
    document: FIRST_SLICE_DOCUMENT,
  }),
  workspace: Object.freeze({
    plan: Object.freeze({
      document: FIRST_SLICE_DOCUMENT,
      canonicalEditableJson: validDocumentJson,
      references: Object.freeze([]),
    }),
    images: Object.freeze([]),
    release() {},
  }),
  release() {},
});

function baseDependencies(overrides: Partial<EditorImportWorkflowDependencies> = {}) {
  const publish = vi.fn(async (): Promise<DurableDraftPublication> => fakePublication());
  const imageWorkflow = vi.fn(async (): Promise<unknown> => "image result");
  const counts = { revisionId: 0, sequence: 0, createdAt: 0 };
  const deps: EditorImportWorkflowDependencies = {
    workspace: { publish },
    imageWorkflow,
    documentId: "doc-1",
    revisionId: () => { counts.revisionId += 1; return "draft-1"; },
    sequence: () => { counts.sequence += 1; return 1; },
    createdAt: () => { counts.createdAt += 1; return 1234; },
    ...overrides,
  };
  return { deps, publish, imageWorkflow, counts };
}

describe("editor import workflow (deterministic fake publish port)", () => {
  it("forwards an image-import request unchanged and propagates the image result independently", async () => {
    const request = imageRequest();
    let received: EditorImportImageRequest | null = null;
    const deps = baseDependencies({
      imageWorkflow: async (image) => { received = image; return "image result"; },
    });
    const result = await createEditorImportWorkflow(deps.deps)(request);
    expect(result).toBe("image result");
    // The very same request object reaches the image workflow, file included.
    expect(received).toBe(request);
    expect(received!.file).toBe(request.file);
    // The PNG route never routes through publish and never consumes identity.
    expect(deps.publish).not.toHaveBeenCalled();
    expect(deps.counts).toEqual({ revisionId: 0, sequence: 0, createdAt: 0 });
  });

  it("propagates an image rejection and converts a synchronous image throw into a rejection", async () => {
    const rejecting = baseDependencies({
      imageWorkflow: async () => { throw new Error("EDITOR_PNG_MIME_TYPE_INVALID"); },
    });
    await expect(createEditorImportWorkflow(rejecting.deps)(imageRequest()))
      .rejects.toThrow("EDITOR_PNG_MIME_TYPE_INVALID");
    expect(rejecting.publish).not.toHaveBeenCalled();
    expect(rejecting.counts).toEqual({ revisionId: 0, sequence: 0, createdAt: 0 });

    const syncThrowing = baseDependencies({
      imageWorkflow: (): Promise<unknown> => { throw new Error("sync image failure"); },
    });
    await expect(createEditorImportWorkflow(syncThrowing.deps)(imageRequest()))
      .rejects.toThrow("sync image failure");
    expect(syncThrowing.publish).not.toHaveBeenCalled();
  });

  it("routes editable JSON to one publish with exact identity, sequence, and content forwarding", async () => {
    const captured: DurableDraftPublishInput[] = [];
    let sequences = 0;
    const revisionId = () => "draft-9";
    const createdAt = () => 4321;
    const deps = baseDependencies({
      workspace: {
        publish: async (input: DurableDraftPublishInput) => {
          captured.push(input);
          return fakePublication();
        },
      },
      revisionId,
      createdAt,
      sequence: () => { sequences += 1; return 9; },
    });
    const result = await createEditorImportWorkflow(deps.deps)(
      jsonRequest('{"tracks":[]}'),
    );
    // JSON resolves void: no release authority is ever returned.
    expect(result).toBeUndefined();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.documentId).toBe("doc-1");
    expect(captured[0]!.editableJson).toBe('{"tracks":[]}');
    // Identity and createdAt callbacks are forwarded as the exact same references.
    expect(captured[0]!.revisionId).toBe(revisionId);
    expect(captured[0]!.createdAt).toBe(createdAt);
    // The caller-owned sequence callback is invoked exactly once per attempt.
    expect(captured[0]!.sequence).toBe(9);
    expect(sequences).toBe(1);
  });

  it("resolves void only after the pending publish settles", async () => {
    let release!: (publication: DurableDraftPublication) => void;
    const deps = baseDependencies({
      workspace: {
        publish: () =>
          new Promise<DurableDraftPublication>((resolve) => { release = resolve; }),
      },
    });
    let settled = false;
    const pending = createEditorImportWorkflow(deps.deps)(jsonRequest(validDocumentJson))
      .then((value: unknown) => { settled = true; return value; });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(settled).toBe(false);
    release(fakePublication());
    expect(await pending).toBeUndefined();
    expect(settled).toBe(true);
  });

  it("propagates a publish rejection and retries each call with current input and fresh sequence", async () => {
    const captured: DurableDraftPublishInput[] = [];
    let sequences = 0;
    let fail = true;
    const deps = baseDependencies({
      workspace: {
        publish: async (input: DurableDraftPublishInput) => {
          captured.push(input);
          if (fail) throw new Error("EDITOR_DURABLE_DRAFT_WRITE_FAILED");
          return fakePublication();
        },
      },
      sequence: () => { sequences += 1; return sequences; },
    });
    const workflow = createEditorImportWorkflow(deps.deps);
    await expect(workflow(jsonRequest("broken")))
      .rejects.toThrow("EDITOR_DURABLE_DRAFT_WRITE_FAILED");
    fail = false;
    expect(await workflow(jsonRequest('{"fixed":true}'))).toBeUndefined();
    // The stateless workflow replays exactly the current request input; the
    // caller-owned sequence callback advances without any auto increment.
    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({ documentId: "doc-1", editableJson: "broken", sequence: 1 });
    expect(captured[1]).toMatchObject({ documentId: "doc-1", editableJson: '{"fixed":true}', sequence: 2 });
    expect(sequences).toBe(2);
  });

  it("rejects without publishing when the caller-owned sequence callback throws synchronously", async () => {
    const deps = baseDependencies({
      sequence: (): number => { throw new Error("sequence exploded"); },
    });
    await expect(createEditorImportWorkflow(deps.deps)(jsonRequest(validDocumentJson)))
      .rejects.toThrow("sequence exploded");
    expect(deps.publish).not.toHaveBeenCalled();
  });
});

const integrationDatabases: string[] = [];

function integrationFixture() {
  const databaseName = `editor-import-workflow-${Date.now()}-${Math.random()}`;
  integrationDatabases.push(databaseName);
  const adapter = createIndexedDbPersistenceAdapter({ databaseName });
  const cache = createPngImageCache({
    importVerifiedPng: async () => { throw new Error("unexpected import"); },
    decodeVerifiedPng: async () => { throw new Error("unexpected decode"); },
  });
  const workspace = createDurableDraftWorkspace({
    persistence: adapter,
    cache,
    prehydration: {
      rereadVerifiedPng: async () => { throw new Error("unexpected reread"); },
      decodeVerifiedPng: async () => { throw new Error("unexpected decode"); },
    },
  });
  let failWrite = false;
  const genuineWrite = adapter.writeCompleteRevisionIfPointersMatch.bind(adapter);
  adapter.writeCompleteRevisionIfPointersMatch = async (
    ...args: Parameters<typeof genuineWrite>
  ) => {
    if (failWrite) throw new Error("controlled write failure");
    return genuineWrite(...args);
  };
  // One caller-owned counter: each attempt's sequence value and identity agree.
  let sequences = 0;
  const workflow = createEditorImportWorkflow({
    workspace,
    imageWorkflow: async () => { throw new Error("unexpected image import"); },
    documentId: "doc-1",
    revisionId: () => `draft-${sequences}`,
    sequence: () => { sequences += 1; return sequences; },
    createdAt: () => 1234,
  });
  return {
    adapter, workspace, workflow,
    setFailWrite: (value: boolean) => { failWrite = value; },
  };
}

afterEach(async () => {
  while (integrationDatabases.length > 0) {
    await deleteIndexedDbPersistenceDatabase(integrationDatabases.pop()!);
  }
});

describe("editor import workflow (real durable workspace over fake-indexeddb)", () => {
  it("composes JSON -> PNG -> JSON through the real router with durable content and image ownership", async () => {
    const databaseName = `editor-import-composition-${Date.now()}-${Math.random()}`;
    integrationDatabases.push(databaseName);
    const adapter = createIndexedDbPersistenceAdapter({ databaseName });
    const sha256 = async (bytes: Uint8Array): Promise<string> => {
      const digest = new Uint8Array(
        await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer),
      );
      return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    };
    const handles: { close: ReturnType<typeof vi.fn> }[] = [];
    const decodePng = async (bytes: Uint8Array) => {
      expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
      const handle = { close: vi.fn() };
      handles.push(handle);
      return { width: 20, height: 10, handle };
    };
    const decodeVerifiedPng = async (verified: {
      readonly sha256: string;
      readonly mimeType: "image/png";
      readonly byteLength: number;
      readonly bytes: Uint8Array;
    }) => ({ ...verified, ...await decodePng(verified.bytes) });
    const cache = createPngImageCache({
      importVerifiedPng: async (input) => ({
        sha256: await sha256(input.bytes), mimeType: "image/png",
        byteLength: input.bytes.byteLength, bytes: input.bytes.slice(),
      }),
      decodeVerifiedPng,
    });
    const workspace = createDurableDraftWorkspace({
      persistence: adapter, cache,
      prehydration: {
        rereadVerifiedPng: (sha) => adapter.readAsset(sha),
        decodeVerifiedPng,
      },
    });
    // Separate counters work with both routes' different callback ordering.
    let revisions = 0;
    let sequences = 0;
    const identity = {
      revisionId: () => `draft-${++revisions}`,
      sequence: () => ++sequences,
      createdAt: () => 1234,
    };
    const geometry = { x: 5, y: 6, width: 30, height: 20, opacity: 1 };
    const imageWorkflow = createEditorImageImportWorkflow({
      workspace, assets: adapter, sha256, decodePng, cache, ...identity,
      elementIdSource: () => ({ kind: "id", id: "image-1" }),
      commandId: () => "cmd-1",
      geometry: () => geometry,
    });
    const workflow = createEditorImportWorkflow({
      workspace, imageWorkflow, documentId: "doc-1", ...identity,
    });
    const assertPublication = async (sequence: number, document: SceneDocumentV1) => {
      const revisionId = `draft-${sequence}`;
      const current = workspace.current!;
      expect(current).not.toBeNull();
      expect(current.revision).toEqual(createCompleteRevision({
        documentId: "doc-1", revisionId, sequence, document,
      }));
      expect(current.workspace.plan.document).toEqual(document);
      expect(await adapter.readPointers("doc-1")).toEqual({
        saved: null,
        draft: { kind: "draft", documentId: "doc-1", revisionId, sequence },
      });
      const storedRevision = (await adapter.readRevision("doc-1", revisionId))!;
      expect(storedRevision).toEqual(current.revision);
      expect(storedRevision.document).toEqual(document);
      expect(current.revision.document).toEqual(document);
      return current;
    };

    try {
      // First JSON supplies settings, hierarchy, elements and animated tracks.
      expect(await workflow(jsonRequest(validDocumentJson))).toBeUndefined();
      const first = await assertPublication(1, FIRST_SLICE_DOCUMENT);
      expect(first.workspace.images).toEqual([]);
      expect(handles).toEqual([]);

      expect(await workflow(imageRequest())).toBeUndefined();
      const asset = {
        sha256: await sha256(new Uint8Array([1, 2, 3])),
        mimeType: "image/png" as const, byteLength: 3,
        intrinsicWidth: 20, intrinsicHeight: 10,
      };
      const withImage = {
        ...FIRST_SLICE_DOCUMENT,
        rootIds: [...FIRST_SLICE_DOCUMENT.rootIds, "image-1"],
        elements: [
          ...FIRST_SLICE_DOCUMENT.elements,
          { id: "image-1", type: "image" as const, asset, ...geometry },
        ],
      };
      const png = await assertPublication(2, withImage);
      expect(png).not.toBe(first);
      expect(png.workspace.plan.references).toEqual([{ elementId: "image-1", ...asset }]);
      const storedAsset = (await adapter.readAsset(asset.sha256))!;
      expect(storedAsset.sha256).toBe(asset.sha256);
      expect(storedAsset.mimeType).toBe("image/png");
      expect(storedAsset.byteLength).toBe(3);
      expect(storedAsset.bytes).toEqual(new Uint8Array([1, 2, 3]));
      expect(png.workspace.images).toHaveLength(1);
      const liveImage = png.workspace.images[0]!;
      expect(handles).toHaveLength(2);
      const liveHandle = handles.find((handle) => handle === liveImage.handle)!;
      const discardedHandle = handles.find((handle) => handle !== liveImage.handle)!;
      expect(liveHandle).toBe(handles[0]);
      // Awaiting the route includes its temporary lease release. The publication
      // still owns the adopted handle; prehydration's duplicate was discarded.
      expect(liveHandle.close).not.toHaveBeenCalled();
      expect(discardedHandle.close).toHaveBeenCalledTimes(1);
      expect(cache.resolveImage(liveImage)?.handle).toBe(liveHandle);

      const secondDocument = { ...FIRST_SLICE_DOCUMENT, seed: 73, loop: false };
      expect(await workflow(jsonRequest(JSON.stringify(secondDocument)))).toBeUndefined();
      const second = await assertPublication(3, secondDocument);
      expect(second).not.toBe(png);
      expect(second.workspace.plan.references).toEqual([]);
      expect(second.workspace.images).toEqual([]);
      expect(cache.resolveImage(liveImage)).toBeNull();
      expect(liveHandle.close).toHaveBeenCalledTimes(1);
      expect(discardedHandle.close).toHaveBeenCalledTimes(1);
      png.release();
      second.release();
      second.release();
      expect(liveHandle.close).toHaveBeenCalledTimes(1);
      expect(workspace.current).toBeNull();
    } finally {
      workspace.current?.release();
      cache.clear();
    }
  });

  it("publishes valid JSON through the real durable workspace with injected identity", async () => {
    const f = integrationFixture();
    const result = await f.workflow(jsonRequest(validDocumentJson));
    expect(result).toBeUndefined();
    expect(f.workspace.current).not.toBeNull();
    expect(f.workspace.current!.revision).toMatchObject({
      documentId: "doc-1", revisionId: "draft-1", sequence: 1,
    });
    expect((await f.adapter.readPointers("doc-1")).draft)
      .toMatchObject({ revisionId: "draft-1", sequence: 1 });
  });

  it("preserves the prior publication on invalid JSON and succeeds on a fresh retry", async () => {
    const f = integrationFixture();
    await f.workflow(jsonRequest(validDocumentJson));
    const prior = f.workspace.current;
    expect(prior).not.toBeNull();
    await expect(f.workflow(jsonRequest("{")))
      .rejects.toThrow("SCENE_DOCUMENT_IMPORT_INVALID_JSON");
    expect(f.workspace.current).toBe(prior);
    expect((await f.adapter.readPointers("doc-1")).draft)
      .toMatchObject({ revisionId: "draft-1", sequence: 1 });
    // The workflow is stateless: a fresh retry publishes the fresh request input.
    await f.workflow(jsonRequest(validDocumentJson));
    expect(f.workspace.current).not.toBe(prior);
    expect(f.workspace.current!.revision).toMatchObject({
      revisionId: "draft-3", sequence: 3,
    });
  });

  it("preserves the prior publication through an injected write failure and succeeds on retry", async () => {
    const f = integrationFixture();
    await f.workflow(jsonRequest(validDocumentJson));
    const prior = f.workspace.current;
    expect(prior).not.toBeNull();
    f.setFailWrite(true);
    await expect(f.workflow(jsonRequest(validDocumentJson)))
      .rejects.toThrow("EDITOR_CANONICAL_DRAFT_WRITE_FAILED");
    expect(f.workspace.current).toBe(prior);
    expect((await f.adapter.readPointers("doc-1")).draft)
      .toMatchObject({ revisionId: "draft-1", sequence: 1 });
    f.setFailWrite(false);
    await f.workflow(jsonRequest(validDocumentJson));
    expect(f.workspace.current!.revision).toMatchObject({
      revisionId: "draft-3", sequence: 3,
    });
  });
});
