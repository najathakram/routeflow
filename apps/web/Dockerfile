# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Opt out of Next.js telemetry during the build
ENV NEXT_TELEMETRY_DISABLED=1

# Copy workspace manifests first — maximises Docker layer-cache reuse.
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

# Web workspace manifest
COPY apps/web/package.json apps/web/

# Install exactly the committed lockfile — no registry re-resolution.
# (win32-only optional deps like @next/swc-win32-* are skipped cleanly by
# modern npm; the old --force recipe predates that.)
RUN npm ci

# ── Copy full source ──
COPY packages/ packages/
COPY apps/web/ apps/web/

# NEXT_PUBLIC_* variables must be present at next build time — they are baked
# into the JS bundle and are NOT available from runtime env vars.
# Railway passes service env vars as Docker build args automatically for any
# ARG declared in the Dockerfile.
# BUILD_DATE forces a cache miss on the next build layer whenever it changes,
# ensuring NEXT_PUBLIC vars are always freshly evaluated.
ARG BUILD_DATE=2026-04-14c
ARG NEXT_PUBLIC_API_URL=https://routeflowapi-production.up.railway.app/api/v1
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_GOOGLE_MAPS_KEY=""
ENV NEXT_PUBLIC_GOOGLE_MAPS_KEY=$NEXT_PUBLIC_GOOGLE_MAPS_KEY
# Purge any Next.js build cache to ensure a completely fresh build.
# Then build the Next.js application (output: standalone is set in next.config.mjs)
WORKDIR /app/apps/web
RUN rm -rf .next && npm run build

# ─── Stage 2: Runner ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Next.js standalone output is self-contained: it bundles the minimal set of
# node_modules needed to run the server and mirrors the monorepo directory
# structure (apps/web/server.js) so that import paths remain valid.
COPY --from=builder /app/apps/web/.next/standalone ./

# Static assets (.next/static) must live at the path the standalone server
# expects: <monorepo-root>/apps/web/.next/static
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static

# Public assets (logos, etc.) must be served from <monorepo-root>/apps/web/public
COPY --from=builder /app/apps/web/public ./apps/web/public

ENV HOSTNAME="0.0.0.0"
# PORT is injected by Railway at runtime; Next.js standalone server reads it
# automatically. Do NOT hardcode PORT here — it would conflict with Railway's
# dynamic port assignment, causing the healthcheck to target the wrong port.

# F12-003: run as the non-root `node` user (uid 1000). The Next.js standalone
# server has NO writable volume — it only reads world-readable bundled assets and
# binds Railway's high (>1024) PORT — so a non-root user needs no perm fix-ups.
USER node

# The standalone entry point mirrors the monorepo path (apps/web/server.js)
CMD ["node", "apps/web/server.js"]
