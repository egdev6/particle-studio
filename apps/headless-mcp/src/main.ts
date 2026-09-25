import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createRequire } from "node:module";
import { withRequestDrain } from "./draining-transport.js";
import type { HeadlessDraftWorkspace } from "./headless-draft-workspace.js";
import { createHeadlessMcpServer } from "./mcp-headless-server.js";
import {
  SHUTDOWN_DRAIN_TIMEOUT_MS,
  createRequestDrain,
  decidePreReadyExitCode,
  decideShutdownExitCode,
  formatDrainTimeoutDiagnostic,
  formatShutdownBeforeReadyDiagnostic,
  type RequestDrain,
} from "./request-drain.js";

// SAFETY: the headless workspace graph is consumed through Node's CommonJS
// require path. The generated Scene Document v1 validator is emitted as an ES
// module that calls `require()` for the ajv runtime helper, which only
// resolves when the module is loaded through `require(esm)`. Evaluating that
// file in static ESM scope would crash with `require is not defined`, so the
// workspace (and everything it imports) is required instead of imported. The
// MCP server module itself carries no scene-document dependency and stays a
// plain static ESM import.
const workspaceGraphRequire = createRequire(import.meta.url);
const {
  createHeadlessDraftWorkspace,
  HeadlessWorkspaceError,
} = workspaceGraphRequire("./headless-draft-workspace.js") as typeof import("./headless-draft-workspace.js");

/**
 * Startup diagnostics are stderr-only and deterministic: they name the failure
 * class (or stable workspace error code) and never carry causes or stacks.
 * stdout stays protocol-pure for the MCP stdio binding.
 */
function emitStartupDiagnostic(message: string): void {
  process.stderr.write(`headless-mcp: ${message}\n`);
}

function failStartup(message: string): never {
  emitStartupDiagnostic(message);
  process.exit(1);
}

function requireEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    failStartup(`missing required environment variable ${name}`);
  }
  return value;
}

async function createConfiguredWorkspace(): Promise<HeadlessDraftWorkspace> {
  const workspaceRoot = requireEnvironmentValue("PARTICLE_STUDIO_WORKSPACE_ROOT");
  const documentsRoot = requireEnvironmentValue("PARTICLE_STUDIO_DOCUMENTS_ROOT");
  const outputsRoot = requireEnvironmentValue("PARTICLE_STUDIO_OUTPUTS_ROOT");
  const documentId = requireEnvironmentValue("PARTICLE_STUDIO_DOCUMENT_ID");
  const seedValue = process.env.PARTICLE_STUDIO_SEED_PATH;
  const seedPath =
    seedValue === undefined || seedValue === "" ? undefined : seedValue;
  try {
    return await createHeadlessDraftWorkspace({
      documentId,
      workspaceRoot,
      documentsRoot,
      outputsRoot,
      seedPath,
    });
  } catch (error: unknown) {
    if (error instanceof HeadlessWorkspaceError) {
      failStartup(`workspace startup failed: ${error.code}`);
    }
    failStartup("unexpected workspace startup failure");
  }
}

// Shutdown triggers are installed BEFORE the workspace is created. A
// SIGTERM/SIGINT arriving during startup must not kill the process by
// default disposition: nothing answered, no diagnostic, no drain. The single
// idempotent shutdown path below is aware of whether the server reached
// readiness.
//
// SAFETY: the pre-ready policy counts received-but-unanswered bytes with
// `process.stdin.readableLength`, which only reports bytes pulled into the
// stream's internal buffer. A paused stdin with no reader never pulls, so
// the count would stay 0 even with a full kernel pipe (verified
// empirically). Attaching an early `data` listener is NOT an option: flowing
// mode with no consumer would consume chunks the SDK transport never sees
// and silently LOSE buffered requests. A `readable` listener is the
// non-destructive alternative: it starts the underlying read and parks
// bytes in the internal buffer, from where the SDK transport later receives
// them in order, while `readableLength` reports the honest count.
const onStdinReadable = (): void => {};
process.stdin.on("readable", onStdinReadable);

interface ShutdownState {
  closing: boolean;
  ready: boolean;
  drain: RequestDrain | null;
  handle: { close(): Promise<void> } | null;
}

const shutdownState: ShutdownState = {
  closing: false,
  ready: false,
  drain: null,
  handle: null,
};

async function onShutdownTrigger(trigger: string): Promise<void> {
  if (shutdownState.closing) return;
  shutdownState.closing = true;
  if (
    !shutdownState.ready ||
    shutdownState.drain === null ||
    shutdownState.handle === null
  ) {
    // Give one macrotask turn for the startup stdin read to land any bytes
    // the client had already written into the stream buffer, so the received
    // byte count below is truthful.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (
      !shutdownState.ready ||
      shutdownState.drain === null ||
      shutdownState.handle === null
    ) {
      // Pre-ready: nothing can be drained yet. Exit 0 only when the client
      // had not written anything; received-but-unread bytes mean dropped
      // work, so the exit is non-zero. Either way exactly one deterministic
      // diagnostic names the trigger and the received byte count.
      const receivedBytes = process.stdin.readableLength;
      process.stderr.write(
        `${formatShutdownBeforeReadyDiagnostic({ trigger, receivedBytes })}\n`,
      );
      process.exit(decidePreReadyExitCode({ receivedBytes }));
    }
  }
  const drain = shutdownState.drain;
  const handle = shutdownState.handle;
  if (drain === null || handle === null) return; // unreachable; narrows types
  void (async () => {
    // Wait for already-received requests to be answered, bounded by a fixed
    // timeout. A timed-out drain is reported once on stderr and turned into a
    // non-zero exit so a supervisor can tell clean shutdown from dropped work.
    const drained = await drain.whenIdle(SHUTDOWN_DRAIN_TIMEOUT_MS);
    if (!drained) {
      process.stderr.write(`${formatDrainTimeoutDiagnostic(drain.pending())}\n`);
    }
    await handle.close();
    process.exit(decideShutdownExitCode({ drained, requestedExitCode: 0 }));
  })();
}

process.stdin.once("end", () => onShutdownTrigger("stdin end"));
process.once("SIGINT", () => onShutdownTrigger("SIGINT"));
process.once("SIGTERM", () => onShutdownTrigger("SIGTERM"));

const workspace = await createConfiguredWorkspace();

// The startup stdin pull must be removed BEFORE the transport attaches its
// own `data` listener: a lingering `readable` listener alongside flowing
// mode makes the stream swallow data (verified empirically). Bytes already
// parked in the internal buffer are flushed to the transport in order once
// flowing mode starts, so nothing written before readiness is lost.
process.stdin.off("readable", onStdinReadable);

// Requests are counted at the wire boundary through a wrapped transport: a
// request is pending from the moment the wire delivers it until its result or
// error response is sent, or a cancellation for it arrives.
const drain = createRequestDrain();
const handle = serveStdio(() => createHeadlessMcpServer(workspace), {
  transport: withRequestDrain(new StdioServerTransport(), drain),
});
shutdownState.drain = drain;
shutdownState.handle = handle;
shutdownState.ready = true;
