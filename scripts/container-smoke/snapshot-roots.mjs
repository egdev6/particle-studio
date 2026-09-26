// Run with node --input-type=module -e inside the smoke image. The caller
// supplies the three role mounts; this module never writes to them.
import { readdirSync, statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export function snapshotRoots(roots = {
  documents: "/data/documents",
  workspace: "/data/workspace",
  outputs: "/data/outputs",
}, fs = { readdirSync, statSync, readFileSync }) {
  function walk(dir, base = dir, acc = []) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, base, acc);
      else if (st.isFile()) {
        const bytes = fs.readFileSync(full);
        acc.push({
          path: full.slice(base.length + 1),
          size: st.size,
          mode: (st.mode & 0o777).toString(8),
          uid: st.uid,
          gid: st.gid,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          ...(st.size < 4096 ? { content: bytes.toString("utf8") } : {}),
        });
      }
    }
    return acc;
  }
  return {
    documents: walk(roots.documents),
    workspace: walk(roots.workspace),
    outputs: walk(roots.outputs),
  };
}
