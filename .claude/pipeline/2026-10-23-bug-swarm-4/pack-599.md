1e162686ae8f2229119104cd4cfe1eb722537ba3
# Row 599: API default throttle hard-coded 100/60s

## Liveness
apps/api/src/common/throttlers.ts:41 { name: default, ttl: WINDOW_MS, limit: 100 } literal; uploadsLimit (line 39) reads config throttle.uploadsLimit; docker-compose.yml:174-175 sets only AUTH_LOGIN_THROTTLE_*.

## Files / signatures
buildThrottlers(config: ConfigService): ThrottlerOptions[]; UploadsThrottled(); WINDOW_MS

## Radius
throttlers.ts, app.module.ts (APP_GUARD), config (throttle.*), docker-compose.yml, apps/api/.env.example

## Lessons
L-247 grep all construction sites when a ctor dep changes; L-327 specs ahead of changed guards
