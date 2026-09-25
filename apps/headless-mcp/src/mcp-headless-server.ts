import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { HeadlessDraftWorkspace } from "./headless-draft-workspace.js";

/**
 * Stable code for the only envelope the MCP layer may invent on its own: the
 * workspace layer violated its result-only contract (rejected, threw, or
 * returned something unserializable). The envelope carries no cause, stack, or
 * message text so it stays deterministic across runs.
 */
export const WORKSPACE_UNAVAILABLE_CODE = "WORKSPACE_UNAVAILABLE";

const SERVER_INFO = {
  name: "particle-studio-headless-mcp",
  version: "0.0.0",
} as const;

type WorkspaceEnvelope = { readonly ok: unknown } & Record<string, unknown>;

const workspaceUnavailableEnvelope = (): WorkspaceEnvelope => ({
  ok: false,
  error: { code: WORKSPACE_UNAVAILABLE_CODE },
});

const isWorkspaceDenial = (envelope: unknown): boolean =>
  typeof envelope === "object" && envelope !== null && !Array.isArray(envelope)
    ? (envelope as { ok?: unknown }).ok === false
    : false;

/**
 * Maps one workspace result to the deterministic tool result: the full
 * envelope is serialized once into JSON text `content` and attached as the
 * matching `structuredContent`. Domain denials (`ok: false`) map to
 * `isError: true` without exposing causes or stacks.
 */
const toWorkspaceToolResult = (result: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: unknown;
  isError?: boolean;
} => {
  try {
    // SAFETY: ownership boundary parity with the browser adapter — the tool
    // layer never retains or mutates workspace-internal objects. Node 24 and
    // supported runtimes provide structuredClone for JSON values.
    const owned = structuredClone(result) as WorkspaceEnvelope;
    return {
      content: [{ type: "text", text: JSON.stringify(owned) }],
      structuredContent: owned,
      ...(isWorkspaceDenial(owned) ? { isError: true } : {}),
    };
  } catch {
    const envelope = workspaceUnavailableEnvelope();
    return {
      content: [{ type: "text", text: JSON.stringify(envelope) }],
      structuredContent: envelope,
      isError: true,
    };
  }
};

/**
 * Runs one workspace operation and folds every outcome into a deterministic
 * tool result. Workspace operations are result-only by contract and never
 * reject; this guard keeps an unexpected violation inside the stable
 * workspace-unavailable envelope instead of leaking into an SDK handler
 * error that would echo the failure text back on the wire.
 */
const runWorkspaceOperation = async (
  operation: () => unknown | Promise<unknown>,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent: unknown;
  isError?: boolean;
}> => {
  try {
    return toWorkspaceToolResult(await operation());
  } catch {
    return toWorkspaceToolResult(workspaceUnavailableEnvelope());
  }
};

/**
 * Builds the headless MCP server instance for one workspace: exactly the five
 * result-only draft tools, mirroring the WebMCP browser adapter surface.
 * Input schemas are strict Zod v4 objects, so unknown or missing top-level
 * argument keys are rejected by the SDK as invalid params.
 */
export function createHeadlessMcpServer(
  workspace: HeadlessDraftWorkspace,
): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
  });

  server.registerTool(
    "particle_studio.get_draft_summary",
    {
      description:
        "Return the durable headless draft summary: current revision, saved state, and canonical document identity.",
      inputSchema: z.strictObject({}),
    },
    () => runWorkspaceOperation(() => workspace.getDraftSummary()),
  );

  server.registerTool(
    "particle_studio.validate_draft",
    {
      description:
        "Validate a candidate scene document against the Scene Document v1 contract without mutating the workspace.",
      inputSchema: z.strictObject({ document: z.unknown().nonoptional() }),
    },
    ({ document }: { document: unknown }) =>
      runWorkspaceOperation(() => workspace.validateDraft(document)),
  );

  server.registerTool(
    "particle_studio.dispatch_draft_command",
    {
      description:
        "Dispatch one headless draft command envelope through the durable headless workspace.",
      inputSchema: z.strictObject({ command: z.unknown().nonoptional() }),
    },
    ({ command }: { command: unknown }) =>
      runWorkspaceOperation(() => workspace.dispatch(command)),
  );

  server.registerTool(
    "particle_studio.undo",
    {
      description: "Undo the last dispatched headless draft command.",
      inputSchema: z.strictObject({}),
    },
    () => runWorkspaceOperation(() => workspace.undo()),
  );

  server.registerTool(
    "particle_studio.redo",
    {
      description: "Redo the most recently undone headless draft command.",
      inputSchema: z.strictObject({}),
    },
    () => runWorkspaceOperation(() => workspace.redo()),
  );

  return server;
}
