# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# Manifests first for layer-cache reuse. No packages/* — the control service is isolated.
COPY package.json package-lock.json ./
COPY apps/control/package.json apps/control/

RUN npm ci --ignore-scripts -w @routeflow/control --include-workspace-root=false

COPY apps/control/ apps/control/

WORKDIR /app/apps/control
RUN npm run build

# ─── Stage 2: Runner ──────────────────────────────────────────────────────────
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# git over HTTPS only (one read-only token): no ssh client in the image
RUN apk add --no-cache git

COPY --from=builder /app/apps/control/dist         ./apps/control/dist
# tsc emits only .ts output: the page assets (client.js, styles.css) ride along from src
COPY --from=builder /app/apps/control/src/render/assets ./apps/control/dist/render/assets
COPY --from=builder /app/apps/control/package.json ./apps/control/

# the write path scans every line against the shared denylist (resolved at ../../../../scripts/...)
COPY scripts/campaign/plane-denylist.json scripts/campaign/plane-denylist.json

WORKDIR /app/apps/control

EXPOSE 3000

CMD ["node","dist/main.js"]
