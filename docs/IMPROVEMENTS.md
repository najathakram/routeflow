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

| #   | Tier | Item                                                         | Effort | Risk | Status                                                                        |
| --- | ---- | ------------------------------------------------------------ | ------ | ---- | ----------------------------------------------------------------------------- |
| 1   | P0   | Consolidate the 4 `pricing.ts` copies into one package       | M      | 🔴   | shipped (PR-4)                                                                |
| 2   | P0   | Enforce the single-replica invariant (or remove the need)    | M      | 🔴   | shipped (PR-2 #609 + 2b)                                                      |
| 3   | P0   | Schema-management tooling: retire boot-time DDL + drift gate | M      | 🔴   | shipped (PR-1, #608 + wave B′)                                                |
| 4   | P1   | Add a staging environment before prod                        | M      | 🔴   | deferred — ADR 0002 (wave D)                                                  |
| 5   | P1   | Add web component/unit tests; rebalance the test pyramid     | L      | 🟡   | shipped (wave D)                                                              |
| 6   | P1   | Move E2E before prod; give specs dedicated users             | M      | 🟡   | half (wave D: local lane + dedicated users; staging gate deferred — ADR 0002) |
| 7   | P1   | **Local full-stack hosting via Docker (pre-PR)**             | M      | 🟡   | shipped (#606; gaps closed #608 + wave D)                                     |
| 8   | P2   | Retire the repo public/private flip; run CI private          | S      | 🟡   | docs-only (wave D; retirement blocked on billing)                             |
| 9   | P2   | Constrain the `SKIP_VERIFY` bypass; split the CI job         | S      | 🟡   | shipped (wave B′)                                                             |
| 10  | P3   | Split `schema.prisma`; share DTOs via `@routeflow/types`     | M      | ⚪   | shipped (wave E: 10a + 10b)                                                   |
| 11  | P3   | Rewrite the stale README; slim `CLAUDE.md`; drop dead deps   | S      | 🟡   | shipped (wave D)                                                              |

---

## P0 — Correctness & data safety

### 1. Consolidate the four `pricing.ts` copies · M · 🔴

Money math lived in **four** files, two of them inside the API alone: `apps/api/src/common/pricing.ts`,
`apps/api/src/utils/pricing.ts`, `apps/web/lib/pricing.ts`, `apps/mobile/lib/pricing.ts`. All four
are now deleted; the math they held lives in [`packages/pricing`](../packages/pricing).

They were "kept in sync by hand" and pinned by a regression spec, but hand-sync of pricing logic
was the single most likely path to silently over/under-charging a customer (`CLAUDE.md` already
warned that re-deriving `qty * unitPrice` for a boxed line overcharges by `unitsPerBox`).

**Shipped in PR-4.** One compiled workspace package, `packages/pricing` (`@routeflow/pricing`),
holds `computeLineSubtotal`, `normalizeBoxesPieces`, `roundMoney`, and the rest of the money math;
api, web and mobile all import it, and the four legacy files above are gone. It ships **compiled
CJS** under `dist/`, built by the root `postinstall` — not a source-direct package "exactly like
`@routeflow/types`" as first proposed here: `nest build` emits `require()` verbatim, so
`node dist/main.js` cannot load a `.ts` file, and a workspace package the API imports at runtime
must therefore ship built JS (L-065). `scripts/codemods/pricing-import-rewrite.mjs` rewrote all 147
importers across the three apps onto `@routeflow/pricing`; `scripts/codemods/pricing-body-diff.mjs`
proved every moved function byte-identical to its pre-move source before the four copies were
deleted. The package's own golden money table (`packages/pricing/src/golden.fixtures.ts` +
`golden.spec.ts`) replaces the four hand-synced regression specs with one.

**Follow-on.** The consolidation **widened** `getTierPrice`'s `product` parameter to `any` in
[`packages/pricing/src/tier-pricing.ts`](../packages/pricing/src/tier-pricing.ts) (the api's
original, looser signature won out) — web and mobile lost the compile-time `TierPriceable`-shape
check their own mirrors gave the same call sites. Give it a real parameter type again in a
follow-on.

**Payoff.** Removed an entire class of money bugs; one source of truth, one test suite.

### 2. Enforce the single-replica invariant — or remove the need for it · M · 🔴

**Shipped (PR-2 #609 + 2b).** Order merges now serialise per customer on a **Postgres advisory lock**, held on a dedicated
connection rather than in-process (`apps/api/src/common/db-locks.ts`, `withAdvisoryLock`) —
`pg_advisory_lock(hashtext('order-merge'), hashtext(customerId))` in `wait` mode, `SET lock_timeout`
bounding the wait, on its own small `pg.Pool` kept separate from Prisma's pool. Because the lock lives
on a Postgres session rather than in a process's memory, it coordinates correctly across replicas —
the cross-replica order-merge race (`B199`) that motivated the one-replica cap is closed, and the
comment in [`apps/api/railway.toml`](../apps/api/railway.toml) records that.

**2b — cron leader lock.** All 13 `@Cron` jobs are now `@LeaderCron(expr, "<area>.<method>")`
([`apps/api/src/common/cron-lock.ts`](../apps/api/src/common/cron-lock.ts)): the decorator wraps the
tick in `withAdvisoryLock({family:"cron", key:name, mode:"try"})` and then applies `@Cron` with that
stable name, so a tick runs only on the instance that wins the lock. `no-bare-cron.spec.ts` keeps a
new bare `@Cron(` from being added; `cron-lock.db.spec.ts` proves on real Postgres that two
concurrent ticks run the body once. The single-replica guard comment in `railway.toml` is retired —
`numReplicas` may be raised. Residual: `OrdersService.onApplicationBootstrap`'s pending-order sweep is
a startup call, not a tick, and stays un-elected — safe on two replicas because it merges through
`mergeAllPendingForCustomer`, which takes PR-2's customer-keyed lock. `EntitlementsService`'s 30 s
cache is per-process staleness only. `@Cron` was the whole recurring surface: there are no
`@Interval`/`@Timeout` decorators, no `setInterval`, and no Bull repeatable jobs.

**What a skipped tick costs (not uniform).** Eleven of the thirteen jobs re-derive their work from
state, so a lost tick self-repairs on the next one (`rollCycles` re-selects any passed `periodEnd`,
commission reconciliation looks back 25 h on an hourly cadence, recurring invoices keep `nextRunAt`
in the past until they generate, and the rest are due-date sweeps). **Two do not:**
`tobacco-report.generateMonthlyReports` generates only `now − 1 month` and
`order-templates.generateDailyOrders` only today's weekday — a lost tick there is a missed month /
missed day that needs a manual re-run. **Follow-on:** give those two a catch-up window (every
unreported period / un-generated day since the last run) instead of a single-period query.
Residual, deliberately unfixed: a body that never settles pins the lock and every replica skips
that job until the process ends — a hold cap is rejected because releasing the lock cannot cancel
the running body, which would license two concurrent money ticks; the remedy is the job's own
timeouts plus the pool keepalive below.

**Pool sizing, settled in 2b:** a cron winner pins a lock slot for its whole tick, and peak
concurrent cron holders is 5 hourly / 7 at 02:00 UTC on the 1st — out of ONE shared `max: 8` pool
that left order merges 3 (resp. 1) slots, and a merge finding none waited `connectionTimeoutMillis`
and 503d on a key nobody held. `db-locks.ts` now keeps **one pool per family** (`LOCK_FAMILIES =
["order-merge","cron"]`), each sized for its own peak: **`cron` `max: 12`** — the 7-holder monthly
peak plus a straggling hourly sweep that has not finished when the next hour's five fire, because a
cron holder that finds no slot skips its tick outright — and **`order-merge` `max: 8`**, unchanged,
since its checkouts are short and its real bound is the callers' wait budgets. Worst case 20 lock
connections + Prisma's 10 = 30, far below `max_connections`. The family list is closed and checked
before any connect (`TypeError` otherwise), so a typo cannot silently stand up a third pool.

**Keepalive on both lock pools (`keepAlive: true`, `keepAliveInitialDelayMillis: 30_000`).** An
advisory lock lives with the _session_, and a cron leader's lock connection is socket-idle for the
whole tick (the tick's work runs on the Prisma pool). An idle-reap anywhere on the path would drop
that session, Postgres would release the lock mid-tick, and the next replica's election would win a
job already in flight — the duplicate money run `@LeaderCron` exists to prevent. TCP probes every
30 s keep the session provably alive; the lock is released only when the session really ends.

Four call sites take the lock, keyed by `customerId`: staff order `create()` (auto-merge into an
existing pending order), buyer `createOrder`, `mergeAllPendingForCustomer`, and
`forceConsolidateCustomer`. In every case the lock is acquired **before any write** — a contended
lock therefore always fails a request cleanly, never mid-write — and is reported to the client as
HTTP 409 `{ code: "MERGE_IN_PROGRESS" }` (another merge for this customer is already running) or 503
`{ code: "LOCK_UNAVAILABLE" }` (the dedicated lock connection couldn't be obtained), both safe to
retry. A merge's own post-commit consolidation step, if it can't acquire the lock, is deferred with a
warning log rather than blocking the request that triggered it. The old in-process guard
(`withOrderMergeLock`, a `Map` keyed by order id) is deleted — it never protected against a second
replica in the first place.

The one-shot backfill script ([`apps/api/scripts/merge-pending-orders.js`](../apps/api/scripts/merge-pending-orders.js))
takes the same lock, transaction-scoped: each customer's merge transaction opens with
`pg_advisory_xact_lock(hashtext('order-merge'), hashtext(customerId))`, the same key pair as the
API's session-level lock, so a manual backfill run and a live API instance serialise against each
other instead of racing.

**Remaining work.** A **cron leader lock** (guarding scheduled jobs that must run on exactly one
replica, distinct from the per-customer order-merge lock above) is tracked separately as its own PR
and is not part of this item.

**Also outstanding (close-out review, 2026-09-05).** The item-edit path (`PATCH /orders/:id/items`
and the buyer twin) still writes absolute line sets **outside** the customer advisory lock above —
a concurrent merge can overwrite a concurrent edit (scenario: qty 10, edit → 12, merge folds
10 + 5 = 15, correct is 17). Fix: take the same customer lock at those two controller entries;
never thread a transaction into `updateOrderItems`.

**Payoff.** Turns an undocumented footgun into a non-issue: the service can now scale to multiple
replicas without risking order-merge corruption.

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
- **Option B — destructive-migration linting, [Squawk](https://squawkhq.com) (`squawk-cli`),
  shipped in wave B′:** Atlas's `migrate lint` went **Pro-only since v0.38** and its `--dir-format`
  never supported Prisma's migrations layout, so it cannot do this job. Squawk lints every
  `migration.sql` for destructive operations (`ban-drop-table`/`-column`, `adding-required-field`,
  `renaming-column`/`-table`, …) for free, wired into `db-migrations.yml` via
  `npm run lint:migrations` (`scripts/lint-migrations.mjs`), with a reason-gated
  `-- squawk-ignore <rule>` whitelist.

**Recommendation.** Option A is done; Option B (Squawk) is done. Both now run in CI on every
migration.

**Payoff.** One coherent schema pipeline; drift and destructive migrations become CI failures instead
of production surprises.

---

## P1 — Testing & release safety

### 4. Add a staging environment · M · 🔴

There is **no staging environment** — nothing in any `railway.toml` defines one, and E2E runs against
**production** off Railway's `deployment_status` signal ([`ci.yml`](../.github/workflows/ci.yml)), so
**production is the canary**.

**Deferred (wave D) — design of record only.** [`docs/adr/0002-staging-environment.md`](adr/0002-staging-environment.md)
records the full shape (topology, deploy mechanism, seeding, the E2E-gates-on-staging decision) so
the design doesn't have to be rediscovered when cost/priority allows building it — nothing below
is implemented yet.

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

**Shipped (wave D).** Added **Jest + React Testing Library** to `apps/web` — `jest.config.js` (built
on `next/jest`), `jest.setup.ts`, and `test-utils/render.tsx` (`renderWithProviders`, real
QueryClient/Toast/I18n/Auth context providers). 19 spec files: 4 `lib/` suites (`api-client`,
`format`, `formatting`, `tenant-host`) and 15 component specs covering auth pages (login,
forgot-password, buyer portal), settings, and the highest-traffic modals/cards (order/route/driver
create, bookkeeping detail, sales-history, money input). Runs via `npm test -w apps/web` and now
contributes to `npm run test` (Turbo). Detail: [`web`](../.claude/code-map/web.md) "Unit tests
(Jest + RTL)".

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

**Half-shipped (wave D).** The dedicated-user half landed — `e2e-seed.js` seeds
`e2e_sessions_op`/`e2e_impersonated_admin` (L-050) and both quarantined F14 projects are
re-enabled — plus a new pre-PR local lane (`apps/web/e2e/LOCAL-LANE.md`) that runs Playwright
against the local Docker stack. The "gate the merge on staging E2E" half stays deferred pending
hosted staging, with the residual risk this leaves — E2E still reports on production rather than
gating it — recorded in [ADR 0002](adr/0002-staging-environment.md).

**Payoff.** Deterministic E2E that gates the release instead of reporting on it.

### 7. Local full-stack hosting via Docker (pre-PR) · M · 🟡 _(owner-requested)_

**Problem.** Today the only local surfaces are watch-mode dev servers (`npm run dev`) and
`npm run db:up`, which starts **only Postgres + Redis** (see
[`docker-compose.yml`](../docker-compose.yml)). The `apps/api` and `apps/web` **production Docker images
are never run locally** — they're built only by Railway. So the first time the real containers run
against a real database is **in production**. Combined with the absence of a staging env (#4), there
is no integrated place to smoke-test a change before opening a PR.

**Shipped (#606; gaps closed #608 + wave D).** Added an `app` profile to the existing `docker-compose.yml` — no separate
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

**Gaps closed (#608 + wave D):** [ADR 0002](adr/0002-staging-environment.md) resolves the two
supporting questions #606 left open — the `RUN_STARTUP_DDL`-style flag question is moot (boot-time
DDL was deleted outright, PR-1/`imp-03a`, so there is no flag to gate a staging boot with), and the
PR-template checklist line ("run `npm run local:up`/`local:validate` before pushing") landed in
[`.github/PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md).

This is deliberately **not** `npm run dev` (watch mode): the point is to exercise the same multi-stage
Docker images, standalone Next build, non-root runtime, and startup path that Railway runs — catching
Docker/build/runtime-config breakage that dev mode hides.

**Payoff.** Developers validate the real deployable artifact locally before a PR; it also doubles as
the fastest path toward the staging environment in #4 (same compose, hosted).

---

## P2 — Developer workflow & tooling

### 8. Retire the repo public/private flip; run CI private · S · 🟡

`CLAUDE.md` documented flipping the **private** repo to **public** for each CI run and back inline —
a workaround for GitHub Actions private-minute billing that (per the runbook) once caused **five
consecutive failed deploys** via a snapshot race, and carries a standing hazard ("never leave the repo
public").

**Docs-only (wave D) — retirement itself is still blocked on billing.** The flip's failure modes,
routine, and retirement conditions were extracted out of `CLAUDE.md` into a single source of truth,
[`docs/runbooks/deploy-visibility-flip.md`](runbooks/deploy-visibility-flip.md); `CLAUDE.md`, the
`rebuild` skill, and `ci.yml`'s header now all point there instead of restating it, closing the
conflicting-instructions problem this item originally described. The runbook's own "Retirement
checklist" section is unchanged and still gated on: (1) private-minute Actions billing fixed in
GitHub Settings → Billing, (2) one full private PR run completing with `steps > 0` on every job,
(3) a real month's private minutes checked against the 2,000/mo Free cap. **Nothing here does that
billing fix** — the flip routine itself keeps running until an owner acts on it.

**Proposed change (unshipped).** Resolve the billing issue directly — enable paid private Actions minutes or add a
**self-hosted runner** — so CI runs on the private repo permanently, then apply the runbook's
retirement checklist.

**Payoff.** Removes a manual, error-prone, security-relevant ritual from every release.

### 9. Constrain the `SKIP_VERIFY` bypass; split the CI job · S · 🟡

- The one authoritative quality gate (`npm run verify` in [`.husky/pre-push`](../.husky/pre-push)) has a
  `SKIP_VERIFY=1` bypass. If the whole bar is skippable and silent, it's optional.
- CI is a single serial `verify` job (`check-types` → `lint` → `test`), so a type error and a lint
  error are found one after another, not together.

**Shipped (wave B′).** Ruling: keep the one-job `verify` (splitting contradicts `ci.yml:1-63`'s
measured one-job decision while private minutes stay constrained — see #8) but stop the escape
hatch from being silent. `.husky/pre-push` now requires `SKIP_VERIFY_REASON="<why>"` for any push
that touches code (`apps/`, `packages/`, `scripts/`, `.github/`) via `scripts/skip-verify-audit.mjs`,
which appends an audit line to `.git/skip-verify.log`; docs-only pushes need no reason. The root
`verify` script (and the CI "Verify" step, byte-identical) gained `--continue=dependencies-successful`
so a failing type-check no longer hides a failing lint/test in the same run.

**Payoff.** Faster feedback; the safety bypass stops being invisible.

> **P4 note (wave B′, shipped).** Alongside #9's audit trail: the global `APP_GUARD` order
> (`ThrottlerGuard`, `TenantStatusGuard`, `ImpersonationGuard`, no `JwtAuthGuard`) is now pinned by
> a static spec and a load-bearing comment in `app.module.ts`; cross-tenant `findUniqueOrThrow`
> (throws Prisma's own `P2025`) fail-closed behavior is pinned by the DB-backed
> [`tenant-findunique.db.spec.ts`](../apps/api/src/prisma/tenant-findunique.db.spec.ts), and
> cross-tenant `findUnique` (returns `null`) plus the RLS session-variable hand-off by its sibling
> [`tenant-findunique-pins.db.spec.ts`](../apps/api/src/prisma/tenant-findunique-pins.db.spec.ts) —
> both across `forTenant()` and `tenantTransaction()` for `Customer`/`Product`/`Order`/`Invoice` in
> the compose-DB lane. That pin came out **red** for
> `findUniqueOrThrow`, which was scoped by neither tenancy layer — it fell through to the raw
> client and resolved the other tenant's row — so P4 escalated from `test:` to a fix:
> `prisma.service.ts` now post-filters `findUniqueOrThrow` in both `_wrapTxWithTenant` and
> `_tenantExtension`, throwing `P2025` for a foreign-tenant row ([[L-060]]).
> `apps/api/src/app.service.ts`'s health check now returns
> `commit`/`branch` from `RAILWAY_GIT_COMMIT_SHA`/`RAILWAY_GIT_BRANCH` (mirroring the web health
> route), and `ci.yml`'s readiness gate checks the API's deployed sha with the same tolerance
> shape as the existing web check.
>
> **Follow-on.** `ALLOW_NULL_API_SHA` in `ci.yml` is transitional — flip it to `"false"` after
> the first post-merge deploy proves the API reports `commit`; tracked as a program follow-on.
> Follow-on (tenancy): scope the tx-proxy `upsert` `where` — requires a null guard
> (`tenantNotFound`) + a backfill migration
> `UPDATE "PaymentCounter" SET "tenantId" = "id" WHERE "tenantId" IS NULL AND "id" IN (SELECT "id" FROM "Tenant")`,
> preceded by a read-only prod count of such rows; the `forTenant()` layer already scopes it.
>
> **Follow-on (pg concurrent-query deprecation).** Observed in prod 2026-09-05, shortly after
> #623: node-postgres logs a deprecation for a second query issued on a client that already has
> one in flight. Diagnosed as **not** `db-locks.ts` — that module `await`s each of its three
> statements in turn (`SET lock_timeout` at ~240, the lock call at ~248, the unlock at ~282), so
> it never overlaps and needs no change. The real shape is `Promise.all` on a **pinned Prisma
> interactive-transaction client**, where both branches share one connection:
> [`sales-agents/commission-engine.service.ts`](../apps/api/src/sales-agents/commission-engine.service.ts)
> ~222 (`runSync`'s `db` is a `tx` at every caller — `syncInvoiceCommissionSafe(id, tx)`),
> [`common/msrp.ts`](../apps/api/src/common/msrp.ts) ~68 (`loadMsrpMap` is called with `tx` from
> `estimates.service.ts` ~240 and with the tx-or-pool `db` from `invoices.service.ts` ~118),
> [`drivers/drivers.service.ts`](../apps/api/src/drivers/drivers.service.ts) ~148 and
> [`customers/customers.service.ts`](../apps/api/src/customers/customers.service.ts) ~1727 (both
> plainly inside a `tenantTransaction`). Also audit — same `Promise.all` pair shape, but on a
> pool-backed `forTenant()` client today, so each branch checks out its own connection:
> `routes/routes.service.ts` ~1562 (pinned only when a caller threads `client`),
> `buyer/statement.service.ts` ~57, `buyer/buyer.controller.ts` ~300, and
> `messaging/messaging-config.service.ts` ~135/~141. A third statement can queue behind such a
> pair without any code asking for it: Prisma's 5 s interactive-transaction timeout fires its own
> `ROLLBACK` on the same pinned connection. **No correctness risk today** — `pg` 8 queues per
> connection and runs them FIFO, so the pair still executes, in order, and only logs. It becomes
> a hard failure on `pg@9`, which throws instead of queueing. Fix: serialize each pair into
> sequential `await`s (the parallelism is illusory on a pinned client anyway — one connection,
> one statement at a time) and pin it with a fake-tx spec whose mock records overlap, i.e. fails
> if a second call starts before the first resolves.

---

## P3 — Structure & documentation

### 10. Split `schema.prisma`; share DTOs via `@routeflow/types` · M · ⚪

> **SHIPPED — both halves (Wave E, `fix/imp-wave-e-structure`): 10b 2026-09-03, 10a 2026-09-04.**

- One **4,438-line** `schema.prisma` with **125 models** (verified). Prisma 7 supports multi-file
  schemas. **10a shipped:** it is now `apps/api/prisma/schema/{_base,tenancy,catalog,sales,finance,platform,compliance}.prisma`
  — 207 top-level blocks (125 models, 80 enums, datasource+generator). The split is performed and
  re-verified by a committed script, `apps/api/scripts/split-prisma-schema.mjs`, driven by an
  explicit `MODEL_DOMAIN` map (an unmapped model is a hard error — no misc bucket). `--check`
  **always** enforces the structural invariants with no original needed (file set, `_base`
  holds only datasource+generator, every other file ≥1 model, unique names, every model where the
  map says, every enum in a domain file that itself holds a referencing model) — the last is
  membership rather than strict "first referencing model": that literal ordering isn't
  reconstructable from the folder alone, since domains interleave in the pre-split file in ways a
  split doesn't preserve. Only with an explicit `--from <path>` or `--from-ref <git-ref>` does
  `--check` additionally re-derive the concatenation and prove the folder **block-identical** to
  that original — the retired single file is never read implicitly. The one-time lossless proof
  was recorded at split time against `e39bf9db` (207 blocks) and is re-derivable on demand
  (`--check --from-ref e39bf9db`); the standing lossless guard going forward is the drift gate, not
  a repeated diff against a file that no longer exists in the tree. `prisma.config.ts` now points
  `schema` at the folder with an explicit `migrations.path`; `Dockerfile`, `schema-drift.mjs`
  (`--to-schema prisma/schema`), `scan-signatures.mjs` (which now FAILS LOUDLY on a missing schema
  instead of silently scanning nothing) and the `db-migrations.yml` `paths:` filter were updated
  with it. Lossless proof: `prisma validate` clean, `prisma format` a no-op, the PR-1 drift gate
  reports NO DRIFT against the compose DB (23 migrations, up to date) and **no migration was
  generated**.
- Contracts are hand-copied: **48** API-client modules in web, **35** in mobile, while
  `@routeflow/types` is imported by only **27** source files across all apps (verified). **10b
  shipped:** the DTO-duplication sweep found 134 cross-app duplicate names (49 identical, 46
  near-identical, 39 divergent); the 84 DTO names (plus 40 enum mirrors in `enums.ts`) now live in
  `packages/types/api/{orders,customers,products,finance,returns,regulated,routes,buyer,misc}.ts`,
  imported by both apps via `scripts/codemods/shared-dto-rewrite.mjs`. Every Prisma enum a client
  mirrors (40 found) now derives from one const-array union per enum in
  `packages/types/api/enums.ts`, pinned set-equal to `@prisma/client` by
  `apps/api/src/common/enum-parity.spec.ts` — this caught and fixed **four real drifts**: mobile
  `VendorBillStatus` had an invented `"FULL"` value and both apps omitted `OVERDUE`; mobile
  `POStatus` used `"PARTIALLY_RECEIVED"` where the schema says `PARTIAL` (a real functional bug —
  it silently hid the mobile "Receive" action on any partially-received PO); mobile
  `BuyerPromotion.type` omitted `"BUY_N_GET_M"` (masked by a compensating cast, now removed); both
  apps' `EstimateStatus` carried a phantom `"EXPIRED"` value the schema has never had (dead code,
  sibling-sweep find). See lesson L-072.
  **Follow-on:** ~43 site-level declarations (not ~25) still hand-mirror a Prisma enum without a
  parity row — e.g. web `OrderStatus` omits `PARTIALLY_DELIVERED`; `apps/web/lib/api/numbering.ts`'s
  `DocumentNumberType` and `products.ts`'s `CostingMethod` also hand-type a local union outside the
  shared table (harmless today — both still match the schema). Not counted in that ~43: mobile
  `recurring-invoices-logic.ts`'s `LastRunStatus` — `lastRunStatus` is `String?` in Prisma, not an
  enum, so there is no schema enum for it to drift from. Tracked as the next structure item.
- The **React 18 vs 19** split (mobile pulls 19, web needs 18, force-pinned at the image root in
  [`apps/web/Dockerfile`](../apps/web/Dockerfile)) is a hoisting hack worth revisiting. **Kept as
  is for 10b** — revisit with a Next 15 upgrade, not before.

### 11. Rewrite the stale README; slim `CLAUDE.md`; drop dead deps · S · 🟡

**Shipped (wave D).**

- [`README.md`](../README.md) had been **actively misleading**: it documented `main`/`develop`
  branches (trunk is `master`) and a `deploy-staging.yml`/`deploy-production.yml` GHCR→Railway
  CI/CD table for workflows that were **dormant**, and listed the remote as `najathakram1` instead
  of the actual origin `najathakram/routeflow`. Rewritten to match reality (single `verify` job →
  Railway auto-deploy → `deployment_status`-triggered E2E); `deploy-staging.yml` itself was deleted
  outright (ADR 0002 records the staging design it was standing in for).
- `CLAUDE.md` slimmed — the deploy-flip saga's incident-log prose (the five-consecutive-failures
  postmortem, the `BUILDING`-vs-`INITIALIZING` corrections) moved out to
  [`docs/runbooks/deploy-visibility-flip.md`](runbooks/deploy-visibility-flip.md) (item #8), leaving
  the numbered routine plus a pointer.
- **Removed `zustand` from `apps/web`** — it was a dependency with **zero imports** in web source
  (verified); web state is TanStack Query + context. Swept `apps/api` for the same class at the same
  time: `@nestjs/axios` and `passport-google-oauth20`/`@types/passport-google-oauth20` were also
  zero-reference (outbound HTTP goes through vendor SDKs; Google OAuth is
  `google-auth-library`'s `OAuth2Client`, not a Passport strategy) and removed too. Both manifest
  removal and zero-remaining-import are pinned by
  [`apps/api/src/common/no-dead-deps.spec.ts`](../apps/api/src/common/no-dead-deps.spec.ts); the
  README/CLAUDE.md stale-claim fixes above are pinned by
  [`apps/api/src/common/docs-truth.spec.ts`](../apps/api/src/common/docs-truth.spec.ts). Mobile's own
  `zustand` (a real, used dependency) and its `react-test-renderer` pin were left untouched — proven
  by a regression guard in the same spec file.

---

## What's already good (keep it)

A balanced review should say what not to touch:

- **Tenant isolation** is genuinely strong — three independent layers (Prisma `$extends`, a
  transaction Proxy, and Postgres RLS) in
  [`apps/api/src/prisma/prisma.service.ts`](../apps/api/src/prisma/prisma.service.ts). Two caveats
  from the close-out review (2026-09-05, neither exploitable today): the tenancy post-filter is
  blind to a `select` that omits `tenantId` — both layers gate on `!== undefined`, so a projection
  that drops the column reads as "no tenant to check" rather than "unknown tenant"; fix is to
  assert the projection kept `tenantId`. Separately, 81 of 125 models declare `tenantId String?`
  with no backfill migration, and `findUniqueOrThrow`'s fail-closed check treats a NULL `tenantId`
  as foreign (5 call sites: `estimates.service.ts` ~205, `routes.service.ts` ~2405/~2679,
  `orders.service.ts` ~3925, and `billing/plan-catalog.service.ts` ~243 — that fifth one is
  inert, because `PlanVersion` is global reference data with no `tenantId` column at all, so the
  guard short-circuits before it can compare anything). **Prod counts, 2026-09-05: `RouteRunStop` 5, `PaymentCounter` 1,
  `CreditNote` 1.** #613 is **not** the cause of those rows 404ing: both `routeRunStop` call sites
  are preceded by a tenant-scoped `findFirst` that already 404s a NULL-tenant row, `PaymentCounter`
  has no read path at all, and the `CreditNote` row was already invisible to every tenant-scoped
  read. So the guard stays fail-closed and the rows are treated as the defect — repaired as DATA by
  [`apps/api/scripts/backfill-legacy-tenant-ids.mjs`](../apps/api/scripts/backfill-legacy-tenant-ids.mjs)
  (read-only report → `--dry-run` → `--live`, which needs both `--backup-attested` and a typed
  confirmation), owner-run after a fresh backup. It is a data repair, never a migration.
  **What the first read-only prod report actually returned (2026-09-05):** all seven rows were
  REFUSED, and for three different reasons.
  1. The five `RouteRunStop`s were refused because their parent `RouteRun` rows are THEMSELVES
     NULL-tenant (two runs, one carrying 1 stop and one carrying 4) — each stop's `RouteStop` and
     the run's `Route` already agree on one tenant, so only the run in the middle was missing. The
     tool therefore learned ONE cascade level: a NULL-tenant `RouteRun` whose `Route` names a
     tenant and whose stops' `RouteStop`s all agree is repaired FIRST, and its stops are then
     derived from that tenant, both inside the same single transaction (`RouteRun` updates before
     `RouteRunStop` updates). Nothing else was relaxed — a stop under a refused run stays refused.
  2. The `PaymentCounter` row is the literal `singleton` id, the pre-multi-tenant global counter.
     It is left alone **by design**: giving it a tenant would hand that tenant a counter whose
     `next` was advanced by every other tenant's payments.
  3. The `CreditNote` is a duplicate-numbered orphan — writing its Customer-derived tenant would
     violate `@@unique([tenantId, creditNoteNumber])`. Renumbering is a business decision, so it
     stays refused pending a human ruling.

  **Full picture (prod, 2026-09-05, read-only):** 112 tables carry a `tenantId` column; 16 hold
  NULL rows (12,357 rows total), in two classes. Structural, by design, no user impact:
  `RefreshToken` 1952/1952 (auth uses the raw client; the writer sets no `tenantId`),
  `VendorBillItem` 2043/2043 and `PurchaseOrderItem` 3/3 (nested-create children read only via
  `include`), `PaymentCounter` 1/6 (no read path), `AuditLog` 8275/25370 (platform-scoped),
  `ExpenseCategory` 60/566 (global defaults, list uses an explicit `OR tenantId/null`), `User`
  6/556 (3 super-admins by design + 3 April-2026 tenant-admin leftovers that would 401 at login).
  Scattered April-2026 legacy orphans, hidden by tenant-scoped reads (pre-existing, not caused by
  #613): `Expense` 1, `CreditNote` 1, `Return` 1 (+`ReturnItem` 1), `RecurringInvoice` 1 (+item
  1), `RouteRun` 2, `RouteRunStop` 5, `StockLot` 4 (skipped in FIFO/LIFO costing → COGS falls back
  to average; all 4 derivable from `Product.tenantId` — candidate next rule for the tool). A code
  trace confirmed #613's fail-closed `findUniqueOrThrow` changes behaviour for none of the 16 (its
  only site among them, `routes.service` `completeStop`/`completeWithPayment`, is pre-gated by
  scoped 404s). The structural class is a tenancy-model decision (owner-scoped project), not a
  backfill.

- **The DB backup pipeline** (`apps/db-backup`) is well-designed: 2-hourly `pg_dump` → Cloudflare R2
  (S3-compatible, zero egress fees), 30-day prune, **monthly restore-verify**, and a healthchecks.io
  dead-man's switch. R2 is object storage, not a backup tool — this is a sound, cheap choice.
- **Redis + Postgres together is correct**, not redundant: Postgres is the durable system of record;
  Redis is ephemeral coordination (Socket.io fanout, rate-limit counters, BullMQ). (The Socket.io
  Redis adapter specifically is wired (`main.ts:98`) and idle at one replica — folded into #2.)
- **The code map + lessons register** (`.claude/code-map`, `.claude/lessons`) and the "explain why"
  inline comments are better documentation than most codebases have.
- **`campaign-check.mjs`** mechanically refusing an unproven "done" claim is a strong idea worth
  keeping.

---

_Scope note: this review was static and read-only; nothing was built or executed. Runtime-dependent
claims are marked **(inferred)**. File/line citations are anchored to commit `d4f85fd2`._
