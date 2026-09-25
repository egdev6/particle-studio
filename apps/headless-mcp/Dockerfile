# Headless MCP stdio server image. Build from the repository root:
#   docker build -f apps/headless-mcp/Dockerfile -t particle-studio-headless-mcp:local .
#
# The base image is pinned to the accepted multi-architecture manifest digest
# through a single ARG so both stages are provably identical.

ARG NODE_IMAGE=node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

# Stage 1 (builder): full exact-lock install, deterministic validator
# generation, then a production-only dependency prune.
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./tsconfig.base.json
COPY apps/editor/package.json apps/editor/package.json
COPY apps/headless-mcp/package.json apps/headless-mcp/package.json
COPY packages/commands/package.json packages/commands/package.json
COPY packages/export/package.json packages/export/package.json
COPY packages/persistence/package.json packages/persistence/package.json
COPY packages/persistence-indexeddb/package.json packages/persistence-indexeddb/package.json
COPY packages/persistence-fs/package.json packages/persistence-fs/package.json
COPY packages/renderer-canvas2d/package.json packages/renderer-canvas2d/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/scene-document/package.json packages/scene-document/package.json
COPY packages/webmcp-adapter/package.json packages/webmcp-adapter/package.json
RUN npm install --global npm@12.0.2 --ignore-scripts --no-audit --no-fund
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY apps/headless-mcp ./apps/headless-mcp
COPY packages ./packages
RUN npm run validator:prepare
RUN npm ci --omit=dev --workspace=@particle-studio/headless-mcp --include-workspace-root=false --ignore-scripts --no-audit --no-fund

# Stage 2 (runtime): pruned runtime only. Non-root, stdio-only, no listening
# surface, no editor code, no runtime package installation.
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production HOME=/tmp TSX_DISABLE_CACHE=1
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/tsconfig.base.json ./tsconfig.base.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/headless-mcp ./apps/headless-mcp
COPY --from=builder /app/packages/commands ./packages/commands
COPY --from=builder /app/packages/persistence ./packages/persistence
COPY --from=builder /app/packages/persistence-fs ./packages/persistence-fs
COPY --from=builder /app/packages/scene-document ./packages/scene-document
USER node
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "--import", "tsx", "apps/headless-mcp/src/main.ts"]
