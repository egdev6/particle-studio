# Container smoke harness

In-tree, self-contained smoke harness for the hardened `particle-studio-headless-mcp`
container image. It runs four sequential `docker run --rm -i` sessions against one
evidence root and records every observation under that root:

- **run 1** (seeded): initialize, `tools/list`, live in-container inspection
  (uid/gid, network, mounts, write probes), summary, mutating dispatch,
  `validate_draft`, clean stdin-EOF shutdown, host-side persistence checks.
- **run 2** (no seed): resume of the persisted revision, second mutating
  dispatch, clean `SIGTERM` shutdown, persistence checks.
- **run 3** (no seed): container-level undo/redo coverage — tools surface,
  dispatch, `undo`, `redo`, the exact stable `NOTHING_TO_UNDO` /
  `NOTHING_TO_REDO` denial envelopes, and the revision progression
  2 → 3 → 4 → 5 observed from the real envelopes.
- **run 4** (no seed): fresh restart proving the undo/redo outcome persisted
  (revision 5 and the redone/resumed keyframe values in the persisted records).

## Purpose

The harness proves, against the real container, that the accepted hardening and
the durable headless workspace behavior hold end to end. It replaces the
temporary `/tmp` D1 evidence driver. The versioned harness lives under
`scripts/container-smoke/`, deliberately outside every Vitest project and
outside `npm run typecheck`. From a clean checkout, build the image and run the
harness using the commands below. CI builds the same local image from the
repository root and runs all four sessions; its evidence lives under the
runner's temporary directory and is ephemeral (not uploaded as an artifact).

## Prerequisites

- A running Docker daemon.
- The image built with the documented command (from the repository root):

  ```bash
  docker build --progress=plain -f apps/headless-mcp/Dockerfile -t particle-studio-headless-mcp:d1-smoke .
  ```

- Node.js on the host (the harness is plain ESM, no dependencies).

## Invocation

```bash
PARTICLE_STUDIO_SMOKE_EVIDENCE=/abs/path/evidence-root \
PARTICLE_STUDIO_SMOKE_IMAGE=particle-studio-headless-mcp:d1-smoke \
PARTICLE_STUDIO_SMOKE_SEED=/path/to/seed.json \
node scripts/container-smoke/smoke.mjs
```

- `PARTICLE_STUDIO_SMOKE_EVIDENCE` (required): absolute path to the evidence
  root to create and populate. It must not exist or must be empty.
- `PARTICLE_STUDIO_SMOKE_IMAGE` (optional): image reference to smoke; defaults
  to `particle-studio-headless-mcp:d1-smoke`.
- `PARTICLE_STUDIO_SMOKE_SEED` (optional): path to a seed document; when absent
  the harness writes its own reference seed. The seed's SHA-256 (over the exact
  bytes placed in `roots/documents/seed.json`) is recorded in the manifest.

Exit status is `0` only when every check passes; any failed check exits
non-zero and writes a `smoke-failure.json` naming the check and its observed
detail.

## Evidence layout

The harness creates and fills the evidence root with:

- `smoke-manifest.json` — machine-readable summary: image id/digests/size, the
  full `docker run` argv of every session, the seed hash, check totals,
  result, and the harness's own path.
- `smoke-result.json` / `smoke-outcome.json` — final status and observed
  envelopes; `smoke-failure.json` on failure.
- `checks.log` — one JSON line per check, in execution order.
- `runN-docker-run-argv.json`, `runN-stdout-lines.jsonl`, `runN-stderr.log`,
  and `runN-after-exit-roots-snapshot.json` (runs 1–4); container id files
  (`runN-<timestamp>.cid`) also exist for runs 1–4.
- `runN-docker-inspect.json` (runs 1–2 only),
  `runN-docker-inspect-rc.txt` (runs 1–2 only),
  `runN-docker-top.txt` (runs 1–2 only), and
  `runN-live-inspect.json` (runs 1–2 only);
  `run1-live-roots-snapshot.json` and `run1-image-devdirs.json` (run 1 only),
  and `run2-docker-kill.txt` (run 2 only).
- `roots/documents`, `roots/workspace`, `roots/outputs` — the three
  pairwise-disjoint role roots; `documents/seed.json` is the seeded document,
  and each role root carries the host marker
  `roots/<role>/.d1-smoke-host-marker.txt` that the harness writes before the
  sessions start.
- On failure, additionally: `runN-partial-stdout-lines.jsonl` and
  `runN-partial-stderr.log` for every started session, and `.error` variants
  (`runN-live-inspect.json.error`, `runN-image-devdirs.json.error`) whenever
  the corresponding probe exits non-zero.

## Hardening contract asserted

Every session runs with, verbatim: `--rm -i`, `--network=none`, `--read-only`,
`--tmpfs /tmp:rw,nosuid,nodev,size=64m`, `--user 1000:1000`, documents mounted
read-only (`:ro`), workspace and outputs read-write (`:rw`), no exposed port,
stdio only. The harness verifies these from `docker inspect` and from live
in-container probes (`/proc` uid/gid, only the loopback interface, no TCP
sockets, read-only write probes failing with `EROFS`, role markers proving the
mounts are not swapped). Each resuming session's recorded `docker run` argv is
asserted to contain no `PARTICLE_STUDIO_SEED_PATH` (runs 2–4), and — from the
image's own `docker image inspect` configuration — the harness asserts that the
built image exposes no ports, declares no volumes, defines no healthcheck,
stops on `SIGTERM`, runs as the non-root `node` user, and starts through the
exec-form entrypoint.

## Deliberate exclusions

- This harness is **not** part of `npm test`, `test:product`, or any Vitest
  project, and it is **not** typechecked: it is a plain `.mjs` script under
  `scripts/`, outside every test glob, requiring a real Docker daemon and the
  built image.
- No npm script entry was added on purpose: `package.json` is copied into the
  image, so a new entry would needlessly invalidate the accepted artifact.
  Invoke the harness directly with `node`.
- `inspect-dirs.mjs` is an additional in-container helper (production
  `node_modules` dev-directory audit), executed by the harness against run 1
  and usable standalone for manual image inspection. The harness requires valid
  output for its curated list of 12 known dev dependency directories and fails
  if any are present; this is not an exhaustive dependency-graph audit.

## Why it lives outside the image COPY set

The Dockerfile copies the whole app directory (`COPY apps/headless-mcp
./apps/headless-mcp`), so a harness under `apps/headless-mcp/` would be baked
into the runtime image and would change the accepted artifact. Inside the
Docker build context, `scripts/` is never copied by any `COPY` line. Adding
the harness here adds no Docker COPY input path; complete historical equality
of copied inputs is not established.
