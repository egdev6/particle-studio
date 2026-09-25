import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";import { mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as settle } from "node:timers/promises";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// The scene-document validation chain loads the generated validator. Prepare it
// before any dynamic import and again before the test block so focused runs
// stay repeatable after a full core run removes the generated module.
const repositoryRootUrl = new URL("../../../", import.meta.url);
const repositoryRoot = fileURLToPath(repositoryRootUrl);
const prepareValidator = () => {
  execFileSync("npm", ["run", "validator:prepare"], {
    cwd: repositoryRoot,
    stdio: "pipe",
  });
};

prepareValidator();

const { FIRST_SLICE_DOCUMENT } = await import("@particle-studio/scene-document");

beforeAll(() => {
  prepareValidator();
});

const APP_DIR = fileURLToPath(new URL("../", import.meta.url));
const MAIN_ENTRY = join(APP_DIR, "src", "main.ts");
const TSX_CLI = join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
const DOCUMENT_ID = "document-1";
const SEED_RELATIVE_PATH = "seed.json";

const TOOL_GET_DRAFT_SUMMARY = "particle_studio.get_draft_summary";
const TOOL_VALIDATE_DRAFT = "particle_studio.validate_draft";
const TOOL_DISPATCH_DRAFT_COMMAND = "particle_studio.dispatch_draft_command";
const TOOL_UNDO = "particle_studio.undo";
const TOOL_REDO = "particle_studio.redo";
const ALL_TOOL_NAMES = [
  TOOL_GET_DRAFT_SUMMARY,
  TOOL_VALIDATE_DRAFT,
  TOOL_DISPATCH_DRAFT_COMMAND,
  TOOL_UNDO,
  TOOL_REDO,
];

interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorObject;
}

interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

type Roots = {
  readonly parent: string;
  readonly workspaceRoot: string;
  readonly documentsRoot: string;
  readonly outputsRoot: string;
};

const REQUEST_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 30_000;

const temporaryParents: string[] = [];
const activeSessions: StdioSession[] = [];

afterEach(async () => {
  const sessions = activeSessions.splice(0, activeSessions.length);
  for (const session of sessions) {
    if (session.child.exitCode === null && session.child.signalCode === null) {
      session.child.kill("SIGKILL");
    }
  }
  await Promise.all(sessions.map((session) => session.waitForExit()));
  const parents = temporaryParents.splice(0, temporaryParents.length);
  await Promise.all(
    parents.map((parent) => rm(parent, { recursive: true, force: true })),
  );
});

async function createRoots(): Promise<Roots> {
  const parent = await mkdtemp(join(tmpdir(), "headless-mcp-stdio-"));
  temporaryParents.push(parent);
  const workspaceRoot = join(parent, "workspace");
  const documentsRoot = join(parent, "documents");
  const outputsRoot = join(parent, "outputs");
  await Promise.all([
    mkdir(workspaceRoot),
    mkdir(documentsRoot),
    mkdir(outputsRoot),
  ]);
  return { parent, workspaceRoot, documentsRoot, outputsRoot };
}

async function writeSeed(roots: Roots): Promise<void> {
  await writeFile(
    join(roots.documentsRoot, SEED_RELATIVE_PATH),
    JSON.stringify(FIRST_SLICE_DOCUMENT),
  );
}

const childEnvironment = (roots: Roots): NodeJS.ProcessEnv => ({
  ...process.env,
  PARTICLE_STUDIO_WORKSPACE_ROOT: roots.workspaceRoot,
  PARTICLE_STUDIO_DOCUMENTS_ROOT: roots.documentsRoot,
  PARTICLE_STUDIO_OUTPUTS_ROOT: roots.outputsRoot,
  PARTICLE_STUDIO_DOCUMENT_ID: DOCUMENT_ID,
  PARTICLE_STUDIO_SEED_PATH: SEED_RELATIVE_PATH,
});

const environmentWithoutWorkspaceVariables = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  const removed = new Set([
    "PARTICLE_STUDIO_WORKSPACE_ROOT",
    "PARTICLE_STUDIO_DOCUMENTS_ROOT",
    "PARTICLE_STUDIO_OUTPUTS_ROOT",
    "PARTICLE_STUDIO_DOCUMENT_ID",
    "PARTICLE_STUDIO_SEED_PATH",
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !removed.has(key)) env[key] = value;
  }
  return env;
};

const setKeyframePayload = (value: number) => ({
  type: "set-keyframe-value",
  trackId: "shape-1:opacity",
  keyframeId: "shape-1:opacity:0",
  value,
});

const envelopeCommand = (
  commandId: string,
  expectedRevision: number,
  value: number,
) => ({
  commandSchemaVersion: 1,
  commandId,
  documentId: DOCUMENT_ID,
  expectedRevision,
  payload: setKeyframePayload(value),
});

const mutatedFirstSliceDocument = (value: number) => {
  // SAFETY: structuredClone returns a fully mutable deep copy of the fixture.
  const document = structuredClone(FIRST_SLICE_DOCUMENT) as {
    tracks: Array<{
      elementId: string;
      property: string;
      keyframes: Array<{ value: number }>;
    }>;
  };
  const track = document.tracks.find(
    (candidate) =>
      candidate.elementId === "shape-1" && candidate.property === "opacity",
  );
  if (track === undefined) throw new Error("fixture must expose the opacity track");
  track.keyframes[0]!.value = value;
  return document;
};

class StdioSession {
  readonly child: ChildProcessWithoutNullStreams;

  private nextId = 0;
  private stdoutBuffer = "";
  private readonly stdoutLines: string[] = [];
  private stderrText = "";
  private readonly waiters = new Map<
    number,
    {
      readonly resolve: (response: JsonRpcResponse) => void;
      readonly reject: (error: Error) => void;
      timer: NodeJS.Timeout | undefined;
    }
  >();
  private exitInfo: ExitInfo | null = null;
  private readonly exitWaiters: Array<(info: ExitInfo) => void> = [];

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrText += chunk;
    });
    child.on("close", (code, signal) => this.onClose(code, signal));
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) break;
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.onStdoutLine(line);
    }
  }

  private onStdoutLine(line: string): void {
    this.stdoutLines.push(line);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const candidate = parsed as { id?: unknown; result?: unknown; error?: unknown };
    if (!("id" in candidate)) return;
    if (typeof candidate.id !== "number") return;
    const waiter = this.waiters.get(candidate.id);
    if (waiter === undefined) return;
    this.waiters.delete(candidate.id);
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    waiter.resolve({
      jsonrpc: "2.0",
      id: candidate.id,
      result: candidate.result,
      error: candidate.error as JsonRpcErrorObject | undefined,
    });
  }

  private onClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitInfo !== null) return;
    this.exitInfo = { code, signal };
    for (const [, waiter] of this.waiters) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.reject(
        new Error(
          `headless-mcp process exited before responding (code=${code}, signal=${signal})\nstderr:\n${this.stderrTail()}`,
        ),
      );
    }
    this.waiters.clear();
    for (const resolve of this.exitWaiters.splice(0, this.exitWaiters.length)) {
      resolve(this.exitInfo);
    }
  }

  stderrTail(): string {
    return this.stderrText.length > 2000
      ? this.stderrText.slice(-2000)
      : this.stderrText;
  }

  request(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = ++this.nextId;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: undefined as NodeJS.Timeout | undefined,
      };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(
          new Error(
            `timed out waiting for response to ${method} (id=${id})\nrecent stdout lines:\n${this.stdoutLines.slice(-6).join("\n")}\nstderr:\n${this.stderrTail()}`,
          ),
        );
      }, REQUEST_TIMEOUT_MS);
      this.waiters.set(id, waiter);
      this.child.stdin.write(line);
    });
  }

  sendRaw(text: string): void {
    this.child.stdin.write(`${text}\n`);
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  closeStdin(): void {
    this.child.stdin.end();
  }

  waitForExit(): Promise<ExitInfo> {
    if (this.exitInfo !== null) return Promise.resolve(this.exitInfo);
    return new Promise<ExitInfo>((resolve) => {
      this.exitWaiters.push(resolve);
      setTimeout(() => {
        resolve({ code: null, signal: "SIGKILL" });
      }, EXIT_TIMEOUT_MS);
    });
  }

  stdoutLinesSnapshot(): readonly string[] {
    return [...this.stdoutLines];
  }

  stderrSnapshot(): string {
    return this.stderrText;
  }

  /** Every stdout line must be a protocol-pure JSON-RPC 2.0 message. */
  expectProtocolPureStdout(): void {
    const lines = this.stdoutLinesSnapshot();
    expect(lines.length, "stdout must carry newline-delimited protocol lines").toBeGreaterThan(0);
    for (const line of lines) {
      let parsed: unknown;
      expect(
        () => {
          parsed = JSON.parse(line);
        },
        `stdout line must be JSON: ${JSON.stringify(line)}`,
      ).not.toThrow();
      expect(
        parsed,
        `stdout line must be a JSON-RPC 2.0 message: ${JSON.stringify(line)}`,
      ).toMatchObject({ jsonrpc: "2.0" });
    }
  }

  expectNoProtocolTrafficOnStderr(): void {
    expect(this.stderrSnapshot()).not.toContain('"jsonrpc"');
    expect(this.stderrSnapshot()).not.toContain('"result"');
    expect(this.stderrSnapshot()).not.toContain('"method"');
  }
}

function startHeadlessServer(env: NodeJS.ProcessEnv): StdioSession {
  const child = spawn(process.execPath, [TSX_CLI, MAIN_ENTRY], {
    cwd: APP_DIR,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const session = new StdioSession(child);
  activeSessions.push(session);
  return session;
}

// Production entry (Dockerfile ENTRYPOINT and `npm start`): the tsx loader is
// imported into the server process itself, so signals reach the server's own
// shutdown handlers with no relay child in between.
function startHeadlessServerDirectEntry(env: NodeJS.ProcessEnv): StdioSession {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: APP_DIR,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const session = new StdioSession(child);
  activeSessions.push(session);
  return session;
}

/**
 * A signal inside the interpreter-boot window (tsx import, workspace-graph
 * require) precedes any in-process handler and dies by default disposition —
 * no server-owned guarantee can cover it, and no external observable marks
 * the moment the entry module finishes evaluating. The race test therefore
 * lets the child settle well past the measured sub-second boot before
 * firing; which branch of the disjunction then runs is decided by the race.
 */
const RACE_SETTLE_MS = 2_500;

async function initializeSession(session: StdioSession): Promise<JsonRpcResponse> {
  const response = await session.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "headless-mcp-integration-test", version: "0.0.0" },
  });
  expect(response.error, "initialize must succeed").toBeUndefined();
  expect(response.result).toBeTypeOf("object");
  session.notify("notifications/initialized");
  return response;
}

const callTool = (
  session: StdioSession,
  name: string,
  args: unknown = {},
): Promise<JsonRpcResponse> =>
  session.request("tools/call", { name, arguments: args });

const toolResultEnvelope = (response: JsonRpcResponse) => {
  expect(response.error).toBeUndefined();
  const result = response.result as
    | { content?: unknown; structuredContent?: unknown; isError?: boolean }
    | undefined;
  expect(result).toBeTypeOf("object");
  const envelope = result!.structuredContent;
  const text = (result!.content as Array<{ type: string; text: string }>)[0]!
    .text as string;
  expect(JSON.parse(text), "content text must match structuredContent").toEqual(
    envelope,
  );
  return {
    envelope: envelope as Record<string, unknown>,
    isError: result!.isError,
  };
};

describe("headless-mcp stdio server", () => {
  it(
    "serves exactly the five headless draft tools with deterministic envelopes",
    async () => {
      const roots = await createRoots();
      await writeSeed(roots);
      const session = startHeadlessServer(childEnvironment(roots));
      await initializeSession(session);

      const listing = await session.request("tools/list", {});
      expect(listing.error).toBeUndefined();
      const tools = (
        listing.result as { tools: Array<{ name: string; inputSchema: unknown }> }
      ).tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual([...ALL_TOOL_NAMES].sort());
      expect(tools).toHaveLength(5);
      for (const tool of tools) {
        expect(tool.inputSchema).toBeTypeOf("object");
      }

      const summary = toolResultEnvelope(await callTool(session, TOOL_GET_DRAFT_SUMMARY));
      expect(summary.isError).toBeFalsy();
      expect(summary.envelope).toMatchObject({
        ok: true,
        summary: { revision: 0, documentId: DOCUMENT_ID },
      });

      const validated = toolResultEnvelope(
        await callTool(session, TOOL_VALIDATE_DRAFT, { document: FIRST_SLICE_DOCUMENT }),
      );
      expect(validated.isError).toBeFalsy();
      expect(validated.envelope).toEqual({ ok: true, value: FIRST_SLICE_DOCUMENT });

      const dispatched = toolResultEnvelope(
        await callTool(session, TOOL_DISPATCH_DRAFT_COMMAND, {
          command: envelopeCommand("command-1", 0, 0.5),
        }),
      );
      expect(dispatched.isError).toBeFalsy();
      expect(dispatched.envelope).toMatchObject({ ok: true, revision: 1 });
      expect(dispatched.envelope.document).toEqual(mutatedFirstSliceDocument(0.5));

      const undone = toolResultEnvelope(await callTool(session, TOOL_UNDO));
      expect(undone.isError).toBeFalsy();
      expect(undone.envelope).toMatchObject({ ok: true, revision: 2 });
      expect(undone.envelope.document).toEqual(FIRST_SLICE_DOCUMENT);

      const redone = toolResultEnvelope(await callTool(session, TOOL_REDO));
      expect(redone.isError).toBeFalsy();
      expect(redone.envelope).toMatchObject({ ok: true, revision: 3 });
      expect(redone.envelope.document).toEqual(mutatedFirstSliceDocument(0.5));

      const finalSummary = toolResultEnvelope(await callTool(session, TOOL_GET_DRAFT_SUMMARY));
      expect(finalSummary.envelope).toMatchObject({
        ok: true,
        summary: { revision: 3 },
      });

      session.closeStdin();
      expect(await session.waitForExit()).toEqual({ code: 0, signal: null });
      session.expectProtocolPureStdout();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects unknown and forbidden tools and malformed arguments with protocol errors",
    async () => {
      const roots = await createRoots();
      await writeSeed(roots);
      const session = startHeadlessServer(childEnvironment(roots));
      await initializeSession(session);

      const unknownTool = await callTool(session, "particle_studio.unknown_tool");
      expect(unknownTool.error?.code).toBe(-32602);

      for (const forbidden of ["fs.read", "shell.exec", "read_file"]) {
        const response = await callTool(session, forbidden);
        expect(response.error?.code, `tool ${forbidden} must not exist`).toBe(-32602);
      }

      // Malformed arguments are rejected by the SDK inside tools/call: they
      // surface as isError results carrying the validation message, without
      // any structuredContent and without ever reaching the workspace.
      const missingDocument = await callTool(session, TOOL_VALIDATE_DRAFT, {});
      expect(missingDocument.error).toBeUndefined();
      const missingResult = missingDocument.result as {
        isError?: boolean;
        structuredContent?: unknown;
        content: Array<{ type: string; text: string }>;
      };
      expect(missingResult.isError).toBe(true);
      expect(missingResult.structuredContent).toBeUndefined();
      expect(missingResult.content[0]!.text).toContain("Invalid arguments");

      const extraKey = await callTool(session, TOOL_VALIDATE_DRAFT, {
        document: FIRST_SLICE_DOCUMENT,
        extra: 1,
      });
      expect(extraKey.error).toBeUndefined();
      const extraKeyResult = extraKey.result as {
        isError?: boolean;
        structuredContent?: unknown;
        content: Array<{ type: string; text: string }>;
      };
      expect(extraKeyResult.isError).toBe(true);
      expect(extraKeyResult.structuredContent).toBeUndefined();
      expect(extraKeyResult.content[0]!.text).toContain("Invalid arguments");

      const nonRecordArguments = await session.request("tools/call", {
        name: TOOL_VALIDATE_DRAFT,
        arguments: "nope",
      });
      expect(nonRecordArguments.error?.code).toBe(-32602);

      const invalidDocument = toolResultEnvelope(
        await callTool(session, TOOL_VALIDATE_DRAFT, { document: { schemaVersion: 2 } }),
      );
      expect(invalidDocument.isError).toBe(true);
      expect(invalidDocument.envelope).toEqual({
        ok: false,
        error: { code: "SCENE_DOCUMENT_SCHEMA_VERSION_UNSUPPORTED" },
      });

      const callerCapability = toolResultEnvelope(
        await callTool(session, TOOL_DISPATCH_DRAFT_COMMAND, {
          command: {
            ...envelopeCommand("command-1", 0, 0.5),
            actorCapability: "headless-agent",
          },
        }),
      );
      expect(callerCapability.isError).toBe(true);
      expect(callerCapability.envelope).toEqual({
        ok: false,
        error: { code: "MALFORMED_COMMAND" },
      });

      const nothingToUndo = toolResultEnvelope(await callTool(session, TOOL_UNDO));
      expect(nothingToUndo.isError).toBe(true);
      expect(nothingToUndo.envelope).toEqual({
        ok: false,
        error: { code: "NOTHING_TO_UNDO" },
      });

      const nothingToRedo = toolResultEnvelope(await callTool(session, TOOL_REDO));
      expect(nothingToRedo.isError).toBe(true);
      expect(nothingToRedo.envelope).toEqual({
        ok: false,
        error: { code: "NOTHING_TO_REDO" },
      });

      // A malformed raw JSON line is consumed silently; the connection stays usable.
      session.sendRaw("{definitely not json");
      const afterMalformed = await session.request("tools/list", {});
      expect(afterMalformed.error).toBeUndefined();
      expect(
        (afterMalformed.result as { tools: Array<{ name: string }> }).tools,
      ).toHaveLength(5);

      session.expectProtocolPureStdout();
      session.closeStdin();
      expect(await session.waitForExit()).toEqual({ code: 0, signal: null });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps stdout protocol-pure, keeps stderr free of protocol traffic, and exits cleanly on stdin EOF",
    async () => {
      const roots = await createRoots();
      await writeSeed(roots);
      const session = startHeadlessServer(childEnvironment(roots));
      await initializeSession(session);

      await session.request("tools/list", {});
      await callTool(session, TOOL_DISPATCH_DRAFT_COMMAND, {
        command: envelopeCommand("command-1", 0, 0.5),
      });
      await callTool(session, TOOL_GET_DRAFT_SUMMARY);

      session.expectNoProtocolTrafficOnStderr();
      session.closeStdin();
      const exit = await session.waitForExit();
      expect(exit).toEqual({ code: 0, signal: null });
      session.expectProtocolPureStdout();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exits cleanly on SIGINT",
    async () => {
      const roots = await createRoots();
      await writeSeed(roots);
      const session = startHeadlessServer(childEnvironment(roots));
      await initializeSession(session);

      session.child.kill("SIGINT");
      const exit = await session.waitForExit();
      expect(exit).toEqual({ code: 0, signal: null });
      session.expectProtocolPureStdout();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exits cleanly on SIGTERM",
    async () => {
      const roots = await createRoots();
      await writeSeed(roots);
      const session = startHeadlessServer(childEnvironment(roots));
      await initializeSession(session);

      session.child.kill("SIGTERM");
      const exit = await session.waitForExit();
      expect(exit).toEqual({ code: 0, signal: null });
      session.expectProtocolPureStdout();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "serializes concurrent mutation calls without interleaving",
    async () => {
      const roots = await createRoots();
      await writeSeed(roots);
      const session = startHeadlessServer(childEnvironment(roots));
      await initializeSession(session);

      const first = callTool(session, TOOL_DISPATCH_DRAFT_COMMAND, {
        command: envelopeCommand("command-a", 0, 0.4),
      });
      const second = callTool(session, TOOL_DISPATCH_DRAFT_COMMAND, {
        command: envelopeCommand("command-b", 1, 0.6),
      });
      const [firstResult, secondResult] = await Promise.all([first, second]);

      const firstEnvelope = toolResultEnvelope(firstResult);
      expect(firstEnvelope.isError).toBeFalsy();
      expect(firstEnvelope.envelope).toMatchObject({ ok: true, revision: 1 });

      const secondEnvelope = toolResultEnvelope(secondResult);
      expect(secondEnvelope.isError).toBeFalsy();
      expect(secondEnvelope.envelope).toMatchObject({ ok: true, revision: 2 });

      const summary = toolResultEnvelope(await callTool(session, TOOL_GET_DRAFT_SUMMARY));
      expect(summary.envelope).toMatchObject({ ok: true, summary: { revision: 2 } });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not open any listening socket and handles pre-initialize requests safely",
    async () => {
      const roots = await createRoots();
      await writeSeed(roots);
      const session = startHeadlessServer(childEnvironment(roots));

      // The official v2 stdio server does not gate requests behind initialize;
      // assert only the stable properties: a well-formed response, a live child,
      // and a fully usable session afterwards.
      const preInitialize = await session.request("tools/list", {});
      expect(preInitialize.jsonrpc).toBe("2.0");
      expect(preInitialize.result !== undefined || preInitialize.error !== undefined).toBe(true);

      await initializeSession(session);
      const listing = await session.request("tools/list", {});
      expect(listing.error).toBeUndefined();
      expect((listing.result as { tools: unknown[] }).tools).toHaveLength(5);

      if (process.platform === "linux") {
        // The stdio binding must not expose any network surface. Every socket
        // descriptor of the child is checked against the kernel TCP tables;
        // a listening socket would necessarily appear there with LISTEN state.
        // Unix-socket descriptors are expected plumbing only when they belong
        // to the stdio socketpairs and the tsx loader IPC — never TCP.
        const fdDir = `/proc/${session.child.pid}/fd`;
        const socketInodes: string[] = [];
        for (const descriptor of await readdir(fdDir)) {
          const target = await readlink(join(fdDir, descriptor));
          if (target.startsWith("socket:")) {
            socketInodes.push(target.slice("socket:[".length, -1));
          }
        }
        const tcpTables = (
          await Promise.all([
            readFile("/proc/net/tcp", "utf8"),
            readFile("/proc/net/tcp6", "utf8"),
          ])
        ).join("\n");
        const tcpRows = tcpTables
          .split("\n")
          .slice(1)
          .map((row) => row.trim().split(/\s+/))
          .filter((columns) => columns.length > 9);
        const matchingTcpRows = tcpRows.filter((columns) =>
          socketInodes.includes(columns[9]!),
        );
        expect(
          matchingTcpRows,
          `the server must not hold any TCP socket, found ${JSON.stringify(matchingTcpRows)}`,
        ).toEqual([]);
        const listeningTcpRows = tcpRows.filter(
          (columns) => columns[3] === "0A" && socketInodes.includes(columns[9]!),
        );
        expect(
          listeningTcpRows,
          "the server must not hold any listening socket",
        ).toEqual([]);
      }

      session.closeStdin();
      expect(await session.waitForExit()).toEqual({ code: 0, signal: null });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fails fast with stderr-only diagnostics when required environment variables are missing",
    async () => {
      const session = startHeadlessServer(environmentWithoutWorkspaceVariables());
      const exit = await session.waitForExit();
      expect(exit.code).not.toBe(0);
      expect(session.stdoutLinesSnapshot()).toEqual([]);
      expect(session.stderrSnapshot()).toContain("PARTICLE_STUDIO_");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fails fast with a stable diagnostic when the seed document is unavailable",
    async () => {
      const roots = await createRoots();
      const env = childEnvironment(roots);
      delete env.PARTICLE_STUDIO_SEED_PATH;
      const session = startHeadlessServer(env);
      const exit = await session.waitForExit();
      expect(exit.code).not.toBe(0);
      expect(session.stdoutLinesSnapshot()).toEqual([]);
      expect(session.stderrSnapshot()).toContain("HEADLESS_WORKSPACE_SEED_UNAVAILABLE");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers every burst request, persists the mutations, and exits 0 when stdin EOF is immediate",
    async () => {
      const roots = await createRoots();
      await writeSeed(roots);
      const session = startHeadlessServer(childEnvironment(roots));

      // One burst, no awaiting: initialize, the tool listing, and two
      // serialized mutations, then stdin is closed immediately. The server
      // must answer every id and persist the mutations instead of dropping
      // them.
      const initializePromise = session.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "headless-mcp-integration-test", version: "0.0.0" },
      });
      session.notify("notifications/initialized");
      const toolsListPromise = session.request("tools/list", {});
      const firstDispatchPromise = callTool(session, TOOL_DISPATCH_DRAFT_COMMAND, {
        command: envelopeCommand("command-a", 0, 0.4),
      });
      const secondDispatchPromise = callTool(session, TOOL_DISPATCH_DRAFT_COMMAND, {
        command: envelopeCommand("command-b", 1, 0.6),
      });
      session.closeStdin();

      const [initialize, toolsList, firstDispatch, secondDispatch] = await Promise.all([
        initializePromise,
        toolsListPromise,
        firstDispatchPromise,
        secondDispatchPromise,
      ]);
      for (const response of [initialize, toolsList, firstDispatch, secondDispatch]) {
        expect(
          response.error,
          `request id=${response.id} must receive a response`,
        ).toBeUndefined();
      }
      const firstEnvelope = toolResultEnvelope(firstDispatch);
      expect(firstEnvelope.envelope).toMatchObject({ ok: true, revision: 1 });
      const secondEnvelope = toolResultEnvelope(secondDispatch);
      expect(secondEnvelope.envelope).toMatchObject({ ok: true, revision: 2 });

      // Exactly one response per request id on stdout.
      const responseIdCounts = new Map<number, number>();
      for (const line of session.stdoutLinesSnapshot()) {
        const parsed = JSON.parse(line) as { id?: unknown };
        if (!("id" in parsed)) continue;
        expect(typeof parsed.id, `response id must be numeric: ${line}`).toBe("number");
        const id = parsed.id as number;
        responseIdCounts.set(id, (responseIdCounts.get(id) ?? 0) + 1);
      }
      expect([...responseIdCounts.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
      for (const [id, count] of responseIdCounts) {
        expect(count, `request id=${id} must be answered exactly once`).toBe(1);
      }

      session.expectProtocolPureStdout();
      session.expectNoProtocolTrafficOnStderr();
      expect(await session.waitForExit()).toEqual({ code: 0, signal: null });

      // The mutations must be durable: restart on the same roots without a
      // seed and read the summary at the persisted revision.
      const restartEnvironment = childEnvironment(roots);
      delete restartEnvironment.PARTICLE_STUDIO_SEED_PATH;
      const restarted = startHeadlessServer(restartEnvironment);
      await initializeSession(restarted);
      const afterRestart = toolResultEnvelope(
        await callTool(restarted, TOOL_GET_DRAFT_SUMMARY),
      );
      expect(afterRestart.isError).toBeFalsy();
      expect(afterRestart.envelope).toMatchObject({
        ok: true,
        summary: { revision: 2, documentId: DOCUMENT_ID },
      });
      restarted.closeStdin();
      expect(await restarted.waitForExit()).toEqual({ code: 0, signal: null });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exits non-zero with a pre-ready diagnostic when SIGTERM lands during startup with buffered requests",
    async () => {
      const roots = await createRoots();
      await writeSeed(roots);
      const session = startHeadlessServerDirectEntry(childEnvironment(roots));

      // Write a burst immediately, then fire SIGTERM once the child has
      // settled well past its boot window. The race decides which branch
      // runs, so the assertion is the disjunction: either the server was ready and every
      // request id is answered with exit 0, or it was not ready and the exit
      // is non-zero with the pre-ready diagnostic. It must NEVER be exit 0
      // with unanswered requests and no diagnostic.
      const burstSize = 40;
      const burstIds = Array.from({ length: burstSize }, (_, index) => index + 1);
      session.sendRaw(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "headless-mcp-integration-test", version: "0.0.0" },
          },
        })}\n`,
      );
      for (const id of burstIds.slice(1)) {
        session.sendRaw(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} })}\n`);
      }
      // The burst is written immediately; the signal fires once the child
      // has settled well past its boot window (see the settle note above).
      await settle(RACE_SETTLE_MS);
      session.child.kill("SIGTERM");

      const exit = await session.waitForExit();
      const answeredIds = new Set<number>();
      for (const line of session.stdoutLinesSnapshot()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof parsed !== "object" || parsed === null) continue;
        const candidate = parsed as { id?: unknown };
        if (typeof candidate.id !== "number") continue;
        answeredIds.add(candidate.id);
      }

      if (exit.code === 0) {
        // Ready branch: the server reached readiness before the trigger, so
        // every request id must be answered — never exit 0 with unanswered
        // requests and no diagnostic.
        expect(exit.signal, "an exit-0 shutdown must be signal-free").toBeNull();
        for (const id of burstIds) {
          expect(
            answeredIds.has(id),
            `exit 0 requires every request id to be answered; id=${id} was not`,
          ).toBe(true);
        }
        session.expectProtocolPureStdout();
      } else {
        // Pre-ready branch: non-zero exit with exactly one deterministic
        // pre-ready diagnostic naming the trigger and the received bytes.
        expect(exit.signal, "a pre-ready shutdown must be signal-free").toBeNull();
        expect(exit.code, "dropped buffered work must exit non-zero").not.toBe(0);
        const stderr = session.stderrSnapshot();
        expect(stderr, "a pre-ready shutdown must carry its diagnostic").toContain(
          "shutdown before startup",
        );
        expect(stderr, "the pre-ready diagnostic must name the trigger").toContain(
          "SIGTERM",
        );
        expect(
          (stderr.match(/shutdown before startup/g) ?? []).length,
          "exactly one pre-ready diagnostic is allowed",
        ).toBe(1);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exits 0 when stdin closes immediately with nothing written",
    async () => {
      const roots = await createRoots();
      await writeSeed(roots);
      const session = startHeadlessServerDirectEntry(childEnvironment(roots));
      session.closeStdin();
      const exit = await session.waitForExit();
      expect(exit).toEqual({ code: 0, signal: null });
      // Nothing was ever written, so no protocol traffic and no unanswered
      // request can exist.
      expect(session.stderrSnapshot()).not.toContain('"jsonrpc"');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps an interrupted mutation observable: its response arrives and its revision persists",
    async () => {
      const roots = await createRoots();
      await writeSeed(roots);
      const session = startHeadlessServer(childEnvironment(roots));

      const initializePromise = session.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "headless-mcp-integration-test", version: "0.0.0" },
      });
      session.notify("notifications/initialized");
      const dispatchPromise = callTool(session, TOOL_DISPATCH_DRAFT_COMMAND, {
        command: envelopeCommand("command-1", 0, 0.5),
      });
      session.closeStdin();

      const [, dispatch] = await Promise.all([initializePromise, dispatchPromise]);
      expect(dispatch.error, "the mutation must be answered, not dropped").toBeUndefined();
      const envelope = toolResultEnvelope(dispatch);
      expect(envelope.isError).toBeFalsy();
      expect(envelope.envelope).toMatchObject({ ok: true, revision: 1 });

      session.expectNoProtocolTrafficOnStderr();
      expect(await session.waitForExit()).toEqual({ code: 0, signal: null });

      // The interrupted mutation must be durable, observable through the
      // persisted revision rather than only through the exit code.
      const restartEnvironment = childEnvironment(roots);
      delete restartEnvironment.PARTICLE_STUDIO_SEED_PATH;
      const restarted = startHeadlessServer(restartEnvironment);
      await initializeSession(restarted);
      const afterRestart = toolResultEnvelope(
        await callTool(restarted, TOOL_GET_DRAFT_SUMMARY),
      );
      expect(afterRestart.isError).toBeFalsy();
      expect(afterRestart.envelope).toMatchObject({
        ok: true,
        summary: { revision: 1, documentId: DOCUMENT_ID },
      });
      restarted.closeStdin();
      expect(await restarted.waitForExit()).toEqual({ code: 0, signal: null });
    },
    TEST_TIMEOUT_MS,
  );
});
