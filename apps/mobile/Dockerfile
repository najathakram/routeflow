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
COPY packages/types/package.json             packages/types/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY packages/ui/package.json               packages/ui/

# Mobile workspace manifest
COPY apps/mobile/package.json apps/mobile/

# Install all workspace dependencies.
# --force bypasses the EBADPLATFORM error for @next/swc-win32-x64-msvc which
# ends up in the lockfile when generated on Windows.
RUN npm install --force

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
