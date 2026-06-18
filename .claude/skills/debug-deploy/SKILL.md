---
name: debug-deploy
description: >
  Auto-load when a Railway deploy fails, a health check is down, or logs show startup errors
  for RouteFlow. Keywords: "deploy failed", "health check", "railway logs", "rollback",
  "not starting", "502", "container crash".
---

# Skill: Debug Deployment (RouteFlow / Railway)

Three services deploy from per-app `Dockerfile` + `railway.toml`: **api**, **web**, **mobile**.
Health checks: api `GET /api/v1/health`, web `/login`, mobile `/`.

## Triage

```bash
railway status
railway logs --service api --tail 200      # or: web | mobile
railway variables --service api            # confirm required env present (names only)
```

Verify the API is actually up:

```bash
curl -fsS https://<api-domain>/api/v1/health        # expect {"status":"ok",...}
```

## Common failure modes

- **Boots then exits**: a required env is missing. `JWT_SECRET` and `JWT_REFRESH_SECRET` are
  **asserted at startup in every env** — absence crashes `main.ts` immediately. Also check `DATABASE_URL`, `REDIS_URL`.
- **PORT / not reachable**: Railway injects `PORT`; the app must read `process.env.PORT` (it does).
  Don't hardcode 3000 in deploy config.
- **Prisma engine error in container**: Alpine needs the `linux-musl-*` binary targets in
  `schema.prisma` — see the db-migration skill.
- **Wrong client IP / rate-limit / CORS oddities**: `main.ts` sets `trust proxy = 2` for Railway's
  LB + CDN; CORS uses `CORS_ORIGINS` + `CORS_WILDCARD_DOMAINS`.
- **DB schema drift after deploy**: expected — deploys do **not** migrate. Apply intentionally with
  `railway run npx prisma migrate deploy` (see db-migration skill). Never reset.

## Rollback

```bash
railway rollback --service <api|web|mobile>     # immediate revert to previous deploy
```

CI/CD is intentionally left as-is (`$0` Actions budget). Don't add deploy steps to GitHub Actions
to "fix" a deploy — debug Railway directly.
