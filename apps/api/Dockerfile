# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace manifests first — maximises Docker layer-cache reuse.
# If only source files change, the npm ci layer is not invalidated.
COPY package.json package-lock.json turbo.json ./

# Shared packages (package.json only — source copied later)
COPY packages/config/package.json            packages/config/
COPY packages/eslint-config/package.json     packages/eslint-config/
# @routeflow/pricing is COMPILED (see packages/pricing): the root `postinstall`
# runs its tsc build during the `npm ci` below, so its sources + tsconfigs must
# already be here — a manifest-only copy makes that build fail with no inputs.
COPY packages/pricing/                       packages/pricing/
COPY packages/types/package.json             packages/types/
# Whole directory, not just the manifest: packages/pricing/tsconfig.json extends
# `@routeflow/typescript-config/base.json`, which the postinstall build above
# resolves during `npm ci` — a manifest-only copy leaves that file missing.
COPY packages/typescript-config/             packages/typescript-config/
COPY packages/ui/package.json               packages/ui/

# API workspace manifest + the multi-file prisma schema FOLDER and prisma.config.ts
# (both needed by the postinstall `prisma generate` that runs inside `npm ci` below —
# a missed edit here fails the image build at `npm ci`, not at runtime).
COPY apps/api/package.json apps/api/
COPY apps/api/prisma/schema apps/api/prisma/schema
COPY apps/api/prisma.config.ts apps/api/

# Install all workspace dependencies (with scripts so @nestjs/core postinstall runs).
RUN npm ci

# ── Copy full source ──
COPY packages/ packages/
COPY apps/api/ apps/api/

# Build the NestJS app and generate the Prisma client for the linux-musl
# binary targets required in Alpine Linux containers.
WORKDIR /app/apps/api
RUN npx prisma generate && npm run build

# ─── Stage 2: Runner ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# su-exec lets the root entrypoint drop to the non-root `node` user after fixing
# the mounted uploads-volume perms (F12-003).
RUN apk add --no-cache su-exec

# Root node_modules contains workspace-hoisted runtime deps.
COPY --from=builder /app/node_modules  ./node_modules

# Workspace-level node_modules (packages like rxjs that npm doesn't hoist to root)
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules

# Workspace package sources — required so that workspace symlinks inside
# node_modules (e.g. node_modules/@routeflow/types -> ../../packages/types)
# resolve correctly at runtime.
COPY --from=builder /app/packages      ./packages

# Compiled NestJS application
COPY --from=builder /app/apps/api/dist     ./apps/api/dist

# Prisma schema — needed for `prisma migrate deploy` in init containers
COPY --from=builder /app/apps/api/prisma   ./apps/api/prisma

# Package manifests and Prisma v7 config needed for Node.js module resolution
COPY --from=builder /app/apps/api/package.json    ./apps/api/
COPY --from=builder /app/apps/api/prisma.config.ts ./apps/api/
COPY --from=builder /app/package.json              ./

# Entrypoint fixes the uploads-volume ownership then drops to `node` (F12-003).
COPY apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

WORKDIR /app/apps/api

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
