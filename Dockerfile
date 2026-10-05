# syntax=docker/dockerfile:1.7

# ---- Stage 1: builder ---------------------------------------------------
# Debian image with a build toolchain so native modules (better-sqlite3,
# argon2) compile cleanly. Only the build output is carried into the runtime
# stage. Node 22.6+ is required (Sidequest, the background-job queue).
FROM node:22-bookworm-slim AS builder

# Build dependencies for native node modules. python3 is needed by node-gyp.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package manifests first so the dependency layer caches across code-only
# changes. .npmrc MUST come along: it carries `legacy-peer-deps=true`, without
# which `npm ci` fails ERESOLVE on the zod 4 (MCP SDK) vs openai `peerOptional
# zod@^3` conflict.
COPY package.json package-lock.json .npmrc ./
COPY server/src/package.json ./server/src/package.json

# Install ALL deps (including devDeps — tsc + vite are needed to build).
# --legacy-peer-deps is belt-and-braces alongside .npmrc.
RUN npm ci --include=dev --legacy-peer-deps

COPY . .

# Build server (tsc → server/dist) and client (vite → client/dist).
RUN npm run build

# Prune devDependencies so the runtime stage only carries what's needed.
RUN npm prune --omit=dev --legacy-peer-deps


# ---- Stage 2: runtime ---------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# tini forwards signals to Node (graceful shutdown: PRAGMA optimize, queue
# drain) and reaps zombies. curl backs the HEALTHCHECK below.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# `--chown` during COPY instead of a later recursive chown, which runs out of
# memory on a large node_modules in some build environments.
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/server/dist ./server/dist
COPY --from=builder --chown=node:node /app/server/src/package.json ./server/src/package.json
COPY --from=builder --chown=node:node /app/client/dist ./client/dist
COPY --from=builder --chown=node:node /app/sidequest.jobs.cjs ./sidequest.jobs.cjs

# Writable runtime directory, owned by the unprivileged user: /app/server/data
# holds cubex.db, jobs.db, the secrets generated on first boot, and uploads/
# (in-flight CSV uploads, emptied at boot). Mount a volume here; an empty
# volume inherits this ownership.
RUN install -d -o node -g node /app/server/data

ENV NODE_ENV=production
ENV PORT=3002
ENV DB_PATH=/app/server/data/cubex.db

VOLUME ["/app/server/data"]
EXPOSE 3002

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT:-3002}/api/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
