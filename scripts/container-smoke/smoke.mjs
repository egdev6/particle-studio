// Versioned hardened headless-container smoke harness (H3). Runs four
// documented `docker run --rm -i` smoke sessions against one evidence root and
// records every observation under that root. No repository writes.
//
// Configuration (environment variables):
//   PARTICLE_STUDIO_SMOKE_IMAGE     image reference to smoke (default
//                                   particle-studio-headless-mcp:d1-smoke)
//   PARTICLE_STUDIO_SMOKE_EVIDENCE  required: evidence root to create and fill
//   PARTICLE_STUDIO_SMOKE_SEED      optional: path to a seed document; when
//                                   absent the harness writes its own
//                                   reference seed into documents/seed.json
//
// In-container helper scripts are resolved from this harness's own directory,
// never from a hard-coded path.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_PATH = fileURLToPath(import.meta.url);
const HARNESS_DIR = dirname(HARNESS_PATH);

// Accepted reference seed document (Scene Document v1), embedded verbatim so
// the harness is self-contained.
const REFERENCE_SEED =
  '{"schemaVersion":1,"durationUs":1000000,"playbackRange":{"startUs":0,"endUs":1000000},"loop":true,"seed":42,"rootIds":["shape-1"],"elements":[{"id":"shape-1","type":"shape","x":16,"y":24,"width":120,"height":80,"opacity":1}],"tracks":[{"elementId":"shape-1","property":"opacity","interpolation":"linear","easing":"easeInOutQuad","keyframes":[{"timeUs":0,"value":0.25},{"timeUs":1000000,"value":0.75}]}]}';

const failInput = (message) => {
  console.error("SMOKE_INPUT_INVALID " + message);
  process.exit(2);
};

// ---- configuration validation --------------------------------------------

const IMAGE = process.env.PARTICLE_STUDIO_SMOKE_IMAGE ?? "particle-studio-headless-mcp:d1-smoke";
if (typeof IMAGE !== "string" || IMAGE.trim() === "") {
  failInput("PARTICLE_STUDIO_SMOKE_IMAGE must be a non-empty image reference");
}

const evidenceRaw = process.env.PARTICLE_STUDIO_SMOKE_EVIDENCE;
if (typeof evidenceRaw !== "string" || evidenceRaw.trim() === "") {
  failInput("PARTICLE_STUDIO_SMOKE_EVIDENCE is required: set it to the evidence root the harness should create and populate");
}
if (!isAbsolute(evidenceRaw)) {
  failInput("PARTICLE_STUDIO_SMOKE_EVIDENCE must be an absolute path (got: " + evidenceRaw + ")");
}
const EVID = resolve(evidenceRaw);

if (existsSync(EVID)) {
  if (!statSync(EVID).isDirectory()) {
    failInput("PARTICLE_STUDIO_SMOKE_EVIDENCE must be a directory (got a file: " + EVID + ")");
  }
  if (readdirSync(EVID).length > 0) {
    failInput("PARTICLE_STUDIO_SMOKE_EVIDENCE must not exist or must be empty; refusing to mix evidence into " + EVID);
  }
} else {
  mkdirSync(EVID, { recursive: true });
}

const writeFailureArtifact = (payload) => {
  try {
    writeFileSync(join(EVID, "smoke-failure.json"), JSON.stringify(payload, null, 2));
  } catch (writeError) {
    console.error("could not write the failure artifact: " + writeError);
  }
};

const seedEnv = process.env.PARTICLE_STUDIO_SMOKE_SEED;
let seedSource = "reference";
let seedProvidedPath = null;
if (typeof seedEnv === "string" && seedEnv.trim() !== "") {
  seedProvidedPath = resolve(seedEnv);
  if (!existsSync(seedProvidedPath) || !statSync(seedProvidedPath).isFile()) {
    writeFailureArtifact({
      status: "FAIL",
      reason: "invalid-input",
      message: "PARTICLE_STUDIO_SMOKE_SEED must be an existing file (got: " + seedProvidedPath + ")",
    });
    console.error("SMOKE_INPUT_INVALID PARTICLE_STUDIO_SMOKE_SEED must be an existing file (got: " + seedProvidedPath + ")");
    process.exit(1);
  }
  try {
    JSON.parse(readFileSync(seedProvidedPath, "utf8"));
  } catch (parseError) {
    writeFailureArtifact({
      status: "FAIL",
      reason: "invalid-input",
      message: "PARTICLE_STUDIO_SMOKE_SEED must contain a JSON document",
      parseError: String(parseError),
    });
    console.error("SMOKE_INPUT_INVALID PARTICLE_STUDIO_SMOKE_SEED must contain a JSON document");
    process.exit(1);
  }
  seedSource = "provided";
}

// ---- image metadata -------------------------------------------------------

const imageInspect = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
if (imageInspect.status !== 0) {
  writeFailureArtifact({
    status: "FAIL",
    reason: "image-unavailable",
    message: "docker image inspect failed for " + IMAGE + "; build it with the documented docker build command first",
    stderr: (imageInspect.stderr ?? "") + (imageInspect.stdout ?? ""),
  });
  console.error("SMOKE_RESULT=FAIL image unavailable: " + IMAGE);
  process.exit(1);
}
const imageMeta = JSON.parse(imageInspect.stdout)[0];
const IMAGE_INFO = {
  reference: IMAGE,
  id: imageMeta.Id,
  repoDigests: imageMeta.RepoDigests,
  size: imageMeta.Size,
};

// ---- evidence layout ------------------------------------------------------

const DOC = join(EVID, "roots", "documents");
const WS = join(EVID, "roots", "workspace");
const OUT = join(EVID, "roots", "outputs");
for (const dir of [DOC, WS, OUT]) mkdirSync(dir, { recursive: true });

const LIVE_SCRIPT = readFileSync(join(HARNESS_DIR, "live-inspect.cjs"), "utf8");
const INSPECT_DIRS_SCRIPT = readFileSync(join(HARNESS_DIR, "inspect-dirs.mjs"), "utf8");

const TOOL_NAMES = [
  "particle_studio.get_draft_summary",
  "particle_studio.validate_draft",
  "particle_studio.dispatch_draft_command",
  "particle_studio.undo",
  "particle_studio.redo",
];
const DOCUMENT_ID = "document-1";
const MARKERS = {
  documents: "d1-smoke-marker:documents",
  workspace: "d1-smoke-marker:workspace",
  outputs: "d1-smoke-marker:outputs",
};
const RUN1_PROBE_CONTENT = "d1-smoke-probe-run1-" + process.pid;
const RUN2_PROBE_CONTENT = "d1-smoke-probe-run2-" + process.pid;
const PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 30_000;

const checks = [];
const check = (name, condition, detail) => {
  const entry = { check: name, pass: condition === true, detail };
  checks.push(entry);
  appendFileSync(join(EVID, "checks.log"), JSON.stringify(entry) + "\n");
  if (condition !== true) throw new Error("CHECK FAILED: " + name + " :: " + JSON.stringify(detail));
};

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

// Seed document: copy the provided seed or write the embedded reference seed,
// then record the seed's SHA-256 over the exact bytes in documents/seed.json.
const seedBytes = seedSource === "provided" ? readFileSync(seedProvidedPath) : Buffer.from(REFERENCE_SEED, "utf8");
writeFileSync(join(DOC, "seed.json"), seedBytes);
const SEED_SHA256 = sha256(seedBytes);
const SEED_INFO = {
  source: seedSource,
  ...(seedProvidedPath === null ? {} : { path: seedProvidedPath }),
  sha256: SEED_SHA256,
  bytes: seedBytes.length,
};

function walk(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, base, acc);
    else if (st.isFile()) {
      const bytes = readFileSync(full);
      acc.push({
        path: full.slice(base.length + 1),
        size: st.size,
        mode: (st.mode & 0o777).toString(8),
        uid: st.uid,
        gid: st.gid,
        sha256: sha256(bytes),
        ...(st.size < 4096 ? { content: bytes.toString("utf8") } : {}),
      });
    }
  }
  return acc;
}

function snapshotRoots(label) {
  const snapshot = {
    documents: walk(DOC),
    workspace: walk(WS),
    outputs: walk(OUT),
  };
  writeFileSync(join(EVID, label + "-roots-snapshot.json"), JSON.stringify(snapshot, null, 2));
  return snapshot;
}

class Session {
  constructor(child, label) {
    this.child = child;
    this.label = label;
    this.nextId = 0;
    this.stdoutBuffer = "";
    this.stdoutLines = [];
    this.stderrText = "";
    this.waiters = new Map();
    this.exitInfo = null;
    this.exitWaiters = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (this.stderrText += chunk));
    child.on("close", (code, signal) => this.onClose(code, signal));
  }

  onStdout(chunk) {
    this.stdoutBuffer += chunk;
    for (;;) {
      const index = this.stdoutBuffer.indexOf("\n");
      if (index === -1) break;
      const line = this.stdoutBuffer.slice(0, index);
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      this.stdoutLines.push(line);
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || typeof parsed.id !== "number") continue;
      const waiter = this.waiters.get(parsed.id);
      if (!waiter) continue;
      this.waiters.delete(parsed.id);
      clearTimeout(waiter.timer);
      waiter.resolve(parsed);
    }
  }

  onClose(code, signal) {
    if (this.exitInfo !== null) return;
    this.exitInfo = { code, signal };
    for (const [, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("container exited before responding (" + code + "/" + signal + ") stderr:\n" + this.stderrText));
    }
    this.waiters.clear();
    for (const resolve of this.exitWaiters.splice(0)) resolve(this.exitInfo);
  }

  request(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error("timeout waiting for " + method + " (id=" + id + ")"));
      }, REQUEST_TIMEOUT_MS);
      this.waiters.set(id, waiter);
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params) {
    const message = params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  endStdin() {
    this.child.stdin.end();
  }

  waitExit() {
    if (this.exitInfo !== null) return Promise.resolve(this.exitInfo);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ code: null, signal: "TIMEOUT" });
      }, EXIT_TIMEOUT_MS);
      this.exitWaiters.push((info) => {
        clearTimeout(timer);
        resolve(info);
      });
    });
  }
}

const runArgs = (name, cidfile, withSeed) => {
  const args = [
    "run",
    "--rm",
    "-i",
    "--name",
    name,
    "--cidfile",
    cidfile,
    "--network=none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m",
    "--user",
    "1000:1000",
    "-v",
    DOC + ":/data/documents:ro",
    "-v",
    WS + ":/data/workspace:rw",
    "-v",
    OUT + ":/data/outputs:rw",
    "-e",
    "PARTICLE_STUDIO_WORKSPACE_ROOT=/data/workspace",
    "-e",
    "PARTICLE_STUDIO_DOCUMENTS_ROOT=/data/documents",
    "-e",
    "PARTICLE_STUDIO_OUTPUTS_ROOT=/data/outputs",
    "-e",
    "PARTICLE_STUDIO_DOCUMENT_ID=" + DOCUMENT_ID,
  ];
  if (withSeed) args.push("-e", "PARTICLE_STUDIO_SEED_PATH=seed.json");
  args.push(IMAGE);
  return args;
};

function startRun(label, withSeed) {
  const name = "ps-container-smoke-" + label + "-" + process.pid;
  const cidfile = join(EVID, label + "-" + Date.now() + ".cid");
  const args = runArgs(name, cidfile, withSeed);
  writeFileSync(join(EVID, label + "-docker-run-argv.json"), JSON.stringify({ command: "docker", args }, null, 2));
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  const session = new Session(child, label);
  started.push({ label, name, session, args });
  return { name, child, session, args };
}
const started = [];

function persistTranscript(label, session) {
  writeFileSync(join(EVID, label + "-stdout-lines.jsonl"), session.stdoutLines.join("\n") + "\n");
  writeFileSync(join(EVID, label + "-stderr.log"), session.stderrText);
}

function inspectHost(label, name) {
  const inspectFile = join(EVID, label + "-docker-inspect.json");
  const inspect = spawnSync("docker", ["inspect", name], { encoding: "utf8" });
  writeFileSync(inspectFile, inspect.stdout + inspect.stderr);
  writeFileSync(join(EVID, label + "-docker-inspect-rc.txt"), String(inspect.status));
  const top = spawnSync("docker", ["top", name], { encoding: "utf8" });
  writeFileSync(join(EVID, label + "-docker-top.txt"), "rc=" + top.status + "\n" + top.stdout + top.stderr);
  const full = inspect.status === 0 ? JSON.parse(inspect.stdout)[0] : null;
  return { inspect: full, inspectStatus: inspect.status };
}

function liveInspect(label, name, tag, probeContent) {
  const result = spawnSync("docker", ["exec", "-e", "PROBE_TAG=" + tag, "-e", "PROBE_CONTENT=" + probeContent, name, "node", "-e", LIVE_SCRIPT], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const file = join(EVID, label + "-live-inspect.json");
  if (result.status === 0) writeFileSync(file, result.stdout);
  else writeFileSync(file + ".error", "rc=" + result.status + "\nSTDOUT:\n" + result.stdout + "\nSTDERR:\n" + result.stderr);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, parsed: result.status === 0 ? JSON.parse(result.stdout) : null };
}

function imageDevDirsInspect(label, name) {
  const result = spawnSync("docker", ["exec", name, "node", "--input-type=module", "-e", INSPECT_DIRS_SCRIPT], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const file = join(EVID, label + "-image-devdirs.json");
  if (result.status === 0) writeFileSync(file, result.stdout);
  else writeFileSync(file + ".error", "rc=" + result.status + "\nSTDOUT:\n" + result.stdout + "\nSTDERR:\n" + result.stderr);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const AUDITED_DEV_DIRS = [
  "@playwright", "react", "react-dom", "@testing-library", "@vitejs", "@sinclair",
  "@types", "vitest", "typescript", "vite", "jsdom", "rolldown",
].map((name) => "/app/node_modules/" + name);

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const toolEnvelope = (response) => {
  if (response.error !== undefined) throw new Error("unexpected JSON-RPC error: " + JSON.stringify(response.error));
  const result = response.result;
  if (!isRecord(result)) throw new Error("missing tool result");
  const text = Array.isArray(result.content) && isRecord(result.content[0]) ? result.content[0].text : undefined;
  let parsedText;
  try {
    parsedText = JSON.parse(text);
  } catch {
    parsedText = undefined;
  }
  return { result, envelope: result.structuredContent, isError: result.isError, textMatchesStructured: parsedText !== undefined && JSON.stringify(parsedText) === JSON.stringify(result.structuredContent) };
};

const NO_ERROR_TEXT = (code) => JSON.stringify({ ok: false, error: { code } });

function buildManifest(result, extra) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    result,
    ...extra,
    harness: { path: HARNESS_PATH, nodeVersion: process.version, platform: process.platform, arch: process.arch },
    image: IMAGE_INFO,
    seed: SEED_INFO,
    sessions: started.map(({ label, name, session, args }) => ({
      label,
      containerName: name,
      argvFile: label + "-docker-run-argv.json",
      dockerRunArgv: ["docker", ...args],
      exit: session.exitInfo,
    })),
    checks: { total: checks.length, passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).length },
  };
}

async function main() {
  for (const [role, value] of Object.entries(MARKERS)) {
    writeFileSync(join(EVID, "roots", role, ".d1-smoke-host-marker.txt"), value + "\n");
  }
  const run1 = startRun("run1", true);
  const outcome = { run1: {}, run2: {}, run3: {}, run4: {} };

  try {
    // Image configuration: assert, from the image's own `docker image inspect`
    // data (not from Dockerfile text), what the README claims about the built
    // image: no exposed ports, no volumes, no healthcheck, SIGTERM stop
    // signal, the non-root `node` user, and an exec-form entrypoint.
    const imageConfig = imageMeta.Config ?? {};
    check("image config exposes no ports", imageConfig.ExposedPorts == null || (isRecord(imageConfig.ExposedPorts) && Object.keys(imageConfig.ExposedPorts).length === 0), imageConfig.ExposedPorts ?? null);
    check("image config declares no volumes", imageConfig.Volumes == null || (isRecord(imageConfig.Volumes) && Object.keys(imageConfig.Volumes).length === 0), imageConfig.Volumes ?? null);
    check("image config defines no healthcheck", imageConfig.Healthcheck == null, imageConfig.Healthcheck ?? null);
    check("image config StopSignal is SIGTERM", imageConfig.StopSignal === "SIGTERM", imageConfig.StopSignal ?? null);
    check("image config user is the non-root node user", imageConfig.User === "node", imageConfig.User ?? null);
    check(
      "image config entrypoint is the accepted exec-form node entry",
      Array.isArray(imageConfig.Entrypoint) && JSON.stringify(imageConfig.Entrypoint) === JSON.stringify(["node", "--import", "tsx", "apps/headless-mcp/src/main.ts"]) && (imageConfig.Cmd == null || (Array.isArray(imageConfig.Cmd) && imageConfig.Cmd.length === 0)),
      { Entrypoint: imageConfig.Entrypoint ?? null, Cmd: imageConfig.Cmd ?? null },
    );

    // ---- initialize ----
    const initialize = await run1.session.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "h3-container-smoke-harness", version: "0.0.0" },
    });
    check("run1 initialize has no JSON-RPC error", initialize.error === undefined, initialize.error ?? null);
    check("run1 initialize returns a result object", isRecord(initialize.result), initialize.result ?? null);
    check("run1 initialize reports a protocolVersion", isRecord(initialize.result) && typeof initialize.result.protocolVersion === "string", initialize.result?.protocolVersion ?? null);
    check("run1 initialize reports serverInfo", isRecord(initialize.result) && isRecord(initialize.result.serverInfo), initialize.result?.serverInfo ?? null);
    outcome.run1.initialize = initialize.result;
    run1.session.notify("notifications/initialized");

    // ---- tools/list ----
    const listing = await run1.session.request("tools/list", {});
    check("run1 tools/list has no JSON-RPC error", listing.error === undefined, listing.error ?? null);
    const tools = listing.result?.tools;
    check("run1 tools/list returns exactly five tools", Array.isArray(tools) && tools.length === 5, Array.isArray(tools) ? tools.map((t) => t.name) : tools ?? null);
    check(
      "run1 tools/list names are exactly the accepted five",
      JSON.stringify((tools ?? []).map((t) => t.name).sort()) === JSON.stringify([...TOOL_NAMES].sort()),
      (tools ?? []).map((t) => t.name),
    );
    check("run1 every tool carries an inputSchema object", (tools ?? []).every((t) => isRecord(t.inputSchema)), (tools ?? []).map((t) => [t.name, typeof t.inputSchema]));
    outcome.run1.toolsList = listing.result;

    // ---- live inspection (server is live, stdin still open) ----
    const host1 = inspectHost("run1", run1.name);
    const live1 = liveInspect("run1", run1.name, "run1", RUN1_PROBE_CONTENT);
    check("run1 live docker exec inspection succeeded", live1.status === 0, { status: live1.status, stderr: live1.stderr });
    const devDirs = imageDevDirsInspect("run1", run1.name);
    check("run1 image dev-directory audit succeeded", devDirs.status === 0, { status: devDirs.status, stderr: devDirs.stderr?.trim().slice(0, 500) });
    let auditedDirs;
    try {
      auditedDirs = JSON.parse(devDirs.stdout);
    } catch {
      auditedDirs = null;
    }
    check(
      "run1 image dev-directory audit returned the curated directory map",
      isRecord(auditedDirs) && JSON.stringify(Object.keys(auditedDirs).sort()) === JSON.stringify([...AUDITED_DEV_DIRS].sort()) && Object.values(auditedDirs).every((value) => value === null || isRecord(value)),
      { expected: AUDITED_DEV_DIRS, observed: isRecord(auditedDirs) ? Object.keys(auditedDirs) : "malformed JSON or non-object" },
    );
    const presentDevDirs = AUDITED_DEV_DIRS.filter((path) => auditedDirs[path] !== null);
    check("run1 audited dev dependency directories are absent", presentDevDirs.length === 0, presentDevDirs);
    outcome.run1.hostInspect = host1.inspect;

    const hc = host1.inspect?.HostConfig ?? {};
    check("run1 HostConfig.NetworkMode is none", hc.NetworkMode === "none", hc.NetworkMode);
    check("run1 HostConfig.ReadonlyRootfs is true", hc.ReadonlyRootfs === true, hc.ReadonlyRootfs);
    check("run1 HostConfig.Privileged is false", hc.Privileged === false, hc.Privileged);
    check("run1 run config resolves the process user to 1000:1000", host1.inspect?.Config?.User === "1000:1000", host1.inspect?.Config?.User);
    check("run1 HostConfig.CapAdd adds no capability", hc.CapAdd === null || (Array.isArray(hc.CapAdd) && hc.CapAdd.length === 0), hc.CapAdd);
    check("run1 HostConfig.CapDrop is null (no drop requested)", hc.CapDrop === null || (Array.isArray(hc.CapDrop) && hc.CapDrop.length === 0), hc.CapDrop);
    const binds = (hc.Binds ?? []).map((b) => b.replace(DOC, "$DOCUMENTS").replace(WS, "$WORKSPACE").replace(OUT, "$OUTPUTS")).sort();
    check(
      "run1 HostConfig.Binds declares exactly the three role mounts",
      JSON.stringify(binds) === JSON.stringify(["$DOCUMENTS:/data/documents:ro", "$OUTPUTS:/data/outputs:rw", "$WORKSPACE:/data/workspace:rw"]),
      binds,
    );
    check("run1 HostConfig.Tmpfs declares only /tmp", JSON.stringify(hc.Tmpfs) === JSON.stringify({ "/tmp": "rw,nosuid,nodev,size=64m" }), hc.Tmpfs);
    check("run1 inspect Mounts contain the three declared bind mounts", ["/data/documents", "/data/workspace", "/data/outputs"].every((p) => (host1.inspect?.Mounts ?? []).some((m) => m.Destination === p)), (host1.inspect?.Mounts ?? []).map((m) => [m.Destination, m.RW, m.Type]));
    check("run1 documents mount is read-only", (host1.inspect?.Mounts ?? []).find((m) => m.Destination === "/data/documents")?.RW === false, (host1.inspect?.Mounts ?? []).find((m) => m.Destination === "/data/documents") ?? null);
    check("run1 workspace/outputs mounts are read-write", ["/data/workspace", "/data/outputs"].every((p) => (host1.inspect?.Mounts ?? []).find((m) => m.Destination === p)?.RW === true), (host1.inspect?.Mounts ?? []).filter((m) => m.Destination !== "/data/documents").map((m) => [m.Destination, m.RW]));

    const live = live1.parsed;
    check("run1 live process runs as uid 1000", live.uid === 1000, live.uid);
    check("run1 live process runs as gid 1000", live.gid === 1000, live.gid);
    check("run1 /proc/self/status Uid is 1000 1000", live.procStatus.uid.startsWith("1000"), live.procStatus.uid);
    check("run1 /proc/self/status Gid is 1000 1000", live.procStatus.gid.startsWith("1000"), live.procStatus.gid);
    check("run1 container has only the loopback interface", JSON.stringify(live.interfaces) === JSON.stringify(["lo"]), live.interfaces);
    outcome.run1.loopbackOperstate = live.interfaceOperstate;
    check("run1 /proc/net/tcp has no entries", live.tcp.length === 0, live.tcp);
    check("run1 /proc/net/tcp6 has no entries", live.tcp6.length === 0, live.tcp6);
    check("run1 no listening TCP sockets", live.listeningTcpSockets === 0, live.listeningTcpSockets);

    const dataMounts = live.mountinfo.filter((m) => m.mountPoint.startsWith("/data")).map((m) => ({ mountPoint: m.mountPoint, mountOptions: m.mountOptions, root: m.root, source: m.source, fstype: m.fstype })).sort((a, b) => a.mountPoint.localeCompare(b.mountPoint));
    check("run1 live mountinfo exposes the three role mounts", dataMounts.length === 3, dataMounts);
    for (const [mountPoint, role] of [["/data/documents", "documents"], ["/data/workspace", "workspace"], ["/data/outputs", "outputs"]]) {
      const entry = dataMounts.find((m) => m.mountPoint === mountPoint);
      check("run1 live " + role + " mount root maps the " + role + " host role root", typeof entry?.root === "string" && entry.root.endsWith("/roots/" + role), entry ?? null);
    }
    check("run1 live documents mount is read-only", (dataMounts.find((m) => m.mountPoint === "/data/documents")?.mountOptions ?? "").includes("ro"), dataMounts.find((m) => m.mountPoint === "/data/documents"));
    check("run1 live workspace mount is read-write", !(dataMounts.find((m) => m.mountPoint === "/data/workspace")?.mountOptions ?? "").includes("ro"), dataMounts.find((m) => m.mountPoint === "/data/workspace"));
    check("run1 live outputs mount is read-write", !(dataMounts.find((m) => m.mountPoint === "/data/outputs")?.mountOptions ?? "").includes("ro"), dataMounts.find((m) => m.mountPoint === "/data/outputs"));
    for (const role of ["documents", "workspace", "outputs"]) {
      const marker = live.mappings[role + "Marker"];
      check("run1 container reads the " + role + " host marker through the " + role + " mount (roles are not swapped)", marker?.ok === true && marker.content.trim() === MARKERS[role], marker ?? null);
    }
    check("run1 seed bytes visible in the container match the host seed file", live.mappings.seedInContainer?.ok === true && live.mappings.seedInContainer.sha256 === sha256(readFileSync(join(DOC, "seed.json"))), live.mappings.seedInContainer ?? null);
    const tmpMount = live.mountinfo.find((m) => m.mountPoint === "/tmp");
    check("run1 /tmp is a tmpfs mount", tmpMount?.fstype === "tmpfs", tmpMount ?? null);
    check("run1 / is the read-only image root", (live.mountinfo.find((m) => m.mountPoint === "/")?.mountOptions ?? "").includes("ro"), live.mountinfo.find((m) => m.mountPoint === "/") ?? null);

    check("run1 documents mount rejects writes", live.writes.documentsProbe.ok === false && live.writes.documentsProbe.code === "EROFS", live.writes.documentsProbe);
    check("run1 image root rejects writes", live.writes.appRootProbe.ok === false && live.writes.appRootProbe.code === "EROFS", live.writes.appRootProbe);
    check("run1 /etc rejects writes", live.writes.etcProbe.ok === false && live.writes.etcProbe.code === "EROFS", live.writes.etcProbe);
    check("run1 workspace mount accepts writes", live.writes.workspaceProbe.ok === true, live.writes.workspaceProbe);
    check("run1 outputs mount accepts writes", live.writes.outputsProbe.ok === true, live.writes.outputsProbe);
    check("run1 /tmp tmpfs accepts writes", live.writes.tmpProbe.ok === true, live.writes.tmpProbe);
    outcome.run1.live = live;

    // ---- tools/call: summary, mutating dispatch, validating validate ----
    const summary0 = toolEnvelope(await run1.session.request("tools/call", { name: "particle_studio.get_draft_summary", arguments: {} }));
    check("run1 get_draft_summary reports ok", summary0.envelope?.ok === true, summary0.envelope);
    check("run1 get_draft_summary starts at revision 0 from the seed", summary0.envelope?.summary?.revision === 0, summary0.envelope?.summary);
    check("run1 get_draft_summary reports the configured document id", summary0.envelope?.summary?.documentId === DOCUMENT_ID, summary0.envelope?.summary);
    outcome.run1.summaryBeforeMutation = summary0.envelope;

    const dispatch = toolEnvelope(
      await run1.session.request("tools/call", {
        name: "particle_studio.dispatch_draft_command",
        arguments: {
          command: {
            commandSchemaVersion: 1,
            commandId: "d1-smoke-command-1",
            documentId: DOCUMENT_ID,
            expectedRevision: 0,
            payload: { type: "set-keyframe-value", trackId: "shape-1:opacity", keyframeId: "shape-1:opacity:1000000", value: 0.8 },
          },
        },
      }),
    );
    check("run1 mutating dispatch reports ok", dispatch.envelope?.ok === true, dispatch.envelope);
    check("run1 mutating dispatch advances to revision 1", dispatch.envelope?.revision === 1, dispatch.envelope?.revision);
    check("run1 mutating dispatch returns the mutated persisted document", dispatch.envelope?.document?.tracks?.[0]?.keyframes?.[1]?.value === 0.8, dispatch.envelope?.document?.tracks ?? null);
    check("run1 mutating dispatch leaves the other keyframe untouched", dispatch.envelope?.document?.tracks?.[0]?.keyframes?.[0]?.value === 0.25, dispatch.envelope?.document?.tracks?.[0]?.keyframes ?? null);
    check("run1 tool result text mirrors structuredContent", dispatch.textMatchesStructured === true, { textMatchesStructured: dispatch.textMatchesStructured });
    outcome.run1.dispatch = dispatch.envelope;

    const seedDocument = JSON.parse(readFileSync(join(DOC, "seed.json"), "utf8"));
    const validated = toolEnvelope(await run1.session.request("tools/call", { name: "particle_studio.validate_draft", arguments: { document: seedDocument } }));
    check("run1 validating validate_draft reports ok", validated.envelope?.ok === true, validated.envelope);
    check("run1 validate_draft echoes the exact accepted seed document", JSON.stringify(validated.envelope?.value) === JSON.stringify(seedDocument), validated.envelope?.value ?? null);
    outcome.run1.validated = validated.envelope;

    const summary1 = toolEnvelope(await run1.session.request("tools/call", { name: "particle_studio.get_draft_summary", arguments: {} }));
    check("run1 get_draft_summary observes revision 1 after the mutation", summary1.envelope?.summary?.revision === 1, summary1.envelope?.summary);
    outcome.run1.summaryAfterMutation = summary1.envelope;

    // ---- EOF shutdown ----
    outcome.run1.rootsDuringRun = snapshotRoots("run1-live");
    run1.session.endStdin();
    const exit1 = await run1.session.waitExit();
    check("run1 stdin EOF exits with status 0 and no signal", exit1.code === 0 && exit1.signal === null, exit1);
    outcome.run1.exit = exit1;

    persistTranscript("run1", run1.session);
    for (const [index, line] of run1.session.stdoutLines.entries()) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        check("run1 stdout line " + index + " is parseable JSON", false, line);
      }
      check("run1 stdout line " + index + " is a JSON-RPC 2.0 message", parsed?.jsonrpc === "2.0", line);
    }
    check("run1 stdout carries protocol lines", run1.session.stdoutLines.length > 0, run1.session.stdoutLines.length);
    check("run1 stdout uses newline-delimited framing without a trailing partial line", run1.session.stdoutBuffer === "", run1.session.stdoutBuffer.slice(0, 200));
    check("run1 stderr carries no JSON-RPC payload", !run1.session.stderrText.includes('"jsonrpc"'), run1.session.stderrText);
    check("run1 stderr carries no result payload", !run1.session.stderrText.includes('"result"'), run1.session.stderrText);
    check("run1 stderr carries no method payload", !run1.session.stderrText.includes('"method"'), run1.session.stderrText);
    outcome.run1.stderrLength = run1.session.stderrText.length;

    const rootsAfter1 = snapshotRoots("run1-after-exit");
    const workspaceProbeOnHost = rootsAfter1.workspace.find((f) => f.path === "run1-write-probe.txt");
    check("run1 container write into /data/workspace landed in the exact host workspace root", workspaceProbeOnHost?.content === RUN1_PROBE_CONTENT, workspaceProbeOnHost ?? null);
    const outputsProbeOnHost = rootsAfter1.outputs.find((f) => f.path === "run1-write-probe.txt");
    check("run1 container write into /data/outputs landed in the exact host outputs root", outputsProbeOnHost?.content === RUN1_PROBE_CONTENT, outputsProbeOnHost ?? null);
    check("run1 read-only documents host root gained no container write", !rootsAfter1.documents.some((f) => f.path.startsWith("run1-")), rootsAfter1.documents.map((f) => f.path));
    const persisted1 = rootsAfter1.outputs.filter((f) => f.path.startsWith("particle-studio-persistence-v1/"));
    check("run1 persisted state bytes are present after EOF", persisted1.length >= 2 && persisted1.every((f) => f.size > 0), persisted1.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })));
    check("run1 persisted pointer record names the draft revision persisted by the mutation", persisted1.some((f) => f.path.endsWith("pointers.json") && (f.content ?? "").includes('"sequence":1')), persisted1.filter((f) => f.path.endsWith("pointers.json")).map((f) => f.path));
    check("run1 persisted revision record carries the mutated keyframe value 0.8", persisted1.some((f) => f.path.endsWith(".json") && !f.path.endsWith("pointers.json") && (f.content ?? "").includes("0.8")), persisted1.filter((f) => f.path.endsWith(".json")).map((f) => f.path));
    check("run1 workspace root holds no revision records (accepted role mapping: revisions/pointers under outputs, asset records under workspace)", rootsAfter1.workspace.every((f) => !f.path.startsWith("particle-studio-persistence-v1/")), rootsAfter1.workspace.map((f) => f.path));
    outcome.run1.persistedRecords = persisted1.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }));
    outcome.run1.workspaceAfterExit = rootsAfter1.workspace;

    // ---- run 2: resume without the seed, then SIGTERM ----
    const run2 = startRun("run2", false);
    outcome.run2.argvHasNoSeedPath = !run2.args.includes("PARTICLE_STUDIO_SEED_PATH=seed.json");
    check("run2 docker run argv omits PARTICLE_STUDIO_SEED_PATH (resume without seed)", !run2.args.some((a) => a.includes("PARTICLE_STUDIO_SEED_PATH")), run2.args.filter((a) => a.includes("PARTICLE_STUDIO_SEED_PATH")));
    const initialize2 = await run2.session.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "d1-4-smoke-driver", version: "0.0.0" },
    });
    check("run2 initialize has no JSON-RPC error", initialize2.error === undefined, initialize2.error ?? null);
    check("run2 initialize returns a result object", isRecord(initialize2.result), initialize2.result ?? null);
    run2.session.notify("notifications/initialized");

    const summary2 = toolEnvelope(await run2.session.request("tools/call", { name: "particle_studio.get_draft_summary", arguments: {} }));
    check("run2 resumes the persisted revision 1 without a seed path", summary2.envelope?.summary?.revision === 1, summary2.envelope?.summary);
    outcome.run2.summaryOnResume = summary2.envelope;

    const host2 = inspectHost("run2", run2.name);
    const live2 = liveInspect("run2", run2.name, "run2", RUN2_PROBE_CONTENT);
    check("run2 live docker exec inspection succeeded", live2.status === 0, { status: live2.status, stderr: live2.stderr });
    check("run2 HostConfig.NetworkMode is none", host2.inspect?.HostConfig?.NetworkMode === "none", host2.inspect?.HostConfig?.NetworkMode);

    const dispatch2 = toolEnvelope(
      await run2.session.request("tools/call", {
        name: "particle_studio.dispatch_draft_command",
        arguments: {
          command: {
            commandSchemaVersion: 1,
            commandId: "d1-smoke-command-2",
            documentId: DOCUMENT_ID,
            expectedRevision: 1,
            payload: { type: "set-keyframe-value", trackId: "shape-1:opacity", keyframeId: "shape-1:opacity:0", value: 0.6 },
          },
        },
      }),
    );
    check("run2 mutating dispatch on the resumed state reports ok", dispatch2.envelope?.ok === true, dispatch2.envelope);
    check("run2 mutating dispatch advances to revision 2", dispatch2.envelope?.revision === 2, dispatch2.envelope?.revision);
    check("run2 resumed document carries the run 1 persisted mutation (0.8, not the seed 0.75)", dispatch2.envelope?.document?.tracks?.[0]?.keyframes?.[1]?.value === 0.8, dispatch2.envelope?.document?.tracks?.[0]?.keyframes ?? null);
    check("run2 mutation applied to the requested keyframe", dispatch2.envelope?.document?.tracks?.[0]?.keyframes?.[0]?.value === 0.6, dispatch2.envelope?.document?.tracks?.[0]?.keyframes ?? null);
    outcome.run2.dispatch = dispatch2.envelope;

    // SIGTERM while the session is live; stdin stays open.
    const kill = spawnSync("docker", ["kill", "--signal", "SIGTERM", run2.name], { encoding: "utf8" });
    writeFileSync(join(EVID, "run2-docker-kill.txt"), "rc=" + kill.status + "\n" + kill.stdout + kill.stderr);
    check("run2 docker kill --signal SIGTERM was accepted", kill.status === 0, { status: kill.status, stderr: kill.stderr });
    const exit2 = await run2.session.waitExit();
    check("run2 SIGTERM exits with status 0 and no signal", exit2.code === 0 && exit2.signal === null, exit2);
    outcome.run2.exit = exit2;

    persistTranscript("run2", run2.session);
    for (const [index, line] of run2.session.stdoutLines.entries()) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        check("run2 stdout line " + index + " is parseable JSON", false, line);
      }
      check("run2 stdout line " + index + " is a JSON-RPC 2.0 message", parsed?.jsonrpc === "2.0", line);
    }
    check("run2 stderr carries no JSON-RPC payload", !run2.session.stderrText.includes('"jsonrpc"'), run2.session.stderrText);
    check("run2 stderr carries no result payload", !run2.session.stderrText.includes('"result"'), run2.session.stderrText);
    check("run2 stderr carries no method payload", !run2.session.stderrText.includes('"method"'), run2.session.stderrText);
    check("run2 live inspection ran against the same mounts", live2.parsed?.writes?.documentsProbe?.code === "EROFS" && live2.parsed?.writes?.workspaceProbe?.ok === true, live2.parsed?.writes ?? null);
    outcome.run2.live = live2.parsed;

    const rootsAfter2 = snapshotRoots("run2-after-exit");
    const workspaceProbe2OnHost = rootsAfter2.workspace.find((f) => f.path === "run2-write-probe.txt");
    check("run2 container write into /data/workspace landed in the exact host workspace root", workspaceProbe2OnHost?.content === RUN2_PROBE_CONTENT, workspaceProbe2OnHost ?? null);
    const persisted2 = rootsAfter2.outputs.filter((f) => f.path.startsWith("particle-studio-persistence-v1/"));
    check("run2 persisted state bytes are present after SIGTERM", persisted2.length >= 2 && persisted2.every((f) => f.size > 0), persisted2.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })));
    check("run2 persisted pointer record advanced to the resumed sequence 2", persisted2.some((f) => f.path.endsWith("pointers.json") && (f.content ?? "").includes('"sequence":2')), persisted2.filter((f) => f.path.endsWith("pointers.json")).map((f) => f.path));
    check("run2 persisted revision record carries both the resumed 0.8 and the new 0.6 values", persisted2.some((f) => f.path.endsWith(".json") && !f.path.endsWith("pointers.json") && (f.content ?? "").includes("0.8") && (f.content ?? "").includes("0.6")), persisted2.filter((f) => f.path.endsWith(".json")).map((f) => f.path));
    outcome.run2.persistedRecords = persisted2.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }));
    check("run2 persisted workspace bytes are present after SIGTERM", rootsAfter2.workspace.length > 0 && rootsAfter2.workspace.every((f) => f.size > 0), rootsAfter2.workspace.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })));
    outcome.run2.workspaceAfterExit = rootsAfter2.workspace;

    // ---- run 3: container-level undo/redo over the persisted state ----
    // Undo/redo history is session-local and starts empty on resume, so this
    // session first dispatches a command to build history, then exercises
    // undo, redo, and both stable denial envelopes.
    const run3 = startRun("run3", false);
    check("run3 docker run argv omits PARTICLE_STUDIO_SEED_PATH (resume without seed)", !run3.args.some((a) => a.includes("PARTICLE_STUDIO_SEED_PATH")), run3.args.filter((a) => a.includes("PARTICLE_STUDIO_SEED_PATH")));
    const initialize3 = await run3.session.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "h3-container-smoke-harness", version: "0.0.0" },
    });
    check("run3 initialize has no JSON-RPC error", initialize3.error === undefined, initialize3.error ?? null);
    check("run3 initialize returns a result object", isRecord(initialize3.result), initialize3.result ?? null);
    run3.session.notify("notifications/initialized");

    const listing3 = await run3.session.request("tools/list", {});
    check("run3 tools/list has no JSON-RPC error", listing3.error === undefined, listing3.error ?? null);
    const tools3 = listing3.result?.tools;
    check("run3 tools/list returns exactly five tools", Array.isArray(tools3) && tools3.length === 5, Array.isArray(tools3) ? tools3.map((t) => t.name) : tools3 ?? null);
    check(
      "run3 tools/list names are exactly the accepted five",
      JSON.stringify((tools3 ?? []).map((t) => t.name).sort()) === JSON.stringify([...TOOL_NAMES].sort()),
      (tools3 ?? []).map((t) => t.name),
    );
    check("run3 every tool carries an inputSchema object", (tools3 ?? []).every((t) => isRecord(t.inputSchema)), (tools3 ?? []).map((t) => [t.name, typeof t.inputSchema]));
    outcome.run3.toolsList = listing3.result;

    const summaryR3 = toolEnvelope(await run3.session.request("tools/call", { name: "particle_studio.get_draft_summary", arguments: {} }));
    check("run3 resumes the persisted revision 2 without a seed path", summaryR3.envelope?.summary?.revision === 2, summaryR3.envelope?.summary);
    check("run3 resumed summary reports the configured document id", summaryR3.envelope?.summary?.documentId === DOCUMENT_ID, summaryR3.envelope?.summary);
    outcome.run3.summaryOnResume = summaryR3.envelope;

    const dispatch3 = toolEnvelope(
      await run3.session.request("tools/call", {
        name: "particle_studio.dispatch_draft_command",
        arguments: {
          command: {
            commandSchemaVersion: 1,
            commandId: "h3-smoke-command-3",
            documentId: DOCUMENT_ID,
            expectedRevision: 2,
            payload: { type: "set-keyframe-value", trackId: "shape-1:opacity", keyframeId: "shape-1:opacity:1000000", value: 0.4 },
          },
        },
      }),
    );
    check("run3 mutating dispatch reports ok", dispatch3.envelope?.ok === true, dispatch3.envelope);
    check("run3 mutating dispatch advances revision 2 -> 3", dispatch3.envelope?.revision === 3, dispatch3.envelope?.revision);
    check("run3 dispatched keyframe carries the new value 0.4", dispatch3.envelope?.document?.tracks?.[0]?.keyframes?.[1]?.value === 0.4, dispatch3.envelope?.document?.tracks?.[0]?.keyframes ?? null);
    check("run3 dispatched document leaves the other keyframe at the resumed 0.6", dispatch3.envelope?.document?.tracks?.[0]?.keyframes?.[0]?.value === 0.6, dispatch3.envelope?.document?.tracks?.[0]?.keyframes ?? null);
    check("run3 dispatch tool result text mirrors structuredContent", dispatch3.textMatchesStructured === true, { textMatchesStructured: dispatch3.textMatchesStructured });
    outcome.run3.dispatch = dispatch3.envelope;

    const summaryD3 = toolEnvelope(await run3.session.request("tools/call", { name: "particle_studio.get_draft_summary", arguments: {} }));
    check("run3 get_draft_summary observes revision 3 after the dispatch", summaryD3.envelope?.summary?.revision === 3, summaryD3.envelope?.summary);

    const undo3 = toolEnvelope(await run3.session.request("tools/call", { name: "particle_studio.undo", arguments: {} }));
    check("run3 undo reports ok", undo3.envelope?.ok === true, undo3.envelope);
    check("run3 undo advances revision 3 -> 4", undo3.envelope?.revision === 4, undo3.envelope?.revision);
    check("run3 undo restores the pre-dispatch keyframe value 0.8", undo3.envelope?.document?.tracks?.[0]?.keyframes?.[1]?.value === 0.8, undo3.envelope?.document?.tracks?.[0]?.keyframes ?? null);
    check("run3 undo keeps the other keyframe at 0.6", undo3.envelope?.document?.tracks?.[0]?.keyframes?.[0]?.value === 0.6, undo3.envelope?.document?.tracks?.[0]?.keyframes ?? null);
    check("run3 undo tool result text mirrors structuredContent", undo3.textMatchesStructured === true, { textMatchesStructured: undo3.textMatchesStructured });
    outcome.run3.undo = undo3.envelope;

    // Denial path 1: nothing left to undo; the workspace denies with the
    // stable NOTHING_TO_UNDO envelope and the MCP layer flags isError.
    const undoDenial = toolEnvelope(await run3.session.request("tools/call", { name: "particle_studio.undo", arguments: {} }));
    check("run3 second undo denies with the exact stable NOTHING_TO_UNDO envelope", JSON.stringify(undoDenial.envelope) === NO_ERROR_TEXT("NOTHING_TO_UNDO"), undoDenial.envelope);
    check("run3 NOTHING_TO_UNDO denial maps to an isError tool result", undoDenial.isError === true, { isError: undoDenial.isError });
    check("run3 NOTHING_TO_UNDO denial text mirrors structuredContent", undoDenial.textMatchesStructured === true, { textMatchesStructured: undoDenial.textMatchesStructured });
    outcome.run3.undoDenial = undoDenial.envelope;
    const summaryDenial1 = toolEnvelope(await run3.session.request("tools/call", { name: "particle_studio.get_draft_summary", arguments: {} }));
    check("run3 NOTHING_TO_UNDO denial leaves the revision at 4", summaryDenial1.envelope?.summary?.revision === 4, summaryDenial1.envelope?.summary);

    const redo3 = toolEnvelope(await run3.session.request("tools/call", { name: "particle_studio.redo", arguments: {} }));
    check("run3 redo reports ok", redo3.envelope?.ok === true, redo3.envelope);
    check("run3 redo advances revision 4 -> 5", redo3.envelope?.revision === 5, redo3.envelope?.revision);
    check("run3 redo re-applies the undone value 0.4", redo3.envelope?.document?.tracks?.[0]?.keyframes?.[1]?.value === 0.4, redo3.envelope?.document?.tracks?.[0]?.keyframes ?? null);
    check("run3 redo tool result text mirrors structuredContent", redo3.textMatchesStructured === true, { textMatchesStructured: redo3.textMatchesStructured });
    outcome.run3.redo = redo3.envelope;

    // Denial path 2: nothing left to redo.
    const redoDenial = toolEnvelope(await run3.session.request("tools/call", { name: "particle_studio.redo", arguments: {} }));
    check("run3 second redo denies with the exact stable NOTHING_TO_REDO envelope", JSON.stringify(redoDenial.envelope) === NO_ERROR_TEXT("NOTHING_TO_REDO"), redoDenial.envelope);
    check("run3 NOTHING_TO_REDO denial maps to an isError tool result", redoDenial.isError === true, { isError: redoDenial.isError });
    check("run3 NOTHING_TO_REDO denial text mirrors structuredContent", redoDenial.textMatchesStructured === true, { textMatchesStructured: redoDenial.textMatchesStructured });
    outcome.run3.redoDenial = redoDenial.envelope;

    const summaryFinal3 = toolEnvelope(await run3.session.request("tools/call", { name: "particle_studio.get_draft_summary", arguments: {} }));
    check("run3 final summary observes revision 5 after undo and redo", summaryFinal3.envelope?.summary?.revision === 5, summaryFinal3.envelope?.summary);
    outcome.run3.undoRedoProgression = {
      resumed: summaryR3.envelope?.summary?.revision,
      dispatched: dispatch3.envelope?.revision,
      undone: undo3.envelope?.revision,
      undoneDenialRevision: summaryDenial1.envelope?.summary?.revision,
      redone: redo3.envelope?.revision,
      redoneDenialRevision: summaryFinal3.envelope?.summary?.revision,
    };

    // EOF shutdown; the redo result must be the persisted state.
    run3.session.endStdin();
    const exit3 = await run3.session.waitExit();
    check("run3 stdin EOF exits with status 0 and no signal", exit3.code === 0 && exit3.signal === null, exit3);
    outcome.run3.exit = exit3;

    persistTranscript("run3", run3.session);
    for (const [index, line] of run3.session.stdoutLines.entries()) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        check("run3 stdout line " + index + " is parseable JSON", false, line);
      }
      check("run3 stdout line " + index + " is a JSON-RPC 2.0 message", parsed?.jsonrpc === "2.0", line);
    }
    check("run3 stderr carries no JSON-RPC payload", !run3.session.stderrText.includes('"jsonrpc"'), run3.session.stderrText);
    check("run3 stderr carries no result payload", !run3.session.stderrText.includes('"result"'), run3.session.stderrText);

    const rootsAfter3 = snapshotRoots("run3-after-exit");
    const persisted3 = rootsAfter3.outputs.filter((f) => f.path.startsWith("particle-studio-persistence-v1/"));
    check("run3 persisted pointer record advanced to the redo sequence 5", persisted3.some((f) => f.path.endsWith("pointers.json") && (f.content ?? "").includes('"sequence":5')), persisted3.filter((f) => f.path.endsWith("pointers.json")).map((f) => f.path));
    check("run3 persisted revision record carries the redone value 0.4", persisted3.some((f) => f.path.endsWith(".json") && !f.path.endsWith("pointers.json") && (f.content ?? "").includes("0.4")), persisted3.filter((f) => f.path.endsWith(".json")).map((f) => f.path));
    outcome.run3.persistedRecords = persisted3.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }));

    // ---- run 4: restart without a seed; the undo/redo outcome persisted ----
    const run4 = startRun("run4", false);
    check("run4 docker run argv omits PARTICLE_STUDIO_SEED_PATH (resume without seed)", !run4.args.some((a) => a.includes("PARTICLE_STUDIO_SEED_PATH")), run4.args.filter((a) => a.includes("PARTICLE_STUDIO_SEED_PATH")));
    const initialize4 = await run4.session.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "h3-container-smoke-harness", version: "0.0.0" },
    });
    check("run4 initialize has no JSON-RPC error", initialize4.error === undefined, initialize4.error ?? null);
    check("run4 initialize returns a result object", isRecord(initialize4.result), initialize4.result ?? null);
    run4.session.notify("notifications/initialized");

    const summary4 = toolEnvelope(await run4.session.request("tools/call", { name: "particle_studio.get_draft_summary", arguments: {} }));
    check("run4 restart without a seed path resumes the undo/redo persisted revision 5", summary4.envelope?.summary?.revision === 5, summary4.envelope?.summary);
    check("run4 restart keeps the configured document id", summary4.envelope?.summary?.documentId === DOCUMENT_ID, summary4.envelope?.summary);
    outcome.run4.summaryOnResume = summary4.envelope;

    run4.session.endStdin();
    const exit4 = await run4.session.waitExit();
    check("run4 stdin EOF exits with status 0 and no signal", exit4.code === 0 && exit4.signal === null, exit4);
    outcome.run4.exit = exit4;

    persistTranscript("run4", run4.session);
    check("run4 stdout carries protocol lines", run4.session.stdoutLines.length > 0, run4.session.stdoutLines.length);
    check("run4 stderr carries no JSON-RPC payload", !run4.session.stderrText.includes('"jsonrpc"'), run4.session.stderrText);

    const rootsAfter4 = snapshotRoots("run4-after-exit");
    const persisted4 = rootsAfter4.outputs.filter((f) => f.path.startsWith("particle-studio-persistence-v1/"));
    check("run4 persisted pointer record still names sequence 5", persisted4.some((f) => f.path.endsWith("pointers.json") && (f.content ?? "").includes('"sequence":5')), persisted4.filter((f) => f.path.endsWith("pointers.json")).map((f) => f.path));
    check("run4 persisted revision record still carries the redone 0.4 and resumed 0.6 values", persisted4.some((f) => f.path.endsWith(".json") && !f.path.endsWith("pointers.json") && (f.content ?? "").includes("0.4") && (f.content ?? "").includes("0.6")), persisted4.filter((f) => f.path.endsWith(".json")).map((f) => f.path));
    outcome.run4.persistedRecords = persisted4.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }));

    writeFileSync(join(EVID, "smoke-outcome.json"), JSON.stringify(outcome, null, 2));
    writeFileSync(join(EVID, "smoke-result.json"), JSON.stringify({ status: "PASS", checks: checks.length }, null, 2));
    writeFileSync(join(EVID, "smoke-manifest.json"), JSON.stringify(buildManifest("PASS", {}), null, 2));
    console.log("SMOKE_RESULT=PASS checks=" + checks.length);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeFileSync(
      join(EVID, "smoke-failure.json"),
      JSON.stringify(
        {
          status: "FAIL",
          message,
          checks: checks.length,
          lastCheck: checks[checks.length - 1] ?? null,
          sessions: started.map(({ label, session }) => ({ label, exit: session.exitInfo })),
        },
        null,
        2,
      ),
    );
    for (const { label, name, session } of started) {
      persistTranscript(label + "-partial", session);
      if (session.exitInfo === null) {
        spawnSync("docker", ["kill", "--signal", "SIGKILL", name], { encoding: "utf8" });
      }
      // The docker CLI child can linger after the container itself is killed
      // (observed when the kill lands within the first second of the run),
      // which would keep this process's event loop alive forever. Make sure
      // the failure path actually exits.
      session.child.kill("SIGKILL");
      session.child.stdin.destroy();
      session.child.stdout.destroy();
      session.child.stderr.destroy();
    }
    writeFileSync(join(EVID, "smoke-outcome.json"), JSON.stringify(outcome, null, 2));
    writeFileSync(join(EVID, "smoke-manifest.json"), JSON.stringify(buildManifest("FAIL", { failure: message }), null, 2));
    console.error("SMOKE_RESULT=FAIL " + message);
    process.exitCode = 1;
  }
}

await main();
