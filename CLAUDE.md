# RouteFlow

Multi-tenant delivery / route-management SaaS. **npm + Turbo monorepo** — a NestJS API, a
Next.js web dashboard, and an Expo (React Native) multi-role mobile app, deployed to Railway.

> Production-safety checklist (migrations, destructive scripts) lives in
> [`CLAUDE_SESSION_PREAMBLE.md`](CLAUDE_SESSION_PREAMBLE.md) — read it before any DB/backend work.

## Tech Stack

- **Monorepo**: npm workspaces (`apps/*`, `packages/*`) orchestrated by **Turbo**. Package manager **npm 10.8** (Node ≥ 18, CI pins 20).
- **API** (`apps/api`): NestJS 11, Prisma 7 + PostgreSQL, Redis (Socket.io), Passport JWT auth. Tests: **Jest** (`*.spec.ts`).
- **Web** (`apps/web`): Next.js 14 App Router — the **golden reference** for flows/DTOs. Radix + Tailwind, TanStack Query, react-hook-form + zod. Tests: **Jest + RTL** (`*.test.tsx`, `npm test -w apps/web`) + **Playwright E2E** (`e2e/*.spec.ts`).
- **Mobile** (`apps/mobile`): Expo 55 / RN 0.83, expo-router, multi-role (`(auth)`,`(customer)`,`(driver)`,`(operator)`,`(tenant)`). Tests: **Jest** (`__tests__/*.test.ts`, pure-logic only).
- **Shared** (`packages/*`): `types`, `ui`, `eslint-config`, `config`, `typescript-config`.
- **Lint/format**: ESLint **flat config** (per-workspace) + **Prettier** (root `prettier.config.js`).
- **Deploy**: Railway via Docker (per-app `Dockerfile` + `railway.toml`).

## Run Commands (from repo root)

| Command                   | What it does                                           |
| ------------------------- | ------------------------------------------------------ |
| `npm run dev`             | `turbo run dev` — all apps in watch mode               |
| `npm run build`           | `turbo run build`                                      |
| `npm run lint`            | `turbo run lint` — eslint **per workspace**            |
| `npm run check-types`     | `turbo run check-types` — `tsc --noEmit` per workspace |
| `npm run test`            | `turbo run test` — Jest (api, web, mobile)             |
| `npm run test:e2e`        | `turbo run test:e2e` — Playwright (web)                |
| `npm run format`          | Prettier write across the repo                         |
| `npm run db:up` / `:down` | docker-compose Postgres + Redis for local dev          |

**ESLint runs per-workspace only** (no root `eslint.config`); always lint via `npm run lint`
or inside a workspace — `eslint` from the repo root will not resolve a config.

### Per-app notes

- **API runs from compiled `dist`**: `nest build` then `node dist/main.js`. `nest start --watch` is broken by TS errors under `scripts/` (already excluded in `tsconfig.build.json`). Listens on `:3000`, global prefix `/api/v1`. Health: `GET /api/v1/health`.
- **Web**: `next dev` on `:3001`.
- **Mobile**: `expo start`.

## Local hosting environment (Docker — test features before you commit)

There is **no staging env** — `master` deploys straight to Railway. Before committing a
new feature/fix, run it against the **whole system built from the production Dockerfiles**
locally. This is the pre-PR gate the reverse-engineering review flagged as missing; the
decision + rationale is [`docs/adr/0001-local-hosting-environment.md`](docs/adr/0001-local-hosting-environment.md).

**Two modes, one [`docker-compose.yml`](docker-compose.yml), gated by profiles:**

- **Deps only** (backs the fast `npm run dev` host loop) — `npm run db:up` (== `docker compose up -d postgres redis`). Unchanged.
- **Full stack** (the pre-PR test target) — the `--profile app` services: a one-shot
  `migrate` (`prisma migrate deploy`, mirrors prod), `api` (`:3000`), `web` (`:3001`).

### Runbook (agent: run these in order)

```bash
npm run local:up          # build images + start postgres, redis, migrate, api, web
npm run local:seed        # seed `test` tenant (operator admin / Admin@123) + publish genesis plan catalog
npm run local:validate    # smoke + post-deploy-check + local:drift @ localhost:3000 (the core gate)
npm run local:e2e         # third gate tier, UI changes: allow-listed Playwright projects, ≤ 10 min
```

`local:validate` is the dependable pre-PR gate: `smoke` (health + unauth routes) then
`post-deploy-check` (operator login, orders/invoices/customers/products, **money-math +
invoice reconciliation**), then `local:drift` (read-only schema drift against the compose DB via
`apps/api/scripts/schema-drift.mjs`; exit 2 = drift). `npm run local:validate:features` runs the deeper
`feature-smoke` battery (estimate→invoice convert, AP bills, product-sales, fail-closed
uploads). That battery needs a **published billing plan catalog** — global reference data
the `PlanVersion` table starts empty of — so `local:seed` now publishes it as a genesis
step: after the guarded tenant seed it runs the shipped, idempotent
`db:publish:catalog:v11` publisher (tenant seed **first**, so its `assertSafeTarget` guard
aborts a mis-pointed DB before the prod-capable catalog publisher writes). Verified working
2026-09-03: build → migrate → healthy api+web → seed (+catalog v1) → `local:validate` **and**
`local:validate:features` both green.

Then exercise the feature: **Web** http://localhost:3001 · **API/Swagger**
http://localhost:3000/api/docs · **Health** http://localhost:3000/api/v1/health.
`npm run local:logs` tails api+web; `npm run local:down` stops (keeps data);
`npm run local:reset` stops **and wipes** the Postgres/Redis volumes for a clean DB.
Added a Prisma migration mid-session? Re-run `npm run local:migrate` before re-validating.
`npm run local:drift` runs the read-only schema-drift gate against the compose DB.
`npm run local:test:db` runs the `*.db.spec.ts` lane (DB-backed specs) against it.
`npm run local:e2e` is the third gate tier, for UI changes — a pre-PR Playwright pass against
this stack (allow-listed money/guard projects, ≤ 10 min; `npm run local:e2e:all` runs every
project as a report, not a gate). Hosted staging is still deferred, so E2E remains
authoritative only post-deploy against prod; this lane catches a UI regression before that.
See `apps/web/e2e/LOCAL-LANE.md`.

### Guardrails

- `local:validate` runs **only** against the approved **`test`** tenant (`SMOKE_TENANT_SLUG=test`) —
  never a live tenant (enforced by `assertTestTenant` / the seed's `assertSafeTarget`).
- Compose secrets are **local throwaways** (obvious `*-change-me` values, localhost-only) —
  never reuse them anywhere real; never add prod connection strings or client identifiers.
- Full image builds take minutes (cold cache) — that's fine for a pre-PR check; keep using
  `npm run dev` for line-by-line editing. `web`'s API URL is baked at build time, so
  changing it needs a rebuild. Mobile (Expo) is out of scope — run `expo start` against `:3000`.

## Architecture (API feature modules → `apps/api/src/*`)

- Tenancy/identity: `tenant`, `tenants`, `auth`, `users`, `platform-admin` — **everything is tenant-scoped**; JWT payload carries `tenantId`/`role`.
- Domain: `customers`, `drivers`, `products`, `suppliers`, `orders`, `order-templates`, `routes`, `route-optimization`, `returns`, `inventory`.
- Finance: `invoices`, `credit-notes`, `vendor-bills`, `estimates`, `recurring-invoices`, `bookkeeping`, `billing`.
- Platform: `uploads`/`storage`, `notifications`/`messages`, `email`, `analytics`, `audit`, `import`, `config`/`system-config`.

## Code map routine

A signature-level **code map** lives at [`.claude/code-map/`](.claude/code-map/) (the `code-map`
skill). **Use it instead of re-reading the repo.**

- **Before reading/changing code:** read `code-map/INDEX.md` → the relevant area file
  (`api`/`web`/`mobile`/`packages`.md) → open only the file it points to. Plan changes from the map.
- **After _every_ change (surgical, not a regen):** update the touched entries (purpose,
  exports/signatures, cross-refs) and bump `_meta.json` (`mappedSha`, `generatedAt`). A small code
  change is a few-line map edit.
- Trust the code over the map when they disagree, and fix the map. Money math lives in
  `apps/{api/src/common,web/lib,mobile/lib}/pricing.ts` — keep all three mirrors in sync.

## Lessons learned routine

The rules this project has already paid for live at
[`.claude/lessons/LESSONS.md`](.claude/lessons/LESSONS.md) (the `lessons-learned` skill).

- **Before any major task, implementation, or bug fix:** read it alongside the code map and
  carry the relevant **Lesson** lines into the plan — cite entry ids (`L-016`) when one changes
  the approach.
- **After _every_ bug fix:** append an entry (Symptom / Root cause / **Lesson** / Guard) and
  bump `_meta.json`. **Gate 3 of `.claude/hooks/stop.mjs` blocks the turn otherwise** on
  `fix/*` branches and on `fix:` commits that landed since the register last changed. A fix with
  no transferable lesson bumps `_meta.json.updatedAt` alone — never invent a junk entry.
- Caps: ≤ 40 active entries / 40,960 bytes (enforced by `scripts/validate-lessons.mjs`), overflow
  to `ARCHIVE.md`. Entries are generalizable rules, not incident diaries, and carry **no client
  identifiers** (this repo goes public for CI).

## Money discipline

All line/tax/total math goes through `pricing.ts` helpers: `computeLineSubtotal` (boxed proration),
`normalizeBoxesPieces` (integer boxes/pieces + rollover), and `roundMoney` (cents). **Round every
monetary write**; never re-derive `qty * unitPrice` for a boxed line (over-charges by `unitsPerBox`).
Regression specs: `apps/api/src/common/pricing.spec.ts`. Run `npm run verify` before pushing.

Customer-level order merges (staff `create()` auto-merge, buyer `createOrder`, `mergeAllPendingForCustomer`, `forceConsolidateCustomer`) serialize through `withAdvisoryLock` in `apps/api/src/common/db-locks.ts` — a customer-keyed Postgres advisory lock that is cross-replica safe. **Never add a second in-process lock** on top of it, and never thread a transaction into `updateOrderItems`.

## Conventions

- **Tests**: NestJS `Test.createTestingModule`; mock at the module boundary; `class-validator` DTOs. **No snapshot tests, no Vitest.**
- **Commits**: Conventional Commits (enforced by commitlint) — `feat|fix|test|ci|refactor|docs|chore|perf|revert|build|style`.
- **Mobile mirrors web**: reuse the same API endpoints/DTOs/flows; only the UI differs.
- **Prettier**: semicolons, double quotes, `printWidth` 100, trailing commas.

## Test tenants & real-client data (POLICY — no exceptions)

Live client tenants (and their users, products, orders, and documents) are **real businesses'
production data**. They are never test targets and never examples.

- **Approved test tenants**: `test`, `e2e-routeflow`, `routeflow-demo`, and throwaway slugs
  matching `qa-*`, `e2e-*`, or `ux-audit-*`. ALL testing, seeding, QA, and cleanup — local
  **or production** — happens ONLY on these, with dummy retailers/buyers. Enforced in code by
  [`scripts/lib/test-tenants.cjs`](scripts/lib/test-tenants.cjs) (`assertTestTenant`); every
  tenant-scoped script/test entry point must call it before any write.
- **`routeflow-demo`** is the standing sales-demo tenant (fictional customers, synthetic
  orders/invoices; catalog copied from a real tenant but written only to the demo). Reseed with
  [`apps/api/scripts/demo-seed.js`](apps/api/scripts/demo-seed.js) — see its header for the
  refresh routine. Never demo on a live client tenant.
- **Never reference a live client** (slug, business name, product names, order/invoice numbers,
  tenant UUIDs) in code, tests, fixtures, UI placeholders, examples, docs, or the code map — use
  `acme`-style placeholders instead.
- **Never hardcode credentials or production connection strings** anywhere; read `DATABASE_URL`
  / `SUPER_ADMIN_*` / `PLAYWRIGHT_SA_*` from the environment. Prod DB access goes through
  `railway run --service postgres node <script>`.
- Debugging or changing a live tenant's data happens **only at the client's explicit request**,
  with a fresh backup first, and via read-only reports or dry-run-first scripts
  (`--live-tenant-override` + type-back confirmation where supported).

## DO NOT introduce

Vitest · Biome · Supabase · Vercel · a second HTTP client · a root-level test runner or root ESLint config.
Use what's here: **Jest + Playwright**, **ESLint + Prettier**, **Prisma/Postgres**, **Railway**.

## Environment Variables

Names only — see each app's example file. Never commit values.

- API → [`apps/api/.env.example`](apps/api/.env.example) (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, R2/Stripe/Google keys, `PORT`, `CORS_ORIGINS` …). JWT secrets are **required in every env**.
- Web → [`apps/web/.env.example`](apps/web/.env.example) (`NEXT_PUBLIC_API_URL`, `COOKIE_SECRET`, `DEFAULT_TENANT` …).
- Mobile → [`apps/mobile/.env.example`](apps/mobile/.env.example) (`EXPO_PUBLIC_API_URL` …).

## Deployment & DB safety (Railway)

- Docker `CMD` is **only** `node dist/main.js` — **never** auto-migrate on deploy.
- Schema changes apply to prod **only** via `railway run npx prisma migrate deploy`; locally `npx prisma migrate dev` against docker-compose.
- **Never** `--force-reset`; **never** run the destructive scripts listed in `CLAUDE_SESSION_PREAMBLE.md`; seed additively.
- Boot-time DDL is gone (PR-1, `imp-03a`) — `main.ts` and `platform-config.service.ts` no longer
  run any boot-time DDL — `main.ts` issued it through a raw `pg` `Pool.query`,
  `platform-config.service.ts` through `$executeRaw` tagged templates; a grep for runtime DDL
  must cover `$executeRaw`, `$executeRawUnsafe`/`$queryRaw*`, and `.query(` on a pg client.
  `npm run db:drift -w apps/api`
  (`apps/api/scripts/schema-drift.mjs`) is the drift gate: read-only `prisma migrate status` +
  `migrate diff … --exit-code` against the target DB, exit 0 = no drift. Any schema PR runs it
  against prod after deploy — `railway run --service postgres node
apps/api/scripts/schema-drift.mjs` — and requires exit 0. Its `SCHEMA_DRIFT_PRISMA_CLI` stand-in
  is a **test-only** hook: it is honoured only inside a Jest worker (`JEST_WORKER_ID`) that also
  sets the override (and prints a WARNING when it is); `NODE_ENV` is deliberately not part of the
  guard (CI's db-migrations job sets `NODE_ENV: test`). It is ignored — loudly — anywhere else, so
  a stray export can never make the gate report NO DRIFT from a stub.
- CI's `npm audit` steps run through `scripts/ci-audit-critical.mjs`: the advisory gate fails on
  critical findings, never on registry unavailability (warning + skip; Dependabot is the standing
  net).

### Canonical deploy flow: **public → push/CI → merge → private** (deploy continues private)

Full rationale, failure modes, and the retirement checklist:
[`docs/runbooks/deploy-visibility-flip.md`](docs/runbooks/deploy-visibility-flip.md).

> **Owner authorization (2026-07-31):** the assistant IS authorized to perform the visibility
> flips as part of this routine — a brief public window for CI is an accepted trade-off.

1. **(schema change only)** apply the prod migration first — fresh backup, then
   `railway run --service postgres node apps/api/scripts/prod-migrate.mjs`.
2. **Start `scripts/visibility-watchdog.mjs` detached first** (45 min; see the runbook's
   "Watchdog (mandatory)" section), **then** make it public — `gh repo edit najathakram/routeflow --visibility public --accept-visibility-change-consequences`
3. **Push + CI green + merge the PR to master** (squash) — Railway auto-deploys from the push.
4. **Wait until the deploy reaches `BUILDING`** (never `INITIALIZING`), **then flip private as a
   `finally`** — even if CI or the merge failed — and read visibility back to confirm `PRIVATE`.
5. **Watch the deploy to SUCCESS**, then `npm run post-deploy-check` — E2E fires itself off the
   deploy signal; do not dispatch it.

> ⚠️ Don't `railway up` an UNMERGED branch when master will later auto-deploy: a subsequent master
> push auto-deploys master-without-your-branch and can briefly regress it (hit + fixed on
> #244/#245 — merge to master instead).
>
> **If a deploy ever fails with "Snapshot code → repository not found"**, the Railway GitHub App
> has lost private-repo access again (see memory `project_railway_deploy_outage_2026-07`). Then
> either stay public until the deploy finishes (the pre-2026-07-13 ordering) or force-deploy local
> source: `railway up --service @routeflow/api --ci` then `--service @routeflow/web --ci`.
> Permanent fix = reinstall the Railway GitHub App with private-repo access on `najathakram`.
> Docs-only changes (outside `watchPatterns` = `apps/<svc>/**` + `packages/**`) are SKIPPED by
> Railway — nothing to watch.

## Heavy files policy

No images, videos, or office binaries in git (mobile app icons in
`apps/mobile/assets/` are the exception — required build assets). Machine-local
home: `local-assets/` (gitignored). Generated docs/screenshots go there, never
into `docs/`. The repo goes public briefly for CI, and clones should stay lean.

## Token Budget

- grep before reading whole files; read exports/signatures before bodies.
- Targeted `Edit` for files > 50 lines; bullet-plan changes spanning > 3 files.
- One task per session; `/compact` at checkpoints, `/clear` when switching tasks.

## Session Startup

```bash
git status && git log --oneline -5
npm run check-types
npx jest --selectProjects api --listTests >/dev/null 2>&1 || true  # confirm Jest resolves
```
