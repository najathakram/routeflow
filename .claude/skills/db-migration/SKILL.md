---
name: db-migration
description: >
  Auto-load for any Prisma schema change, migration, or seed work in RouteFlow. Keywords:
  "migration", "schema.prisma", "prisma migrate", "seed", "alter table", "new column/model".
---

# Skill: DB Migration & Seeding (RouteFlow / Railway / Prisma)

> **Test-tenant policy**: any tenant a test/seed/QA run touches MUST satisfy
> `scripts/lib/test-tenants.cjs` (`test`, `e2e-routeflow`, or `qa-*`/`e2e-*`/`ux-audit-*`).
> Never target a live client tenant — see CLAUDE.md "Test tenants & real-client data".

Encodes the production-safety rules in `CLAUDE_SESSION_PREAMBLE.md`. Prisma 7 + PostgreSQL,
schema at `apps/api/prisma/schema.prisma`, migrations in `apps/api/prisma/migrations/`.

## Hard rules — never break these

- **Never auto-migrate on deploy.** The Docker `CMD` is only `node dist/main.js`. Pushing code
  to `master`/`develop` redeploys app code; it must NOT touch the Railway database.
- **Prod migrations only via** `railway run npx prisma migrate deploy` (controlled, by a human).
- **Never** `prisma migrate reset` / `db push --force-reset` against any DB with real data.
- **Never** call the destructive scripts named in `CLAUDE_SESSION_PREAMBLE.md`
  (e.g. `DANGER-fresh-data-WIPES-ALL-DATA.js`, `nuke-db.js`, `reset-seed.js`, `clear-financial-data.js`, `cleanup-qa-data.js`).
- **Multi-tenant**: new models/columns must carry/relate to `tenantId`; every query stays tenant-scoped.
- Destructive migrations are blocked in CI by Squawk (`npm run lint:migrations`); whitelist a
  statement with `-- reason:` + `-- squawk-ignore <rule>`.

## Local workflow

```bash
npm run db:up                                   # docker-compose Postgres + Redis
cd apps/api
npx prisma migrate dev --name <slug>            # creates + applies migration locally
npx prisma generate                             # refresh client (also runs on postinstall)
npm run check-types                             # confirm types compile
```

Commit the generated migration **with** the code that uses it (same PR, separate commit from impl).

## Seeding (QA / test data)

- Additive only: `INSERT ... ON CONFLICT DO NOTHING` style; idempotent.
- Track every record created (write IDs to a manifest, e.g. `scripts/qa-manifest.json`).
- Cleanup deletes only those tracked IDs — never TRUNCATE a shared table.

## Binary targets (Alpine/Docker)

`schema.prisma` declares `native`, `linux-musl-openssl-3.0.x`, `linux-musl-arm64-openssl-3.0.x`
so the client works in the Railway Alpine image — keep these if you touch the generator block.
