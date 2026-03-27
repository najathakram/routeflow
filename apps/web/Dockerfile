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
COPY packages/types/package.json             packages/types/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY packages/ui/package.json               packages/ui/

# Web workspace manifest
COPY apps/web/package.json apps/web/

# Install all workspace dependencies.
# --force bypasses the EBADPLATFORM error for @next/swc-win32-x64-msvc which
# ends up in the lockfile when generated on Windows. The Linux SWC binary is
# installed automatically by Next.js; the Windows artifact is simply skipped.
RUN npm install --force

# ── Copy full source ──
COPY packages/ packages/
COPY apps/web/ apps/web/

# Build the Next.js application (output: standalone is set in next.config.mjs)
WORKDIR /app/apps/web
RUN npm run build

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

# Public assets (images, favicons, etc.)
COPY --from=builder /app/apps/web/public ./apps/web/public

EXPOSE 3001

ENV PORT=3001
ENV HOSTNAME="0.0.0.0"

# The standalone entry point mirrors the monorepo path (apps/web/server.js)
CMD ["node", "apps/web/server.js"]
