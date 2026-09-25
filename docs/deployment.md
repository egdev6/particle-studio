# Deployment guide

This guide covers the headless MCP image for local stdio-only use. It does not
represent a committed-image smoke pass or a production release. Static editor
publication on Netlify is a separate future surface.

## 1. Static editor (future Netlify publication)

The editor source and `netlify.toml` are not versioned in this slice, so a
static editor deployment is not currently available from the committed tree.
A future publication can build the editor into `apps/editor/dist` separately
from the headless image. The editor does not talk to the container at runtime,
and the container ships no editor code.

## 2. Build the headless image locally

From the repository root:

```bash
docker build -f apps/headless-mcp/Dockerfile -t particle-studio-headless-mcp:local .
```

The build uses the repository root as context, installs the repository-pinned
npm 12.0.2, installs the full exact lock with `npm ci`, regenerates the
scene-document validator inside the builder, and then replaces the tree with a
headless-workspace-only production install
(`npm ci --omit=dev --workspace=@particle-studio/headless-mcp
--include-workspace-root=false`) so the pruned runtime carries no editor
runtime packages. The image stays local; there is no push step.

## 3. Pre-create the three host roots

Create three canonical, pairwise-disjoint directories on the host and hand
them to uid/gid `1000:1000` (for example `chown 1000:1000` on each root):

| Host root   | Container mount    | Access                              |
| ----------- | ------------------ | ----------------------------------- |
| `documents` | `/data/documents`  | mounted read-only                   |
| `workspace` | `/data/workspace`  | mounted read-write                  |
| `outputs`   | `/data/outputs`    | mounted read-write                  |

Documents are the only inputs and stay read-only; the workspace and outputs
roots are writable by uid/gid `1000:1000`. Place the seed file inside the
documents root (for example `documents/seed.json`);
`PARTICLE_STUDIO_SEED_PATH` is relative to the documents root.

The seed file must contain a single scene document validated against the
scene-document v1 schema; besides the obvious document fields, `seed` and
`rootIds` are required. A missing or unreadable seed file fails closed with
`HEADLESS_WORKSPACE_SEED_UNAVAILABLE`, and a malformed or schema-invalid seed
fails closed with `HEADLESS_WORKSPACE_SEED_INVALID`. The following verified
example is the accepted reference seed from the D1 container smoke:

```json
{
  "schemaVersion": 1,
  "durationUs": 1000000,
  "playbackRange": { "startUs": 0, "endUs": 1000000 },
  "loop": true,
  "seed": 42,
  "rootIds": ["shape-1"],
  "elements": [
    {
      "id": "shape-1",
      "type": "shape",
      "x": 16,
      "y": 24,
      "width": 120,
      "height": 80,
      "opacity": 1
    }
  ],
  "tracks": [
    {
      "elementId": "shape-1",
      "property": "opacity",
      "interpolation": "linear",
      "easing": "easeInOutQuad",
      "keyframes": [
        { "timeUs": 0, "value": 0.25 },
        { "timeUs": 1000000, "value": 0.75 }
      ]
    }
  ]
}
```

## 4. Run hardened

Define the three absolute host roots from section 3 as variables before the
run command (adjust the paths to your layout; keep them pairwise-disjoint and
owned by uid/gid `1000:1000`):

```bash
DOCUMENTS="$HOME/particle-studio-headless/documents"
WORKSPACE="$HOME/particle-studio-headless/workspace"
OUTPUTS="$HOME/particle-studio-headless/outputs"
```

Then run the container hardened:

```bash
docker run --rm -i \
  --network=none \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --user 1000:1000 \
  -v "$DOCUMENTS":/data/documents:ro \
  -v "$WORKSPACE":/data/workspace:rw \
  -v "$OUTPUTS":/data/outputs:rw \
  -e PARTICLE_STUDIO_WORKSPACE_ROOT=/data/workspace \
  -e PARTICLE_STUDIO_DOCUMENTS_ROOT=/data/documents \
  -e PARTICLE_STUDIO_OUTPUTS_ROOT=/data/outputs \
  -e PARTICLE_STUDIO_DOCUMENT_ID=document-1 \
  -e PARTICLE_STUDIO_SEED_PATH=seed.json \
  particle-studio-headless-mcp:local
```

The command supplies all five `PARTICLE_STUDIO_*` variables. The first four are always required; `PARTICLE_STUDIO_SEED_PATH` is required only when no persisted draft exists.

## 5. Lifecycle (stdio only)

- Readiness: send an MCP `initialize` request on stdin; a valid response plus
  a `tools/list` exchange on stdout proves the server is ready.
- Shutdown: stdin must stay open until every expected response has been read;
  only then close stdin (EOF) or send SIGTERM to shut the process down.
  Closing stdin is a shutdown signal, not a per-request end: in-flight calls
  are not answered after it, and exit status 0 alone does not prove every
  request was answered.
- stdout is protocol-only (newline-delimited JSON-RPC); every diagnostic goes
  to stderr.
- The container declares no listening port and no health endpoint; there is
  nothing to probe over a network.

## 6. Threat model

The container flags above are defense in depth supplied by the caller.
Application-level confinement — canonical pairwise-disjoint roots, role-bound
paths, and durable persisted artifacts — remains authoritative. Never rely on
the runtime flags alone.

## 7. Distribution boundary

This guide intentionally contains no image push, login, tag, or publish
instructions; the image is built and run locally only.
