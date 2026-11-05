# The old Expo mobile-web build is retired (owner ruling 2026-11-04): this service now only answers
# every request with a 302 to the current website (apps/mobile/redirect/server.js, no dependencies).
# Native store builds are EAS builds and never use this file or railway.toml.
# To undo: restore this file and railway.toml's healthcheck from the commit before this change.
FROM node:24-alpine

WORKDIR /app
COPY apps/mobile/redirect/server.js ./server.js

# WWW_BASE_URL overrides the target (default https://www.routeflow.info); Railway injects PORT.
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "server.js"]
