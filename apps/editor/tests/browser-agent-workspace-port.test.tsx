import { describe, expect, it, vi } from "vitest";
import {
  FIRST_SLICE_DOCUMENT,
  validateSceneDocument,
  type SceneDocumentV1,
} from "@particle-studio/scene-document";
import {
  createBrowserAgentWorkspaceAdapter,
  createBrowserAgentWorkspacePort,
} from "../src/browser-agent-workspace-port.js";

const documentId = "editor-document";

function command(value: number, expectedRevision = 0) {
  return {
    commandSchemaVersion: 1,
    commandId: `command-${value}`,
    documentId,
    expectedRevision,
    payload: {
      type: "set-keyframe-value",
      trackId: "shape-1:opacity",
      keyframeId: "shape-1:opacity:0",
      value,
    },
  };
}

function request(tool: string, input: unknown, requestId = "request-1") {
  return { schemaVersion: 1, requestId, tool, input };
}

function createSurface() {
  const snapshot: { revision: number; document: SceneDocumentV1 } = {
    revision: 4,
    document: structuredClone(FIRST_SLICE_DOCUMENT),
  };
  const calls: string[] = [];
  const takeSnapshot = vi.fn<
    () => Promise<{ revision: number; document: SceneDocumentV1 } | null>
  >(async () => {
    calls.push("snapshot");
    return snapshot;
  });
  return {
    calls,
    snapshot,
    surface: {
      documentId,
      snapshot: takeSnapshot,
      dispatch: vi.fn<
        (value: unknown) => Promise<{ readonly result: unknown }>
      >(async (value) => {
        calls.push("dispatch");
        return { result: { ok: true, revision: 5, document: value } };
      }),
      undo: vi.fn(async () => {
        calls.push("undo");
        return { result: { ok: false, error: { code: "NOTHING_TO_UNDO" } } };
      }),
      redo: vi.fn(async () => {
        calls.push("redo");
        return { result: { ok: false, error: { code: "NOTHING_TO_REDO" } } };
      }),
    },
  };
}

describe("browser agent workspace port", () => {
  it("returns only a fresh exact draft summary and maps an unavailable snapshot", async () => {
    const { surface, snapshot } = createSurface();
    const port = createBrowserAgentWorkspacePort(surface);

    await expect(port.getDraftSummary()).resolves.toEqual({
      ok: true,
      summary: {
        documentId,
        revision: 4,
        schemaVersion: 1,
        durationUs: FIRST_SLICE_DOCUMENT.durationUs,
        playbackRange: { ...FIRST_SLICE_DOCUMENT.playbackRange },
        loop: FIRST_SLICE_DOCUMENT.loop,
        elementCount: FIRST_SLICE_DOCUMENT.elements.length,
        trackCount: FIRST_SLICE_DOCUMENT.tracks.length,
      },
    });
    const first = (await port.getDraftSummary()) as
      | { ok: true; summary: { playbackRange: { startUs: number } } }
      | { ok: false };
    if (!first.ok) throw new Error("expected summary");
    first.summary.playbackRange.startUs = 99;
    expect(snapshot.document.playbackRange.startUs).toBe(0);
    await expect(port.getDraftSummary()).resolves.toMatchObject({
      summary: { playbackRange: { startUs: 0 } },
    });

    surface.snapshot.mockResolvedValueOnce(null);
    await expect(port.getDraftSummary()).resolves.toEqual({
      ok: false,
      error: { code: "DURABLE_COMMAND_UNAVAILABLE" },
    });
  });

  it("uses validation directly without touching the command surface", () => {
    const { surface } = createSurface();
    const port = createBrowserAgentWorkspacePort(surface);
    const candidate = structuredClone(FIRST_SLICE_DOCUMENT);

    expect(port.validateDraft(candidate)).toEqual(
      validateSceneDocument(candidate),
    );
    expect(surface.snapshot).not.toHaveBeenCalled();
    expect(surface.dispatch).not.toHaveBeenCalled();
    expect(surface.undo).not.toHaveBeenCalled();
    expect(surface.redo).not.toHaveBeenCalled();
  });

  it("unwraps only each command operation result in order", async () => {
    const { surface, calls } = createSurface();
    const port = createBrowserAgentWorkspacePort(surface);
    const dispatched = await port.dispatch(command(0.25));

    expect(dispatched).toEqual({
      ok: true,
      revision: 5,
      document: command(0.25),
    });
    await expect(port.undo()).resolves.toEqual({
      ok: false,
      error: { code: "NOTHING_TO_UNDO" },
    });
    await expect(port.redo()).resolves.toEqual({
      ok: false,
      error: { code: "NOTHING_TO_REDO" },
    });
    expect(calls).toEqual(["dispatch", "undo", "redo"]);
    expect(surface.dispatch).toHaveBeenCalledOnce();
    expect(surface.undo).toHaveBeenCalledOnce();
    expect(surface.redo).toHaveBeenCalledOnce();
  });

  it("composes the five-tool adapter, forwards domain results, and isolates caller and result mutation", async () => {
    const { surface } = createSurface();
    const adapter = createBrowserAgentWorkspaceAdapter(surface);
    const suppliedCommand = command(0.25);

    expect(
      adapter.tools.map((tool: { readonly name: string }) => tool.name),
    ).toEqual([
      "particle_studio.get_draft_summary",
      "particle_studio.validate_draft",
      "particle_studio.dispatch_draft_command",
      "particle_studio.undo",
      "particle_studio.redo",
    ]);
    const responsePromise = adapter.execute(
      request("particle_studio.dispatch_draft_command", {
        command: suppliedCommand,
      }),
    );
    suppliedCommand.payload.value = 0.75;
    const response = await responsePromise;
    expect(surface.dispatch).toHaveBeenCalledWith({
      ...command(0.25),
      actorCapability: "browser-agent",
    });
    expect(response).toEqual({
      schemaVersion: 1,
      requestId: "request-1",
      result: {
        ok: true,
        revision: 5,
        document: { ...command(0.25), actorCapability: "browser-agent" },
      },
    });
    if (!("result" in response)) throw new Error("expected result");
    expect(() => {
      (
        response.result as { document: { payload: { value: number } } }
      ).document.payload.value = 1;
    }).toThrow(TypeError);
    await expect(
      adapter.execute(
        request("particle_studio.dispatch_draft_command", {
          command: command(0.25),
        }),
      ),
    ).resolves.toMatchObject({
      result: { document: { payload: { value: 0.25 } } },
    });

    await expect(
      adapter.execute(
        request("particle_studio.validate_draft", { document: {} }),
      ),
    ).resolves.toEqual({
      schemaVersion: 1,
      requestId: "request-1",
      result: validateSceneDocument({}),
    });
  });

  it("preserves stale and invalid domain results without touching unavailable authority", async () => {
    const { surface } = createSurface();
    const adapter = createBrowserAgentWorkspaceAdapter(surface);
    const stale = { ok: false, error: { code: "REVISION_CONFLICT" } };
    const invalid = { ok: false, error: { code: "COMMAND_SCHEMA_INVALID" } };
    surface.dispatch.mockResolvedValueOnce({ result: stale });
    surface.undo.mockResolvedValueOnce({ result: invalid });

    await expect(
      adapter.execute(
        request("particle_studio.dispatch_draft_command", {
          command: command(0.25),
        }),
      ),
    ).resolves.toEqual({
      schemaVersion: 1,
      requestId: "request-1",
      result: stale,
    });
    await expect(
      adapter.execute(request("particle_studio.undo", {})),
    ).resolves.toEqual({
      schemaVersion: 1,
      requestId: "request-1",
      result: invalid,
    });
    expect(surface.snapshot).not.toHaveBeenCalled();
    expect(surface.redo).not.toHaveBeenCalled();
  });

  it("denies unavailable tools before the surface and delegates concurrent serialization to it", async () => {
    const { surface, calls } = createSurface();
    const adapter = createBrowserAgentWorkspaceAdapter(surface);
    await expect(
      adapter.execute(request("particle_studio.approve_draft", {})),
    ).resolves.toMatchObject({ error: { code: "WEBMCP_TOOL_NOT_FOUND" } });
    expect(calls).toEqual([]);

    let tail = Promise.resolve();
    surface.dispatch.mockImplementation((value: unknown) => {
      const operation = tail.then(async () => {
        calls.push(`start:${(value as { commandId: string }).commandId}`);
        await Promise.resolve();
        calls.push(`end:${(value as { commandId: string }).commandId}`);
        return { result: { ok: true } };
      });
      tail = operation.then(() => undefined);
      return operation;
    });
    await Promise.all([
      adapter.execute(
        request("particle_studio.dispatch_draft_command", {
          command: command(0.25),
        }),
      ),
      adapter.execute(
        request(
          "particle_studio.dispatch_draft_command",
          { command: command(0.5) },
          "request-2",
        ),
      ),
    ]);
    expect(calls).toEqual([
      "start:command-0.25",
      "end:command-0.25",
      "start:command-0.5",
      "end:command-0.5",
    ]);
  });
});
