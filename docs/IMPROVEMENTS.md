# RouteFlow — Engineering Improvements

> A prioritized, evidence-grounded improvement backlog produced from a **static, read-only**
> architecture review at commit `d4f85fd2` (branch `master`, 2026-09-02). Companion to
> [`ARCHITECTURE_REVERSE_ENGINEERING.md`](ARCHITECTURE_REVERSE_ENGINEERING.md), which documents
> how the system works today. Every claim below cites `file:line`; runtime behaviour that was not
> executed is labelled **(inferred)**.
>
> This is a **proposal document** — nothing here has been implemented. Items are sequenced by
> risk-reduction per unit of effort so the list can be worked top-down.

## How to read this

Each item carries an **effort** (S / M / L) and **risk-if-ignored** (🔴 high / 🟡 medium / ⚪ low).
Priority tiers:

- **P0** — correctness & data-safety. Do first; these can cost money or lose data.
- **P1** — testing & release safety. The gap between "it builds" and "it's safe to ship".
- **P2** — developer workflow & tooling.
- **P3** — structure & documentation.

Two items were explicitly requested by the product owner and are called out inline:
**#7 Local hosting via Docker** (P1) and **#3 Schema-management tooling** (P0).

## Summary

| #   | Tier | Item                                                         | Effort | Risk | Status         |
| --- | ---- | ------------------------------------------------------------ | ------ | ---- | -------------- |
| 1   | P0   | Consolidate the 4 `pricing.ts` copies into one package       | M      | 🔴   | open           |
| 2   | P0   | Enforce the single-replica invariant (or remove the need)    | M      | 🔴   | open           |
| 3   | P0   | Schema-management tooling: retire boot-time DDL + drift gate | M      | 🔴   | shipped (PR-1) |
| 4   | P1   | Add a staging environment before prod                        | M      | 🔴   | open           |
| 5   | P1   | Add web component/unit tests; rebalance the test pyramid     | L      | 🟡   | open           |
| 6   | P1   | Move E2E before prod; give specs dedicated users             | M      | 🟡   | open           |
| 7   | P1   | **Local full-stack hosting via Docker (pre-PR)**             | M      | 🟡   | shipped (#606) |
| 8   | P2   | Retire the repo public/private flip; run CI private          | S      | 🟡   | open           |
| 9   | P2   | Constrain the `SKIP_VERIFY` bypass; split the CI job         | S      | 🟡   | open           |
| 10  | P3   | Split `schema.prisma`; share DTOs via `@routeflow/types`     | M      | ⚪   | open           |
| 11  | P3   | Rewrite the stale README; slim `CLAUDE.md`; drop dead deps   | S      | 🟡   | open           |

---

## P0 — Correctness & data safety

### 1. Consolidate the four `pricing.ts` copies · M · 🔴

Money math lives in **four** files, two of them inside the API alone:

- [`apps/api/src/common/pricing.ts`](../apps/api/src/common/pricing.ts)
- [`apps/api/src/utils/pricing.ts`](../apps/api/src/utils/pricing.ts)
- [`apps/web/lib/pricing.ts`](../apps/web/lib/pricing.ts)
- [`apps/mobile/lib/pricing.ts`](../apps/mobile/lib/pricing.ts)

They are "kept in sync by hand" and pinned by a regression spec, but hand-sync of pricing logic is
the single most likely path to silently over/under-charging a customer (`CLAUDE.md` already warns
that re-deriving `qty * unitPrice` for a boxed line overcharges by `unitsPerBox`).

**Proposed change.** Extract one `@routeflow/pricing` workspace package (mirrors `@routeflow/types`)
holding `computeLineSubtotal`, `normalizeBoxesPieces`, `roundMoney`, and import it in all three apps.
Delete the copies. Keep `pricing.spec.ts` as the package's own test. The two intra-API copies should
merge immediately regardless of the cross-app work.

**Payoff.** Removes an entire class of money bugs; one source of truth, one test suite.

### 2. Enforce the single-replica invariant — or remove the need for it · M · 🔴

The API **must run exactly one replica** or a cross-replica order-merge race corrupts order line
items (`B199`). Today the only guard is a comment in
[`apps/api/railway.toml`](../apps/api/railway.toml); nothing detects a second replica, and Railway
injects no replica-count env var, so the process can't self-check **(inferred)**.

**Proposed change (pick one):**

- **Remove the constraint (preferred):** replace the in-process lock in `withOrderMergeLock` with a
  **Postgres advisory lock** (`pg_advisory_xact_lock`), which coordinates correctly across replicas.
  The one-replica cap then disappears and the service can scale horizontally.
- **Or make it fail-loud:** assert a replica-count signal at boot and refuse to start if `> 1`, so a
  mis-scale is a crash, not silent money corruption.

**Payoff.** Turns an undocumented footgun into either a non-issue (scalable) or a safe failure.

### 3. Schema-management tooling for PostgreSQL + Prisma · M · 🔴 _(owner-requested)_

**Problem.** Schema changes reach production through **three uncoordinated paths**:

1. Prisma migrations applied manually before merge (`railway run … prisma migrate deploy`).
2. **Boot-time raw DDL** on every startup (formerly `runStartupMigration()` in `main.ts`, an
   acknowledged `F12-002` contradiction of the never-auto-migrate policy) — deleted in PR-1.
3. A migration-replay CI job ([`db-migrations.yml`](../.github/workflows/db-migrations.yml)) that
   proves history applies cleanly, but nothing checks the deployed DB for **drift** against the
   schema, and nothing lints migrations for destructive operations.

The result: the live schema can diverge from `schema.prisma` and no gate catches it.

**Proposed change.** Keep **Prisma Migrate as the single source of truth**, then choose a governance
level:

- **Option A — Prisma-native, zero new dependencies (start here):**
  1. Delete the boot-time `ALTER TABLE`s outright — no flag; schema now reaches the DB only via
     `prisma migrate deploy`. **Shipped in PR-1.**
  2. Add a **drift gate**: `npm run db:drift -w apps/api` → [`apps/api/scripts/schema-drift.mjs`](../apps/api/scripts/schema-drift.mjs), which runs `prisma migrate status` (informational) plus
     `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
--exit-code` (fails when the DB and schema disagree). Wired into
     [`db-migrations.yml`](../.github/workflows/db-migrations.yml) and the post-deploy step in
     [`prod-migrate.mjs`](../apps/api/scripts/prod-migrate.mjs). **Shipped in PR-1.**
  3. Formalize `prisma migrate deploy` as a guarded, logged release step (not a manual one-off).
- **Option B — dedicated schema tool, [Atlas](https://atlasgo.io) (`ariga/atlas`):** has a
  first-class Prisma provider and adds what Prisma Migrate lacks — **declarative** schema management,
  **migration linting** (blocks destructive changes: dropped columns, table rewrites, unsafe index
  builds), and **drift detection** against a live database, all runnable in CI. It is **not** on the
  repo's "DO NOT introduce" list, and it complements rather than replaces Prisma Migrate.

**Recommendation.** Do **Option A now** (it directly retires the boot-time DDL and closes the drift
hole with tools already in the repo). Adopt **Atlas (Option B)** as a team decision once you want
destructive-change linting and continuous drift detection — it is the natural fit for this TS/Prisma
stack (Flyway/Liquibase would drag in a JVM and are not recommended here).

**Payoff.** One coherent schema pipeline; drift and destructive migrations become CI failures instead
of production surprises.

---

## P1 — Testing & release safety

### 4. Add a staging environment · M · 🔴

There is **no staging environment** — nothing in any `railway.toml` defines one, and E2E runs against
**production** off Railway's `deployment_status` signal ([`ci.yml`](../.github/workflows/ci.yml)), so
**production is the canary**.

**Proposed change.** Stand up a `staging` Railway environment (or project) mirroring prod services,
fed by a `staging` branch or manual promotion, seeded only with approved test tenants
(`e2e-*`, `qa-*`, `routeflow-demo` — per the `assertTestTenant` policy in
[`scripts/lib/test-tenants.cjs`](../scripts/lib/test-tenants.cjs)). Point the post-deploy E2E suite at
staging first; promote to prod only on green.

**Payoff.** A real environment to catch integration failures before customers do.

### 5. Add web component/unit tests; rebalance the pyramid · L · 🟡

The API and mobile have deep Jest suites, but **web has only Playwright E2E** (verified: the sole
test dependency in `apps/web/package.json` is `@playwright/test`; scripts are all `test:e2e:*`).
A dashboard this size with zero component/logic tests pushes every regression onto slow, flaky
browser runs. Mobile is "pure-logic only" by policy, leaving its components untested too.

**Proposed change.** Add **Jest + React Testing Library** to `apps/web` (Jest is already the
sanctioned runner — respects the "no Vitest" rule) for components, hooks, and `lib/` logic. Target
the high-value surfaces first: pricing/display, form validation (react-hook-form + zod), and the
axios refresh/interceptor logic in [`apps/web/lib/api-client.ts`](../apps/web/lib/api-client.ts).

**Payoff.** Moves regression-catching down into fast tests; shrinks reliance on end-to-end runs.

### 6. Move E2E before prod; give specs dedicated users · M · 🟡

Two coupling problems in the current E2E flow:

- It runs **after** the prod deploy (see #4), so a failing suite means the bug is already live.
- The F14 incident (#598–#602) traced a flaky failure to **two specs sharing one `admin` operator** —
  one spec's session-cleanup logged the other out. The fix quarantined the specs; the underlying
  lesson (`L-050`) is that a spec mutating shared auth state needs its own user.

**Proposed change.** Once staging exists (#4), gate the merge on staging E2E. Provision a
**dedicated E2E user per spec/project** (not an ordering tweak) so no spec depends on another's
session state. Re-enable the quarantined F14 projects on that basis.

**Payoff.** Deterministic E2E that gates the release instead of reporting on it.

### 7. Local full-stack hosting via Docker (pre-PR) · M · 🟡 _(owner-requested)_

**Problem.** Today the only local surfaces are watch-mode dev servers (`npm run dev`) and
`npm run db:up`, which starts **only Postgres + Redis** (see
[`docker-compose.yml`](../docker-compose.yml)). The `apps/api` and `apps/web` **production Docker images
are never run locally** — they're built only by Railway. So the first time the real containers run
against a real database is **in production**. Combined with the absence of a staging env (#4), there
is no integrated place to smoke-test a change before opening a PR.

**Shipped (#606).** Added an `app` profile to the existing `docker-compose.yml` — no separate
overlay file — that builds and runs the **actual production Dockerfiles** wired to the existing
Postgres/Redis services, a local prod-like surrogate:

- The `--profile app` services in `docker-compose.yml`: a one-shot `migrate` (`prisma migrate
deploy`, mirroring prod), `api` (`build: { context: ., dockerfile: apps/api/Dockerfile }`,
  `:3000`, `depends_on` Postgres+Redis healthcheck-gated), and `web` (`build: { context: .,
dockerfile: apps/web/Dockerfile }`, `:3001`, `NEXT_PUBLIC_API_URL` pointed at the `api` service).
- A seed step against the containerized DB using an **approved test tenant only**
  (`assertSafeTarget`/`assertTestTenant`), never live data.
- Root scripts: `npm run local:up`, `local:seed`, `local:validate`, `local:validate:features`,
  `local:logs`, `local:down`, `local:reset`, `local:migrate`.
- [`docs/adr/0001-local-hosting-environment.md`](../docs/adr/0001-local-hosting-environment.md) as
  the runbook/ADR, plus a note in the PR checklist: run `npm run local:up` and `local:validate`
  and smoke-test the built images before pushing.

This is deliberately **not** `npm run dev` (watch mode): the point is to exercise the same multi-stage
Docker images, standalone Next build, non-root runtime, and startup path that Railway runs — catching
Docker/build/runtime-config breakage that dev mode hides.

**Payoff.** Developers validate the real deployable artifact locally before a PR; it also doubles as
the fastest path toward the staging environment in #4 (same compose, hosted).

---

## P2 — Developer workflow & tooling

### 8. Retire the repo public/private flip; run CI private · S · 🟡

`CLAUDE.md` documents flipping the **private** repo to **public** for each CI run and back — a
workaround for GitHub Actions private-minute billing that (per the runbook) once caused **five
consecutive failed deploys** via a snapshot race, and carries a standing hazard ("never leave the repo
public"). The `ci.yml` header states this was retired 2026-08-30, but `CLAUDE.md` still prescribes it,
so the instructions themselves now conflict.

**Proposed change.** Resolve the billing issue directly — enable paid private Actions minutes or add a
**self-hosted runner** — so CI runs on the private repo permanently. Delete the flip routine from
`CLAUDE.md` and the SDLC docs.

**Payoff.** Removes a manual, error-prone, security-relevant ritual from every release.

### 9. Constrain the `SKIP_VERIFY` bypass; split the CI job · S · 🟡

- The one authoritative quality gate (`npm run verify` in [`.husky/pre-push`](../.husky/pre-push)) has a
  `SKIP_VERIFY=1` bypass. If the whole bar is skippable and silent, it's optional.
- CI is a single serial `verify` job (`check-types` → `lint` → `test`), so a type error and a lint
  error are found one after another, not together.

**Proposed change.** Emit telemetry/an audit line whenever `SKIP_VERIFY` is used (keep the escape
hatch for genuine docs-only pushes, but make it visible). Split the CI `verify` job into parallel
`check-types` / `lint` / `test` lanes for faster, clearer feedback (Turbo already caches locally;
CI stays cache-off by design).

**Payoff.** Faster feedback; the safety bypass stops being invisible.

---

## P3 — Structure & documentation

### 10. Split `schema.prisma`; share DTOs via `@routeflow/types` · M · ⚪

- One **4,438-line** `schema.prisma` with **125 models** (verified). Prisma 7 supports multi-file
  schemas — split into `prisma/schema/*.prisma` by domain (tenancy, sales, inventory, finance,
  compliance) for navigability.
- Contracts are hand-copied: **48** API-client modules in web, **35** in mobile, while
  `@routeflow/types` is imported by only **27** source files across all apps (verified). Push shared
  request/response shapes into `@routeflow/types` (or generate them) instead of duplicating.
- The **React 18 vs 19** split (mobile pulls 19, web needs 18, force-pinned at the image root in
  [`apps/web/Dockerfile`](../apps/web/Dockerfile)) is a hoisting hack worth revisiting.

### 11. Rewrite the stale README; slim `CLAUDE.md`; drop dead deps · S · 🟡

- [`README.md`](../README.md) is **actively misleading**: it documents `main`/`develop` branches
  (trunk is `master`) and a `deploy-staging.yml`/`deploy-production.yml` GHCR→Railway CI/CD table for
  workflows that are **dormant**. Rewrite it to match reality (single `verify` job → Railway
  auto-deploy → `deployment_status`-triggered E2E). It also lists the remote as `najathakram1` while
  the actual origin is `najathakram/routeflow`.
- `CLAUDE.md` has grown into a runbook + incident log + policy doc, corrected in place multiple times
  (the deploy-flip saga). Move operational history to a CHANGELOG/runbook and keep the guide stable.
- **Remove `zustand` from `apps/web`** — it's a dependency with **zero imports** in web source
  (verified); web uses TanStack Query + context.

---

## What's already good (keep it)

A balanced review should say what not to touch:

- **Tenant isolation** is genuinely strong — three independent layers (Prisma `$extends`, a
  transaction Proxy, and Postgres RLS) in
  [`apps/api/src/prisma/prisma.service.ts`](../apps/api/src/prisma/prisma.service.ts).
- **The DB backup pipeline** (`apps/db-backup`) is well-designed: 2-hourly `pg_dump` → Cloudflare R2
  (S3-compatible, zero egress fees), 30-day prune, **monthly restore-verify**, and a healthchecks.io
  dead-man's switch. R2 is object storage, not a backup tool — this is a sound, cheap choice.
- **Redis + Postgres together is correct**, not redundant: Postgres is the durable system of record;
  Redis is ephemeral coordination (Socket.io fanout, rate-limit counters, BullMQ). (The Socket.io
  Redis adapter specifically is unused at one replica — folded into #2.)
- **The code map + lessons register** (`.claude/code-map`, `.claude/lessons`) and the "explain why"
  inline comments are better documentation than most codebases have.
- **`campaign-check.mjs`** mechanically refusing an unproven "done" claim is a strong idea worth
  keeping.

---

_Scope note: this review was static and read-only; nothing was built or executed. Runtime-dependent
claims are marked **(inferred)**. File/line citations are anchored to commit `d4f85fd2`._
