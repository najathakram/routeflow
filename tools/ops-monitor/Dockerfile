# RouteFlow ops monitor (cloud). Build context = repo root:
#   docker build -f tools/ops-monitor/Dockerfile .
# Zero npm dependencies, so there is no install step. The image carries only tools/ops-monitor/
# (see Dockerfile.dockerignore). git is needed for the read-only clones made at boot.
FROM node:20-alpine

RUN apk add --no-cache git

WORKDIR /app
COPY --chown=node:node tools/ops-monitor/ tools/ops-monitor/
RUN mkdir -p /tmp/ops && chown node:node /tmp/ops

# Non-root. Nothing is on disk at boot: the clones go to RF_OPS_HOME (container-local).
USER node
ENV NODE_ENV=production \
    RF_CLOUD=1 \
    RF_MACHINE=cloud \
    RF_OPS_HOME=/tmp/ops

# Secrets (set in the Railway dashboard, never here): GITHUB_TOKEN (read-only),
# RAILWAY_API_TOKEN, OPS_PASSWORD_HASH, OPS_SESSION_SECRET, GITHUB_WEBHOOK_SECRET.
CMD ["node", "tools/ops-monitor/server.mjs", "--cloud"]
