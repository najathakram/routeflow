# RouteFlow ops monitor (cloud). Deployed with `railway up tools/ops-monitor --path-as-root`, so the
# build context root IS tools/ops-monitor. Zero npm dependencies: no install step. git is needed for
# the read-only clones made at boot.
FROM node:20-alpine

RUN apk add --no-cache git

WORKDIR /app
COPY --chown=node:node . /app/tools/ops-monitor/
RUN mkdir -p /tmp/ops && chown node:node /tmp/ops

# Non-root. Nothing is on disk at boot: the clones go to RF_OPS_HOME (container-local).
USER node
ENV NODE_ENV=production \
    RF_CLOUD=1 \
    RF_MACHINE=cloud \
    RF_OPS_HOME=/tmp/ops

# Secrets (set in the Railway dashboard, never here): GITHUB_TOKEN (read-only),
# RAILWAY_API_TOKEN, OPS_PASSWORD_HASH, OPS_SESSION_SECRET, GITHUB_WEBHOOK_SECRET,
# CLIENT_NAMES_JSON (a JSON array of live-client names to mask; the cloud refuses to start without it).
CMD ["node", "tools/ops-monitor/server.mjs", "--cloud"]
