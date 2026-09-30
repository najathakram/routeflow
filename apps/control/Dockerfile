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

RUN apk add --no-cache git openssh-client

COPY --from=builder /app/apps/control/dist         ./apps/control/dist
COPY --from=builder /app/apps/control/package.json ./apps/control/

WORKDIR /app/apps/control

EXPOSE 3000

CMD ["node","dist/main.js"]
