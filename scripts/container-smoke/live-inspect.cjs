"use strict";
// Live in-container inspection for D1-4. Executed with `docker exec <name> node -e <this file>`
// inside the running smoke container, so every reading comes from that
// container's own namespaces (uid, netns, mount ns, caps) while the server is live.
const fs = require("node:fs");

const status = fs.readFileSync("/proc/self/status", "utf8");
const pick = (key) => {
  const match = new RegExp("^" + key + ":\\s*(.*)$", "m").exec(status);
  return match ? match[1].trim() : null;
};
const parseNet = (path) => {
  const rows = fs
    .readFileSync(path, "utf8")
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/));
  return rows.map((c) => ({ localAddress: c[1], remoteAddress: c[2], state: c[3], uid: c[7], inode: c[9] }));
};
const tryWrite = (path, data) => {
  try {
    fs.writeFileSync(path, data);
    return { ok: true, path };
  } catch (error) {
    return { ok: false, path, code: error.code, message: error.message };
  }
};
const mountinfo = fs
  .readFileSync("/proc/self/mountinfo", "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [pre, post] = line.split(" - ");
    const f = pre.split(" ");
    const p = post.split(" ");
    return { mountId: f[0], root: f[3], mountPoint: f[4], mountOptions: f[5], fstype: p[0], source: p[1], superOptions: p[2] };
  })
  .filter((m) => m.mountPoint.startsWith("/data") || m.mountPoint === "/tmp" || m.mountPoint === "/" || m.mountPoint.startsWith("/etc/"));
const mounts = fs
  .readFileSync("/proc/self/mounts", "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const c = line.split(" ");
    return { source: c[0], mountPoint: c[1], fstype: c[2], options: c[3] };
  })
  .filter((m) => m.mountPoint.startsWith("/data") || m.mountPoint === "/tmp");
const tag = process.env.PROBE_TAG || "unknown";
const probeContent = process.env.PROBE_CONTENT || "probe";
const crypto = require("node:crypto");
const readProbe = (path) => {
  try {
    const bytes = fs.readFileSync(path);
    return { ok: true, path, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), content: bytes.toString("utf8") };
  } catch (error) {
    return { ok: false, path, code: error.code, message: error.message };
  }
};

const tcp = parseNet("/proc/net/tcp");
const tcp6 = parseNet("/proc/net/tcp6");
console.log(
  JSON.stringify(
    {
      probeTag: tag,
      uid: process.getuid(),
      gid: process.getgid(),
      groups: process.getgroups(),
      execPath: process.execPath,
      cwd: process.cwd(),
      procStatus: {
        uid: pick("Uid"),
        gid: pick("Gid"),
        capEff: pick("CapEff"),
        capPrm: pick("CapPrm"),
        capBnd: pick("CapBnd"),
        noNewPrivs: pick("NoNewPrivs"),
        seccomp: pick("Seccomp"),
      },
      interfaces: fs.readdirSync("/sys/class/net"),
      interfaceOperstate: Object.fromEntries(
        fs.readdirSync("/sys/class/net").map((name) => [name, fs.readFileSync("/sys/class/net/" + name + "/operstate", "utf8").trim()]),
      ),
      tcp,
      tcp6,
      listeningTcpSockets: [...tcp, ...tcp6].filter((row) => row.state === "0A").length,
      mountinfo,
      mounts,
      mappings: {
        documentsMarker: readProbe("/data/documents/.d1-smoke-host-marker.txt"),
        workspaceMarker: readProbe("/data/workspace/.d1-smoke-host-marker.txt"),
        outputsMarker: readProbe("/data/outputs/.d1-smoke-host-marker.txt"),
        seedInContainer: readProbe("/data/documents/seed.json"),
      },
      writes: {
        documentsProbe: tryWrite("/data/documents/" + tag + "-write-probe.txt", probeContent),
        workspaceProbe: tryWrite("/data/workspace/" + tag + "-write-probe.txt", probeContent),
        outputsProbe: tryWrite("/data/outputs/" + tag + "-write-probe.txt", probeContent),
        appRootProbe: tryWrite("/app/" + tag + "-write-probe.txt", "probe"),
        etcProbe: tryWrite("/etc/" + tag + "-write-probe.txt", "probe"),
        tmpProbe: tryWrite("/tmp/" + tag + "-write-probe.txt", "probe"),
      },
    },
    null,
    2,
  ),
);
