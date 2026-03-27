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
# npm install is used instead of npm ci to handle platform-specific optional
# packages that may be in a lockfile generated on a different OS.
RUN npm install

# ── Copy full source ──
COPY packages/ packages/
COPY apps/mobile/ apps/mobile/

# Bake the API URL into the static web export at build time.
# Railway injects this as a build env var from the service variables.
ARG EXPO_PUBLIC_API_URL
ENV EXPO_PUBLIC_API_URL=$EXPO_PUBLIC_API_URL

WORKDIR /app/apps/mobile

# Export the app as a static web bundle (Expo Router web output → dist/)
RUN npx expo export --platform web

# ─── Stage 2: Runner ──────────────────────────────────────────────────────────
FROM nginx:alpine AS runner

# Copy the static SPA output produced by expo export
COPY --from=builder /app/apps/mobile/dist /usr/share/nginx/html

# SPA routing: unknown paths fall through to index.html so Expo Router
# handles them client-side.
RUN printf 'server {\n\
  listen 80;\n\
  root /usr/share/nginx/html;\n\
  index index.html;\n\
  location / {\n\
    try_files $uri $uri/ /index.html;\n\
  }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80
