# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Expo / Metro needs these for native-addon compilation
RUN apk add --no-cache python3 make g++

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

# Mobile workspace manifest
COPY apps/mobile/package.json apps/mobile/

# Install exactly the committed lockfile — no registry re-resolution.
# (win32-only optional deps like @next/swc-win32-* are skipped cleanly by
# modern npm; the old --force recipe predates that.)
RUN npm ci

# ── Copy full source ──
COPY packages/ packages/
COPY apps/mobile/ apps/mobile/

# Bake env vars into the static web export at build time.
# Railway injects these as build env vars from the service variables.
ARG EXPO_PUBLIC_API_URL
ENV EXPO_PUBLIC_API_URL=$EXPO_PUBLIC_API_URL

# Google Maps API key — only needed for native EAS builds; included here so
# the web export picks it up via app.config.js if it is ever needed.
ARG EXPO_PUBLIC_GOOGLE_MAPS_API_KEY
ENV EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=$EXPO_PUBLIC_GOOGLE_MAPS_API_KEY

# Build stamp (B202) — baked into the web export so the login screen can show
# "build <sha>", the fastest way to prove a phone/browser is actually on the
# new deploy (see lib/build-info.ts). Two ARGs on purpose:
# EXPO_PUBLIC_BUILD_SHA is the explicit knob and always wins;
# RAILWAY_GIT_COMMIT_SHA is a best-effort fallback to the deploying commit.
# `${VAR:-default}` is standard Dockerfile environment-replacement syntax, so
# the fallback costs nothing when the explicit arg is set.
# VERIFIED 2026-08-31 on the #562 deploy: Railway DOES forward
# RAILWAY_GIT_COMMIT_SHA into the build, so the fallback alone is enough and no
# service variable is needed — the shipped bundle carried the full merge sha and
# the login screen read "build e2bc8b3". Should that ever stop being true, the
# symptom is a deploy rendering "build dev", and the fix is a service variable
# EXPO_PUBLIC_BUILD_SHA=${{RAILWAY_GIT_COMMIT_SHA}} on the routeflowmobile
# service. It degrades to "dev" rather than breaking the build either way —
# which is exactly why `shortBuildSha` is total.
ARG EXPO_PUBLIC_BUILD_SHA
ARG RAILWAY_GIT_COMMIT_SHA
ENV EXPO_PUBLIC_BUILD_SHA=${EXPO_PUBLIC_BUILD_SHA:-$RAILWAY_GIT_COMMIT_SHA}

WORKDIR /app/apps/mobile

# babel-preset-expo probes for optional integrations (expo-router, reanimated,
# worklets) with require.resolve FROM ITS OWN LOCATION (node_modules/
# babel-preset-expo). Since the #463 lockfile, npm-on-Linux nests expo-router
# under apps/mobile/node_modules — off that walk-up path — so the preset
# silently skipped its router plugin and the export died with
# "Invalid call at line 2: process.env.EXPO_ROUTER_APP_ROOT".
# NODE_PATH adds the workspace's own node_modules as a CJS resolution fallback,
# fixing the whole class without fighting npm hoisting. Build-stage only.
ENV NODE_PATH=/app/apps/mobile/node_modules

# Export the app as a static web bundle (Expo Router web output → dist/)
RUN npx expo export --platform web

# ─── Stage 2: Runner ──────────────────────────────────────────────────────────
FROM nginx:alpine AS runner

# gettext provides envsubst — used to inject Railway's $PORT into nginx config
RUN apk add --no-cache gettext

# Copy the static SPA output produced by expo export
COPY --from=builder /app/apps/mobile/dist /usr/share/nginx/html

# Store the config template. At start-up we substitute PORT and reload nginx.
# Railway injects PORT at runtime; default is 80 for local dev.
RUN printf 'server {\n\
  listen NGINX_PORT;\n\
  root /usr/share/nginx/html;\n\
  index index.html;\n\
  # Entry HTML must never be served from a stale browser/proxy cache.\n\
  # Hashed JS/CSS chunks (produced by expo export) cache normally via ETags.\n\
  location = /index.html {\n\
    add_header Cache-Control "no-cache, no-store, must-revalidate";\n\
    add_header Pragma "no-cache";\n\
    add_header Expires "0";\n\
    try_files $uri =404;\n\
  }\n\
  location / {\n\
    try_files $uri $uri/ /index.html;\n\
  }\n\
}\n' > /etc/nginx/conf.d/default.conf.template

EXPOSE 80

# At runtime: resolve $PORT (default 80), write config, start nginx.
CMD ["/bin/sh", "-c", \
  "NGINX_PORT=${PORT:-80} && \
   sed s/NGINX_PORT/$NGINX_PORT/ /etc/nginx/conf.d/default.conf.template \
     > /etc/nginx/conf.d/default.conf && \
   nginx -g 'daemon off;'"]
