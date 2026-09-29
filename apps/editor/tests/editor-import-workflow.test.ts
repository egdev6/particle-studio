import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIRST_SLICE_DOCUMENT } from "@particle-studio/scene-document";
import { createCompleteRevision } from "@particle-studio/persistence";
import {
  createIndexedDbPersistenceAdapter, deleteIndexedDbPersistenceDatabase,
} from "@particle-studio/persistence-indexeddb";
import { createPngImageCache } from "../src/png-image-cache.js";
import { createDurableDraftWorkspace } from "../src/durable-draft-workspace.js";
import type { DurableDraftPublication, DurableDraftPublishInput } from "../src/durable-draft-workspace.js";
import { createEditorImportWorkflow } from "../src/editor-import-workflow.js";
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
