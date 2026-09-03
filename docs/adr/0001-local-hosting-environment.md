# 1. Local hosting environment via Docker Compose profiles

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** RouteFlow maintainers
- **Related:** [`docs/IMPROVEMENTS.md`](../IMPROVEMENTS.md) (#7 — Local full-stack Docker hosting), [`CLAUDE.md`](../../CLAUDE.md) (§ Local hosting environment)

> This is the first Architecture Decision Record in the repo. It also establishes
> the `docs/adr/` convention: one Markdown file per decision, numbered
> `NNNN-kebab-title.md`, MADR-style (Status / Context / Decision / Options /
> Consequences). Records are immutable once Accepted — supersede with a new ADR
> rather than rewriting history.

## Context and problem statement

RouteFlow deploys straight from `master` to Railway with **no staging environment**
(see [`docs/IMPROVEMENTS.md`](../IMPROVEMENTS.md) P1). The only gate before a merge is
the host pre-push hook (`npm run verify`: type-check, lint, unit tests) plus a single
CI `verify` job; the full-stack Playwright E2E suite runs **only after** the Railway
deploy fires. That means the first time the actual built artifacts (the API container +
the Web container + Postgres + Redis, wired together) run as a system is **in
production**. A wiring regression — a bad migration, a broken DTO contract between web
and api, a missing env var, a Redis/adapter change — is not observable until after it
ships.

We want a way to **run the whole system locally, from the same Docker images we ship,
and exercise a new feature against it before committing** — closing the "never runs as
a system until prod" gap without standing up cloud staging infrastructure.

Constraints that shaped the decision:

- The repo already has [`docker-compose.yml`](../../docker-compose.yml) for Postgres +
  Redis (`npm run db:up`), and per-app production `Dockerfile`s
  ([`apps/api/Dockerfile`](../../apps/api/Dockerfile),
  [`apps/web/Dockerfile`](../../apps/web/Dockerfile)). Reuse them; don't invent a
  parallel build path that can drift from prod.
- The everyday inner loop (`npm run dev` with hot reload) must stay fast and
  **unchanged** — full container rebuilds are for pre-PR verification, not for editing.
- Validation must run **only against approved test tenants** (`test`, `e2e-routeflow`,
  `qa-*`, …) per the [`CLAUDE.md`](../../CLAUDE.md) data policy — never a live tenant.
- Mobile (Expo) is out of scope: it runs via `expo start` against the local API, not as
  a container.

## Decision

Extend the **existing** `docker-compose.yml` with an opt-in **`app` profile** that
brings up the full stack from the production Dockerfiles, plus a set of `local:*` npm
scripts and a runbook in `CLAUDE.md`. Concretely:

1. **Two modes, one compose file, gated by profiles:**
   - **Default (deps only)** — `docker compose up -d postgres redis` (== `npm run db:up`)
     is untouched. This backs the fast `npm run dev` host loop.
   - **Full stack** — `docker compose --profile app up` additionally builds and starts
     `migrate`, `api`, and `web`.

2. **`migrate` is a one-shot job**, not a long-running service. It reuses the built API
   image (which ships `prisma/schema.prisma`, `prisma/migrations`, and the Prisma CLI)
   and runs `prisma migrate deploy` — mirroring production
   (`railway run npx prisma migrate deploy`). `api` starts only after it exits 0
   (`depends_on: { migrate: { condition: service_completed_successfully } }`).
   **No boot-time auto-migration** — consistent with the Railway rule that the container
   `CMD` never migrates.

3. **`api` runs with `NODE_ENV=development`** so that only the two JWT secrets are
   mandatory (the prod-only `STORAGE_URL_SIGNING_SECRET` gate is skipped) and Swagger is
   served at `/api/docs`. All secrets in compose are obvious **local throwaways**.

4. **`web` bakes `NEXT_PUBLIC_API_URL=http://localhost:3000/api/v1` as a build arg.**
   Next.js inlines `NEXT_PUBLIC_*` at **build** time, and the browser runs on the
   **host**, so the API URL must be the host-published port (`localhost:3000`), not the
   compose-internal `api:3000`.

5. **Seeding stays a host step** (`npm run local:seed` → the api workspace's `db:seed`
   against `localhost:5432`). The seed already targets the approved `test` tenant and
   carries a `assertSafeTarget()` guard (local hosts only). Keeping it on the host uses
   the full TS toolchain (`ts-node`, `tsconfig-paths`) that the slim runner image omits.
   The `test` seed also now enables the `order_delivery` + `recurring_routes` add-ons for
   the tenant (mirroring the standing demo tenant) so its own seeded drivers/routes aren't
   403'd by the `AddonGuard` — surfaced by the first local validation run.

6. **Validation reuses the scripts we already ship**, split into a dependable core gate
   and an optional deeper probe:
   - **`npm run local:validate`** (the gate) — [`scripts/smoke.mjs`](../../scripts/smoke.mjs)
     - [`scripts/post-deploy-check.mjs`](../../scripts/post-deploy-check.mjs) against
       `http://localhost:3000` with `SMOKE_TENANT_SLUG=test`: health, operator login,
       orders/invoices/customers/products, money-math and invoice reconciliation. Green on a
       freshly seeded stack.
   - **`npm run local:validate:features`** — [`scripts/feature-smoke.mjs`](../../scripts/feature-smoke.mjs),
     the exhaustive feature battery (estimate→invoice convert, AP bills, product-sales
     invariants, fail-closed uploads, …). It needs a **published billing plan catalog** on
     top of the tenant seed, because catalog-dependent flows (e.g.
     `POST /estimates/:id/convert-to-invoice`) resolve entitlements against it and otherwise
     404 with _"No published plan catalog exists"_. The billing catalog is **global
     reference data** (not tenant-scoped) and is normally published through the platform-admin
     Plans editor / `PlanCatalogService`; on a fresh local DB the `PlanVersion` table is empty.
     So **`local:seed` now publishes the current catalog as a genesis step**: after the
     `assertSafeTarget`-guarded tenant seed runs, it invokes the already-shipped, idempotent
     [`publish-plan-catalog-v11`](../../apps/api/prisma/publish-plan-catalog-v11.ts) publisher
     (`db:publish:catalog:v11`). On an empty DB that script creates version 1 (4 plan
     definitions + 5 add-on SKUs) and PUBLISHES it, mirroring `PlanCatalogService`
     byte-for-byte; on a re-run it's a no-op. Reusing the canonical publisher rather than a
     bespoke seed keeps the local catalog from drifting from what prod ships. The tenant seed
     runs **first** so its local-only guard aborts a mis-pointed `DATABASE_URL` before the
     (prod-capable, unguarded) catalog publisher can write.

## Ports & topology

```
Host                          Docker network (compose)
────                          ────────────────────────
localhost:3000  ── :3000 ──▶  api    (NestJS, NODE_ENV=development, /api/v1)
localhost:3001  ── :3000 ──▶  web    (Next.js standalone) ── browser calls ─▶ localhost:3000/api/v1
localhost:5432  ── :5432 ──▶  postgres (postgres:16-alpine)
localhost:6379  ── :6379 ──▶  redis    (redis:7-alpine)
                              migrate  (one-shot: prisma migrate deploy, then exits)

start order: postgres+redis healthy → migrate exits 0 → api healthy → web
```

## Runbook (canonical)

```bash
# 0. one-time: Docker Desktop running
npm run local:up          # build images + start postgres, redis, migrate, api, web
npm run local:seed        # seed approved `test` tenant (operator admin / Admin@123) + publish genesis plan catalog
npm run local:validate    # smoke + post-deploy-check @ localhost:3000 (the core gate)
npm run local:validate:features   # deeper feature battery (needs the catalog local:seed now publishes)
# ... exercise your feature at http://localhost:3001 (web) / http://localhost:3000/api/docs (Swagger) ...
npm run local:logs        # tail api + web logs
npm run local:down        # stop the stack (keeps volumes)
npm run local:reset       # stop AND wipe postgres/redis volumes (fresh DB)
```

After adding a Prisma migration during a session, re-run `npm run local:migrate` (or
`local:up` again) before re-validating.

The authoritative copy of this runbook lives in [`CLAUDE.md`](../../CLAUDE.md) so the
coding agent picks it up automatically.

## Options considered

1. **Compose `app` profile reusing the prod Dockerfiles (chosen).** One compose file,
   no drift from what ships, default deps-only path preserved. Cost: full image builds
   are slower than hot reload (mitigated — builds are for pre-PR checks, not editing).
2. **Cloud staging on Railway.** Highest fidelity, but recurring cost and setup, and
   still slower to iterate than local. Deferred as a separate P1 improvement; this ADR
   is the cheap first step, not a replacement.
3. **A second `docker-compose.full.yml` overlay.** Rejected: two files drift, and
   `-f a.yml -f b.yml` is easy to forget. Profiles keep it in one file with one obvious
   default.
4. **Seed/migrate from inside the runner container.** Rejected for seeding: the slim
   runner image omits `ts-node`/`tsconfig`, and its `NODE_ENV=production` trips the
   seed's production guard. Migration stays in-container (CLI-only, no TS needed); seed
   stays on the host.

## Consequences

**Positive**

- New features can be exercised against the **real built artifacts as a system**
  before a PR — the gap this addresses.
- Zero new tools or infra: reuses existing Dockerfiles, compose, seed, and smoke
  scripts. No Supabase/Vercel/second stack (respects the CLAUDE.md "DO NOT introduce"
  list).
- Migrations are exercised the same way prod applies them, catching bad migrations
  locally.
- The fast `npm run dev` loop and `npm run db:up` are untouched.

**Negative / trade-offs**

- Full image builds take minutes on a cold cache — acceptable for a pre-PR gate, not for
  line-by-line editing (use `npm run dev` for that).
- `web`'s API URL is build-time baked; changing it means a rebuild (documented).
- Local secrets live in the compose file. They are explicit throwaways and only ever
  point at localhost; **never** reuse them anywhere real.

## Compliance notes

- Validation runs only against the approved **`test`** tenant (policy-safe;
  `assertTestTenant` / `assertSafeTarget` enforced in code).
- No live-client identifiers, no production connection strings, no real secrets appear
  here or in compose — the repo goes public briefly for CI.
