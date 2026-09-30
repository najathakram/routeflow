# Discovery — PR-1 · Retire boot-time DDL; Prisma drift gate; DB-backed spec lane

Status: APPROVED (autonomous improvements program; owner authorization 2026-09-03)
Scale: major · ui: false · Branch: `fix/imp-03a-ddl-to-migrations-drift-gate` off `master` (`91c5333b`)
Program plan (context only, not required reading for agents): `~/.claude/plans/plan-on-implementing-all-zany-parasol.md`, section PR-1.

## Problem, and whose it is

The API mutates the production schema at startup, outside Prisma Migrate, through **two** code
paths:

1. `apps/api/src/main.ts:69-115` — `runStartupMigration()`, gated by `RUN_STARTUP_DDL !== "false"`
   (default ON, set nowhere): `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for 9 columns
   (`TenantConfig.invoiceNotes/invoiceTerms`, `OrderItem.name`, `Order` and `Invoice` ×
   `shippingCarrier/shippingTrackingNumber/shippedAt`) plus `ALTER TABLE "OrderItem" ALTER COLUMN
"productId" DROP NOT NULL`.
2. `apps/api/src/platform-admin/platform-config.service.ts:44-78` — `onModuleInit()`:
   `CREATE TABLE IF NOT EXISTS "PlatformConfig"`, `"AiUsageEvent"`, and
   `CREATE INDEX IF NOT EXISTS "AiUsageEvent_createdAt_idx"` — on **every boot, ungated,
   undocumented** (the architecture review and F12-002 name only path 1).

The repo's stated policy is "never auto-migrate" (`CLAUDE.md` → Deployment & DB safety; Docker
`CMD` is only `node dist/main.js`). The migration history already contains all 13 objects
(`apps/api/prisma/migrations/0_init/migration.sql` — the #349 rebaseline against prod), so both
paths are no-ops today and pure hazard tomorrow.

Whose problem: the owner, who runs every deploy and every prod migration by hand, and anyone
answering "what is the prod schema right now". Frequency: every API boot (each deploy, restart,
and every local `npm run local:up`).

## Cost today

Three uncoordinated schema paths (manual `migrate deploy` before merge; boot DDL; a CI job that
only replays history onto a fresh DB). Nothing compares the live database to `schema.prisma`, so
a column added by boot DDL or by hand would never be detected. The architecture review rated this
P0 🔴; F12-002 records the contradiction without closing it.

## Current workaround and why it fails

`RUN_STARTUP_DDL=false` exists as a kill-switch but is set in no environment; path 2 has no
switch at all. `apps/api/scripts/prod-migrate.mjs` runs `prisma migrate status` — which reports
pending migrations, not drift. A default-off flag would leave the mechanism (and the temptation)
in place; the fix is deletion plus a loud gate.

## Why now

Every later schema item in the program (Atlas lint in PR-5, the `prisma/schema/` folder split in
PR-15) needs a single-writer history and a gate proving history == datamodel == prod. **Prod was
verified drift-free on 2026-09-03** (read-only, via `railway run --service postgres` + the TCP-proxy
URL exactly as `prod-migrate.mjs` builds it): `migrate status` → 23 migrations applied, none
pending or failed; `migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
--exit-code` → `-- This is an empty migration.`, exit 0; all 13 boot-DDL objects present and
identical. The window in which deletion is _provably_ safe is open now.

## If we ship nothing

The boot DDL keeps running as a no-op until someone adds the next column there instead of in a
migration; prod and the migration history then diverge silently, and the next `migrate deploy`,
rebaseline, or Atlas lint fails — or drops the column. The policy contradiction stays live.

## Success signal (observable) and baseline

- `node apps/api/scripts/schema-drift.mjs` exits 0 against prod after deploy and against the
  replayed fresh DB in CI on every PR touching `apps/api/prisma/**` — baseline: no such check
  exists (0 runs ever).
- The API boot log contains no DDL statement — baseline: two DDL blocks per boot.
- `apps/api/src` contains no file that both calls `$executeRaw*` and contains
  `CREATE|ALTER|DROP TABLE|INDEX|COLUMN|TYPE|SCHEMA` — baseline: 2 files.

## Who else is affected

- Local hosting: `docker-compose.yml`'s `migrate` one-shot already runs `prisma migrate deploy`
  before `api` starts, so removing boot DDL changes nothing locally (and the compose `api` service
  never set `RUN_STARTUP_DDL`).
- CI: `.github/workflows/db-migrations.yml` gains a drift step and a DB-backed-spec step.
- Later PRs (order-merge advisory lock, cron leader lock, `findUnique` tenancy pins) need the
  `*.db.spec.ts` lane this PR introduces, because the single `verify` CI job deliberately has no
  Postgres service (`ci.yml` header: "not one spec constructs a PrismaClient").

## Symptom or root cause?

Root cause: a second (and third) schema writer. The solution shape (Prisma-native drift gate,
"Option A") is the owner's decision; Atlas ("Option B") follows in PR-5 on top of this.

## Strongest objection

"A stale environment might still lack these columns; boot DDL is a cheap safety net." — Prod is
verified identical today (evidence attached to the PR); local is migrated by the compose one-shot
before the API boots; there is no staging. A net that can silently write schema is the hazard,
not the protection. The drift gate is the replacement net, and it is loud (exit 2 + the SQL).

## Stop conditions

Shipping nothing costs a live policy contradiction (not little); the request is a root cause, not
a symptom; the user, workaround and success signal are stated. **Proceed.**

## Reuse before re-deriving

- `.claude/code-map/api.md` (F12-002 note at :1416; `main.ts`, `platform-config.service.ts`,
  `prod-migrate.mjs` entries).
- Lessons to carry: L-011 (regenerate the Prisma client after any checkout across a schema
  change), L-021 (tenant-scoped writes go through the parent), L-027 (never satisfy a gate from
  another tree), L-034 (an artifact is evidence only with the tool and run named), L-039 (land a
  gate only with headroom).
- `apps/api/scripts/prod-migrate.mjs:22-41` — the TCP-proxy URL construction to **extract and
  reuse**, not copy.
- Prisma 7.10 CLI facts verified by execution: `--from-url` and `--to-schema-datamodel` no
  longer exist; use `--from-config-datasource` (reads `DATABASE_URL` through
  `apps/api/prisma.config.ts`) and `--to-schema <file>`; `--exit-code` → 0 same / 2 diff / 1 error.
