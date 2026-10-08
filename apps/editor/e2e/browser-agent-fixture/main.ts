import { createCommandSession } from "@particle-studio/commands";
import {
  FIRST_SLICE_DOCUMENT,
  validateSceneDocument,
} from "@particle-studio/scene-document";

import { createBrowserAgentWorkspaceAdapter } from "../../src/browser-agent-workspace-port";

const output = document.querySelector<HTMLElement>(
  '[data-testid="browser-agent-fixture-result"]',
);
const runButton = document.querySelector<HTMLButtonElement>("#run-proof");

if (output === null || runButton === null) {
  throw new Error("BROWSER_AGENT_FIXTURE_DOM_UNAVAILABLE");
}

const fixtureOutput = output;
const fixtureRunButton = runButton;

const request = (
  requestId: string,
  tool: string,
  input: Record<string, unknown>,
) => ({ schemaVersion: 1, requestId, tool, input });

async function runProof(): Promise<void> {
  const directSession = createCommandSession("draft-1", FIRST_SLICE_DOCUMENT);
  const adapterSession = createCommandSession("draft-1", FIRST_SLICE_DOCUMENT);
  let portCalls = 0;
  const adapter = createBrowserAgentWorkspaceAdapter({
    documentId: "draft-1",
    async snapshot() {
      portCalls += 1;
      return adapterSession.snapshot();
    },
    async dispatch(command) {
      portCalls += 1;
      return { result: adapterSession.dispatch(command) };
    },
    async undo() {
      portCalls += 1;
      return { result: adapterSession.undo() };
    },
    async redo() {
      portCalls += 1;
      return { result: adapterSession.redo() };
    },
  });

  const initial = {
    direct: directSession.snapshot(),
    adapter: adapterSession.snapshot(),
  };
  const command = {
    commandSchemaVersion: 1,
    commandId: "change-opacity",
    documentId: "draft-1",
    expectedRevision: 0,
    payload: {
      type: "change-keyframe",
      elementId: "shape-1",
      property: "opacity",
      timeUs: 0,
      value: 0.5,
    },
  };
  const directCommand = { ...command, actorCapability: "browser-agent" };
  const dispatchResponse = await adapter.execute(
    request("dispatch", "particle_studio.dispatch_draft_command", { command }),
  );
  const dispatch = {
    direct: directSession.dispatch(directCommand),
    adapter:
      "result" in dispatchResponse ? dispatchResponse.result : dispatchResponse,
  };
  const afterDispatch = {
    direct: directSession.snapshot(),
    adapter: adapterSession.snapshot(),
  };

  const undoResponse = await adapter.execute(
    request("undo", "particle_studio.undo", {}),
  );
  const undo = {
    direct: directSession.undo(),
    adapter: "result" in undoResponse ? undoResponse.result : undoResponse,
  };
  const afterUndo = {
    direct: directSession.snapshot(),
    adapter: adapterSession.snapshot(),
  };

  const redoResponse = await adapter.execute(
    request("redo", "particle_studio.redo", {}),
  );
  const redo = {
    direct: directSession.redo(),
    adapter: "result" in redoResponse ? redoResponse.result : redoResponse,
  };
  const afterRedo = {
    direct: directSession.snapshot(),
    adapter: adapterSession.snapshot(),
  };

  const summaryResponse = await adapter.execute(
    request("summary", "particle_studio.get_draft_summary", {}),
  );
  const expectedSummary = {
    ok: true,
    summary: {
      documentId: "draft-1",
      revision: afterRedo.direct.revision,
      schemaVersion: afterRedo.direct.document.schemaVersion,
      durationUs: afterRedo.direct.document.durationUs,
      playbackRange: afterRedo.direct.document.playbackRange,
      loop: afterRedo.direct.document.loop,
      elementCount: afterRedo.direct.document.elements.length,
      trackCount: afterRedo.direct.document.tracks.length,
    },
  };
  const validationBefore = adapterSession.snapshot();
  const validationResponse = await adapter.execute(
    request("validate", "particle_studio.validate_draft", {
      document: validationBefore.document,
    }),
  );
  const validationAfter = adapterSession.snapshot();

  portCalls = 0;
  const deniedResponse = await adapter.execute(
    request("denied", "particle_studio.approve_draft", {}),
  );

  const cloneSource = { nested: { value: 1 } };
  const clone = structuredClone(cloneSource);
  clone.nested.value = 2;
  const promiseSettlement = await Promise.resolve(dispatchResponse).then(
    (response) => "result" in response,
  );

  fixtureOutput.textContent = JSON.stringify({
    tools: adapter.tools.map(({ name }) => name),
    operations: {
      dispatch,
      undo,
      redo,
      snapshots: {
        initial,
        dispatch: afterDispatch,
        undo: afterUndo,
        redo: afterRedo,
      },
    },
    summary: {
      result:
        "result" in summaryResponse ? summaryResponse.result : summaryResponse,
      expected: expectedSummary,
      keys: Object.keys(expectedSummary.summary),
    },
    validation: {
      result:
        "result" in validationResponse
          ? validationResponse.result
          : validationResponse,
      expected: validateSceneDocument(validationBefore.document),
      snapshotBefore: validationBefore,
      snapshotAfter: validationAfter,
    },
    denied: {
      response: deniedResponse,
      portCalls,
    },
    responses: [
      dispatchResponse,
      undoResponse,
      redoResponse,
      summaryResponse,
      validationResponse,
      deniedResponse,
    ],
    browserRuntime: {
      structuredClone: clone !== cloneSource && cloneSource.nested.value === 1,
      promiseSettlement,
    },
  });
}

fixtureRunButton.addEventListener("click", () => {
  void runProof();
});
