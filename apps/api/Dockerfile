# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace manifests first — maximises Docker layer-cache reuse.
# If only source files change, the npm ci layer is not invalidated.
COPY package.json package-lock.json turbo.json ./

# Shared packages (package.json only — source copied later)
COPY packages/config/package.json            packages/config/
COPY packages/eslint-config/package.json     packages/eslint-config/
COPY packages/types/package.json             packages/types/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY packages/ui/package.json               packages/ui/

# API workspace manifest + prisma schema (needed by postinstall `prisma generate`)
COPY apps/api/package.json apps/api/
COPY apps/api/prisma/schema.prisma apps/api/prisma/
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

WORKDIR /app/apps/api

EXPOSE 3000

# TEMP emergency: apply pending migration before starting; revert to ["node","dist/main.js"] after confirmed
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
