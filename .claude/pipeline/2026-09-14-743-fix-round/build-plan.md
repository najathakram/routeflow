# Build plan: PR #743 fix round (round 3, owner-escalated)

> **Stage S5 — "how".** Transcribed by Sonnet from Fable 5.1's design on 2026-09-14.
> Status: `DRAFT` — prep only, NOT launched. Launch is gated on (a) the owner's explicit
> go in their own chat and (b) routeflow-c4 replying "launch" once HOST is free.
> Inputs: `local-assets/handoff/2026-09-14/LAUNCH-743-fix-round.md` (the brief),
> `local-assets/handoff/2026-09-14/743-delta-rereview-verdict.md` (F1-F7, round 2 BLOCK),
> `local-assets/handoff/2026-09-14/reviews/743-opus-verify.md` (adversarial verification),
> `local-assets/handoff/2026-09-14/reviews/743-fable-review-and-fix-design.md` (N1-N9 + the
> rulings on F1-F7 + the T1-T8 design this file transcribes). This file stands alone for the
> engine; it does not re-derive the findings, it cites and builds from them.

**Ground rule.** Findings, not `R#`s, drive this round: each task's `satisfies` cites the
finding ids (F#/N#) it closes; `provenBy` cites the `REG-743-*` red test(s) named in the design.

---

## Objective

Close PR #743's (`feat/phase0-t9-t11`) third-round BLOCK: two new HIGH findings (N1 a second,
undeleted MRR estimator on the tenant-detail card; N2 a DB-lane spec that can spawn `--apply`
against production through inherited Railway env vars) plus 3 MEDIUM / 4 LOW, on top of the
still-open F1-F7 from round 2. Every task's red test (`REG-743-*`) must fail on the current head
for the reason its finding states, then pass after the fix — bug-pipeline discipline per task.

**In scope:** T1-T8 exactly as designed in `reviews/743-fable-review-and-fix-design.md` §4.
**Explicitly out of scope:** `admin/billing/page.tsx` structural changes beyond what T6's scoping
requires call-site-side; re-opening F6 (14-day trial stays, per the ruling); re-litigating F2's
policy (no catalog fallback — visibility counts instead, T7).

---

## Constraints & conventions

- **Stack:** NestJS 11 + Prisma 7 (`apps/api`), Next.js 14 App Router (`apps/web`).
- **Test runner/layout:** Jest. `*.spec.ts` next to the source. `*.db.spec.ts` runs under
  `jest.db.config.js` (`rootDir: "src"`) — the DB lane, `npm run test:db -w apps/api`. Web:
  `*.test.tsx` (Jest+RTL), `npm test -w apps/web`.
- **Money/tenancy hard lines (LAUNCH-743-fix-round.md):** `roundMoney` (`@routeflow/pricing`)
  only, never re-derive `qty * unitPrice`; **no catalog fallback in `MrrService`** (F2 ruling —
  $0 is correct for an unpriced free pilot; visibility counts replace it, T7); **never overwrite
  a non-null `planVersionId`** (F3); reconciliation script scope = `class: PRODUCTION`,
  `status: ACTIVE`, **`stripeSubId` not null** (F4/F5) — **never drop the `stripeSubId` filter**
  (standing B327 rule).
- **Existing patterns to copy:** `apps/api/scripts/lib/railway-db-url.mjs` (`resolveDatabaseUrl`,
  `scrubSecrets`) — already used by both backfill scripts (kept from the prior commit
  `af1b700b`); `backfill-tenant-class.mjs`'s `classify()` table — T4's `classifyTenantSlug` is a
  from-scratch TS port of the exact same table, not a re-derivation.
- **Must NOT change:** the F4/F5 guard never drops the `stripeSubId`/`class`/`status` filters;
  no new pilot flag or discount heuristic (`Tenant.billingExempt` is a later Phase 0 card).
- **Do-not-introduce:** Vitest, Biome, a second HTTP client, a root-level test runner (repo
  `CLAUDE.md`).
- **Landmines:** L-072 (never hand-declare a client mirror of a server enum — T1/T4 route
  through `@routeflow/types`, never a second const); L-113 (a new Prisma call site needs a
  where-shape proof — T2/T6's scoping `where` clauses need this); L-119 (both halves of one
  money figure derive from ONE collection — exactly N1's bug: `getTenant()`'s card and
  `computeOverview()`'s dashboard must become the SAME function, T5).

---

## Work packages

Rules: file lists disjoint unless `dependsOn` says otherwise (see Package map — three real
file-ownership overlaps exist and are sequenced, not faked as parallel). Mechanical work is
`effort: low` by omission of `risk`; T2/T5/T7 are money-domain judgment calls — `risk: HIGH`
(explicit, wins over Baseline's own classifier).

### T1 — Shared plan/class consts + admin form (F1, N6)

- **files:** `packages/types/api/enums.ts`, `apps/api/src/billing/plan-catalog.constants.ts`,
  `apps/web/app/(platform-admin)/admin/tenants/new/page.tsx`,
  `apps/api/src/platform-admin/dto/create-tenant.dto.ts`
- **tests:** `apps/web/app/(platform-admin)/admin/tenants/new/page.test.tsx`,
  `apps/api/src/common/enum-parity.spec.ts`
- **satisfies:** F1, N6 · **provenBy:** REG-743-F1, REG-743-N6
- **dependsOn:** none
- **brief:** Add `PLAN_KEYS`/`PlanKey` and `TENANT_CLASS_VALUES`/`TenantClass` to
  `packages/types/api/enums.ts`, pinned set-equal: `TenantClass` against `@prisma/client`'s
  enum in `enum-parity.spec.ts` (extend its table); `PLAN_KEYS` against the four non-legacy
  `TenantPlan` members (it is not itself a Prisma enum). `plan-catalog.constants.ts` RE-EXPORTS
  from `@routeflow/types` — no second declaration (L-072). `admin/tenants/new/page.tsx` derives
  its plan options from `PLAN_KEYS` (currently hand-typed
  `["STARTER","PROFESSIONAL","ENTERPRISE"]` — PROFESSIONAL is not a real key, GROWTH/SCALE are
  missing). `create-tenant.dto.ts` imports the shared `PLAN_KEYS` const for its `@IsIn`.
  Red tests (fail on head): page.test.tsx "REG-743-F1 every plan option the form offers is a
  PLAN_KEYS member and every PLAN_KEYS member is offered" (head offers PROFESSIONAL → fails);
  enum-parity.spec.ts "REG-743-N6 TenantClass mirror is pinned" (no mirror exists → fails import).

### T2 — Reconciliation script guards (F3, F4, F5, N3)

- **files:** `apps/api/scripts/backfill-subscription-reconciliation.mjs`
- **tests:** `apps/api/src/common/backfill-subscription-reconciliation.db.spec.ts`
- **satisfies:** F3, F4, F5, N3 · **provenBy:** REG-743-F3, REG-743-N3, REG-743-F4, REG-743-F5
- **dependsOn:** T3 (shares the db spec file — T3's env-scrub lands first; land T3 first if the
  lane serializes, per the design's own ordering note)
- **risk:** HIGH
- **brief:** Tenant scope `class: "PRODUCTION", status: "ACTIVE", deletedAt: null`; select
  `planVersionId` on both tenant and subscription; **skip unless `stripeSubId` is set** (new
  "no Stripe subscription — manual decision" bucket — never remove this filter, B327). Version
  resolution: `sub.planVersionId ?? tenant.planVersionId ?? published` — load those versions'
  `PlanVersion`+`PlanDefinition` up front in ONE `planVersion.findMany({ where: { id: { in:
[...] } }, include: { definitions: true } })`, never per-row. Price from that version's
  definition; missing definition → "manual decision", never written. `updateMany` `where` adds
  `stripeSubId: { not: null }`; `data` sets `planVersionId` **only when the scanned value was
  null** (never overwrite a non-null pin, F3) — build `data` per row. When `tenant.planVersionId`
  was null, a second conditional `tenant.updateMany({ where: { id, planVersionId: null }, data:
{ planVersionId } })` (N3 — the tenant pin, not just the subscription pin). Header text and
  `BillingEvent` payload updated to record the `planVersionId` used.
  Red tests (`backfill-subscription-reconciliation.db.spec.ts`, DB lane; each fails on head):
  "REG-743-F3 a subscription pinned to an older archived PlanVersion is priced from that version
  and its pin is not moved" (fixture: 2nd PlanVersion, ARCHIVED, GROWTH @ 149, pinned on the sub;
  expect snapshot 149 + unchanged planVersionId — head writes 249 + published id); "REG-743-N3 a
  null tenant pin is set to the version used; a non-null tenant pin is never overwritten" (two
  fixtures); "REG-743-F4 a PRODUCTION ACTIVE row with planKey and no stripeSubId is listed and
  never written, no BillingEvent"; "REG-743-F5 a DEMO tenant's Stripe row is out of scope" and "…
  a CANCELLED PRODUCTION tenant is out of scope". The existing "apply backfills the partial
  subscription" fixture needs `stripeSubId: "sub_qa_…"` added or it now (correctly) becomes a
  skip — update it and keep the second-apply idempotency test green.

### T3 — Child-process env scrub for DB-lane specs (N2)

- **files:** none (the fix lives entirely inside the two spec files' own test setup)
- **tests:** `apps/api/src/common/backfill-subscription-reconciliation.db.spec.ts`,
  `apps/api/src/common/backfill-tenant-class.db.spec.ts`
- **satisfies:** N2 · **provenBy:** REG-743-N2 (both files)
- **dependsOn:** none — **land first if the lane serializes** (smallest, most dangerous to leave)
- **brief:** `resolveDatabaseUrl()` (`scripts/lib/railway-db-url.mjs:20-28`) returns the Railway
  TCP-proxy URL FIRST whenever `POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB/
RAILWAY_TCP_PROXY_DOMAIN/RAILWAY_TCP_PROXY_PORT` are all set — ordinary local vars
  (docker-compose.yml, .env.example). Both db specs spawn their CLI (`execSync("node CLI
[--apply]", { env: { ...process.env, DATABASE_URL: dbUrl } })`) with the FULL inherited
  environment — `requireLocalDatabaseUrl()` guards only the spec's own Prisma client, not the
  child process. Fix: in each spec, build `childEnv` from `process.env` with every `RAILWAY_*`
  and `POSTGRES_*` key deleted, then set `DATABASE_URL: dbUrl` — pass `childEnv` to every
  `execSync` call in the file. Keep the resolver's Railway-first order as-is (that's what
  `railway run` needs); the fix is at the caller, not the resolver. Also have both CLIs print the
  redacted host they resolved (`redactUrl`, same module) on their first stdout line so the spec
  can assert it.
  Red tests (add to EACH file): "REG-743-N2 the spawned CLI targets the spec's local database
  even when Railway proxy vars are present in the environment" — before spawning, set
  `RAILWAY_TCP_PROXY_DOMAIN=prod.invalid`, `RAILWAY_TCP_PROXY_PORT=5432`, fake `POSTGRES_*` in
  the SPEC's own `process.env` (not the child's); assert the CLI's printed host is the local one
  (head: CLI resolves `prod.invalid` → fails).

### T4 — Explicit tenant class on create (F7)

- **files:** `apps/api/src/tenant/tenant-class.ts` (NEW),
  `apps/api/src/platform-admin/dto/create-tenant.dto.ts`,
  `apps/api/src/platform-admin/platform-admin.service.ts`
- **tests:** `apps/api/src/platform-admin/platform-admin.service.spec.ts`,
  `apps/api/src/tenant/tenant-class.spec.ts` (NEW)
- **satisfies:** F7 · **provenBy:** REG-743-F7 (×3)
- **dependsOn:** T1 (shares `create-tenant.dto.ts` — lands the shared `PLAN_KEYS`/consts import
  first)
- **brief:** `Tenant.class @default(PRODUCTION)` (tenancy.prisma:87); `createTenant` never sets
  it today — fail-open onto every new tenant. New `apps/api/src/tenant/tenant-class.ts` exports
  `classifyTenantSlug(slug): TenantClass` — the SAME table as `backfill-tenant-class.mjs`'s
  `classify()` (`qa-*`/`e2e-*`/`ux-audit-*` → TEST, `routeflow-demo` → DEMO, `routeflow-hq` →
  INTERNAL, else PRODUCTION), a from-scratch TS port, not a re-derivation. `CreateTenantDto.class?`
  validated `@IsIn(TENANT_CLASS_VALUES)` (T1's shared const). `createTenant`: `resolvedClass =
dto.class ?? classifyTenantSlug(slug)`; throw `BadRequestException` when `dto.class ===
"PRODUCTION"` AND the classifier says TEST/DEMO/INTERNAL (fail closed on contradiction);
  `tx.tenant.create` always writes `class: resolvedClass` explicitly — never rely on the DB
  default. Audit row includes the class. Web form: no new required field here (a `class` select
  is later scope).
  Red tests (`platform-admin.service.spec.ts`): "REG-743-F7 createTenant writes class TEST for a
  qa-* slug", "… writes class PRODUCTION for an ordinary slug", "… rejects class PRODUCTION on an
  e2e-* slug" (all fail on head — no class is ever written). `tenant-class.spec.ts`: table-test
  `classifyTenantSlug` against the same slug table `backfill-tenant-class.db.spec.ts`'s fixtures
  use (import the `.mjs` via dynamic `import()` only if the Jest ESM config allows it —
  **unverified**; otherwise the shared slug table in the brief is the guard, not an import pin).

### T5 — One engine for real: `MrrService.priceTenant()` (N1)

- **files:** `apps/api/src/billing/mrr.service.ts`,
  `apps/api/src/platform-admin/platform-admin.service.ts`
- **tests:** `apps/api/src/platform-admin/platform-admin.service.spec.ts`,
  `apps/api/src/billing/mrr.service.spec.ts`
- **satisfies:** N1 · **provenBy:** REG-743-N1 (×2)
- **dependsOn:** T4 (shares `platform-admin.service.ts` — no logical dependency, pure file-
  ownership sequencing; T4's `createTenant` edit and T5's `getTenant` edit are different methods)
- **risk:** HIGH
- **brief:** Two MRR engines exist. `getTenant()` (`platform-admin.service.ts:203-214`) still
  prices via `_monthlyPriceUsd(tenant, catalogPriceByPlanKey)` (`:1417-1447` — snapshot else
  PUBLISHED catalog price, no class filter, no discount, no add-ons), gated only on `status ===
"ACTIVE"`. `mrr.service.ts:98-121` (the dashboard engine) is snapshot-only (null → $0), minus
  discount, plus add-ons, `class: PRODUCTION` only. Result: Σ(tenant cards) ≠ dashboard MRR by
  construction — a DEMO tenant's card shows the catalog price, a free pilot's card shows list
  price while the dashboard shows $0 for the same tenant. Fix: extract the per-row pricing out of
  `computeOverview()` into a pure `priceSubscription(sub, addons)` = `base − discount +
Σ addon` PLUS a `priceTenant(tenantId)` that applies the SAME `class: PRODUCTION` / `status:
ACTIVE` gate (non-PRODUCTION or non-ACTIVE → 0, no exceptions). `getTenant()` calls
  `priceTenant()` for its card. Delete `_monthlyPriceUsd`, `_catalogPriceByPlanKey`, and the two
  spec cases the PR added specifically to pin the divergence as intended
  (`platform-admin.service.spec.ts` "getTenant — estMrrUsd card … still live here" hunk).
  `computeOverview()` now sums `priceSubscription` so the card and the dashboard are the SAME
  function by construction (closes L-119).
  Red tests: `platform-admin.service.spec.ts` "REG-743-N1 getTenant prices through MrrService — a
  DEMO tenant's card is $0 and a snapshot-less ACTIVE tenant's card is $0, never the catalog
  price" (head returns 149/249 → fails). `mrr.service.spec.ts` "REG-743-N1 priceTenant equals the
  tenant's share of computeOverview for the same fixture" (no such equality exists on head).

### T6 — Scope the sibling admin figures (N4)

- **files:** `apps/api/src/platform-admin/platform-admin.service.ts`
- **tests:** `apps/api/src/platform-admin/platform-admin.service.spec.ts`
- **satisfies:** N4 · **provenBy:** REG-743-N4
- **dependsOn:** T5 (shares `platform-admin.service.ts`; also needs T1's `TENANT_CLASS_VALUES` —
  transitively satisfied via T4→T5)
- **brief:** `getBillingOverview()` (`:999-1009`) — `tenantSubscription.findMany` has no tenant
  filter, `tenant.count()`/TRIAL count have no class filter — add
  `where: { tenant: { class: "PRODUCTION", deletedAt: null } }` (subscriptions) and `class:
"PRODUCTION"` (both counts). `getGrowth()` (`:985-987`) — monthly `tenant.count` by
  `createdAt` has no class filter — add `class: "PRODUCTION"`. Declare in the PR body: every
  platform-admin count is PRODUCTION-only except `superAdminCount` (staff carry no tenantId —
  deliberately global).
  Red test: `platform-admin.service.spec.ts` "REG-743-N4 getBillingOverview and getGrowth scope
  every tenant query by class PRODUCTION" (assert `where.class` / `where.tenant.class` present on
  every call — head has none → fails).

### T7 — Honest labels + visibility counts (N5, F2)

- **files:** `apps/api/src/billing/mrr.service.ts`
- **tests:** `apps/api/src/billing/mrr.service.spec.ts`,
  `apps/api/src/common/mrr.db.spec.ts` (NEW)
- **satisfies:** N5, F2 (visibility half — see F2 ruling: no catalog fallback, this is the
  companion) · **provenBy:** REG-743-N5, REG-743-F2, REG-743-N9
- **dependsOn:** T5 (needs `priceSubscription`; shares `mrr.service.ts`)
- **risk:** HIGH
- **brief:** `MrrOverview` gains `unpricedActiveTenants` (ACTIVE, PRODUCTION, `planKey` set,
  `basePriceSnapshot` null) and `activeWithoutSubscription` (ACTIVE, PRODUCTION, no subscription
  row) — the F2 shape's visibility fix: $0 is correct, but it must never be SILENT.
  `payingTenants` and `byPlan[].tenants` count ONLY rows whose `priceSubscription() > 0` — today
  every `payingWhere` row increments both even at $0 (a free pilot reads as "2 paying, $249").
  Web (`admin/dashboard/page.tsx` or `admin/billing/page.tsx`, whichever renders `MrrOverview`)
  shows the two new counts as a warning chip when > 0 — no new component, extend the existing MRR
  card. New DB-lane spec `apps/api/src/common/mrr.db.spec.ts` — the FIRST non-mock proof of
  invariant (i): seed a PRODUCTION paying row (priced), a DEMO row (excluded), a TRIAL row
  (excluded), and an ACTIVE PRODUCTION pilot row with `planKey` set + full discount (priced $0,
  NOT counted as paying) — assert `computeOverview()` against real Postgres rows, not a mock.
  Red tests: `mrr.service.spec.ts` "REG-743-N5 a $0-priced row is not a paying tenant" (head
  counts it → fails); "REG-743-F2 an ACTIVE PRODUCTION row with null snapshot is reported in
  unpricedActiveTenants" (field absent → fails). `mrr.db.spec.ts` "REG-743-N9 computeOverview
  against real rows: PRODUCTION paying = price, DEMO = 0, TRIAL = 0, full-discount pilot = 0 and
  not counted as paying" (file does not exist on head → fails to run).

### T8 — Docs, code-map, lessons (F6, N7, N8) — same PR

- **files:** `apps/api/src/billing/plan-catalog.constants.ts`,
  `.claude/code-map/api/feature-modules-1.md`, `.claude/code-map/api/feature-modules-4.md`,
  `.claude/lessons/LESSONS.md`
- **tests:** none (docs task)
- **satisfies:** F6, N7, N8 · **provenBy:** none (declaration-only findings — no red test named)
- **dependsOn:** T1, T2, T3, T4, T5, T6, T7 (last, same PR; shares `plan-catalog.constants.ts`
  with T1)
- **brief:** F6 — fix the stale `TRIAL_LENGTH_DAYS` docblock (`plan-catalog.constants.ts:13-16`,
  still claims the admin path is "NOT wired"; it is, flat 14 days — keep 14, this was a
  declaration defect not a code defect); correct the PR body ("per plan" is wrong). N7 — declare
  the undeclared `trialLengthDays` 1-90 admin override (`create-tenant.dto.ts:52-59`) in the PR
  body; no code change. N8 — add `RECONCILIATION_SNAPSHOT_BACKFILLED:
"reconciliation.snapshot_backfilled"` to `BILLING_EVENTS` (`plan-catalog.constants.ts:157-169`)
  with a comment that the `.mjs` script mirrors the string (a `.mjs` cannot import the TS const).
  Code-map: update entries for `mrr.service.ts` (T5/T7's real single-engine + visibility counts,
  `feature-modules-4.md`), `platform-admin.service.ts`'s `getStats`/`getTenant`/
  `getBillingOverview`/`getGrowth` entries and the new `tenant-class.ts` (`feature-modules-1.md`),
  the reconciliation script's entry (already current from commit `af1b700b`). Lessons: ONE entry
  for N2 (a child process does not inherit a guard — scrub env before spawning a prod-capable
  CLI) and ONE for N1 (a "single engine" claim needs a grep for the old helper's remaining call
  sites, not just the one caller that was migrated) — **ids are NOT fixed numbers; T8 is the last
  task in the run and other lanes can land more commits before it executes.** Read
  `.claude/lessons/_meta.json`'s `nextId` (call it N) at write time, use L-N and L-(N+1), grep
  `LESSONS.md` first to confirm neither already exists, bump `nextId` to N+2, then run
  `node scripts/validate-lessons.mjs --digest` and require a self-consistent report before
  finishing. **Do NOT use L-140/L-141** — this plan's original placeholder, superseded during
  pre-launch merges (this branch's own pre-existing two entries are L-133/L-134, fixed from an
  earlier L-129/L-130 guess that collided with PR #746's independently-claimed L-129; by the
  final pre-launch merge the confirmed floor was `nextId` 146, and it may be higher still by the
  time T8 runs — that is exactly why this reads live rather than trusting any number written here).

---

## Package map

| Task | satisfies      | provenBy                                       | dependsOn            | Wave | risk |
| ---- | -------------- | ---------------------------------------------- | -------------------- | ---- | ---- |
| T1   | F1, N6         | REG-743-F1, REG-743-N6                         | —                    | 1    | —    |
| T3   | N2             | REG-743-N2 (×2 files)                          | —                    | 1    | —    |
| T2   | F3, F4, F5, N3 | REG-743-F3, REG-743-N3, REG-743-F4, REG-743-F5 | T3                   | 2    | HIGH |
| T4   | F7             | REG-743-F7 (×3)                                | T1                   | 2    | —    |
| T5   | N1             | REG-743-N1 (×2)                                | T4                   | 3    | HIGH |
| T6   | N4             | REG-743-N4                                     | T5                   | 4    | —    |
| T7   | N5, F2         | REG-743-N5, REG-743-F2, REG-743-N9             | T5                   | 4    | HIGH |
| T8   | F6, N7, N8     | — (declaration-only)                           | T1,T2,T3,T4,T5,T6,T7 | 5    | —    |

Cross-check: every finding id from §2/§3 of the design (F1-F7, N1-N9) appears in some task's
`satisfies`, or is explicitly out of scope above (none are). Every `REG-743-*` test the design
names in §4 appears in some task's `provenBy`.

**Note on the three dependsOn edges the design's own prose did not state** (it called T1‖T2‖T3‖T4
"independent, run in parallel" and T6 "independent of T5"): T2/T3 share
`backfill-subscription-reconciliation.db.spec.ts`; T1/T4 share `create-tenant.dto.ts`; T4/T5/T6
all share `platform-admin.service.ts` (different methods, same file). The engine's own rule
("shared file ⇒ dependsOn, never a fake overlap") requires the edge regardless of whether the
touched regions actually collide — added here as a transcription-level fix, not a change to any
of Fable's substantive rulings on WHAT each task does.

---

## Acceptance criteria

1. F1 — the admin Create Tenant form offers exactly the four `PLAN_KEYS` plans; posting any of
   them succeeds; posting a value outside `PLAN_KEYS` still 400s.
2. F3/N3 — a subscription or tenant already pinned to a non-null `planVersionId` is NEVER
   overwritten by the reconciliation script; a null pin is set to the version actually priced
   from.
3. F4/F5 — `--apply` never writes a row with `stripeSubId` null, `class` outside PRODUCTION, or
   `status` outside ACTIVE; every such row is listed for a human, never touched.
4. N2 — running either DB-lane spec with Railway proxy vars present in the environment still
   targets the local compose database, proven by the CLI's own printed (redacted) host.
5. F7 — every tenant created through the admin path carries an explicit `class`; an explicit
   PRODUCTION on a TEST/DEMO-classified slug 400s instead of silently mis-classifying.
6. N1 — a tenant's detail-card MRR and its contribution to the dashboard total are computed by
   the SAME function; a DEMO tenant and a null-snapshot ACTIVE tenant show $0 in BOTH places.
7. N4 — every admin billing/growth count still standing after this round is explicitly scoped by
   `class: PRODUCTION`, `superAdminCount` explicitly excepted.
8. N5/F2 — a $0-priced tenant is never counted in `payingTenants`/`byPlan[].tenants`; an
   under-priced-but-active tenant is surfaced in `unpricedActiveTenants`/
   `activeWithoutSubscription`, never silently absorbed into a $0 total.
9. Negative case: none of T1-T7's guards can be satisfied by relaxing the `stripeSubId`/`class`/
   `status` filters — the red tests fail if a future edit drops any of them.
10. Deploy day: no migration in this round; existing PRODUCTION tenants with a full subscription
    row are priced identically before and after (proven by the T7 `mrr.db.spec.ts` PRODUCTION
    fixture).

---

## Verification commands

Per round (no HOST slot needed):

```bash
cd apps/api && npm run check-types
cd apps/web && npm run check-types
cd apps/api && npm run lint
cd apps/web && npm run lint
cd apps/api && npx jest --maxWorkers=2 --passWithNoTests --testPathPattern="platform-admin|mrr\.service|backfill-subscription-reconciliation|backfill-tenant-class|enum-parity|tenant-class"
cd apps/web && npx jest --passWithNoTests --testPathPattern="tenants/new/page"
```

Final (HOST slot required — billing.module.ts area, compose boot gate; ask routeflow-c4 first):

```bash
npm run check-types
npm run lint
npm run test
cd apps/api && npm run test:db -- --maxWorkers=2 --testPathPattern="backfill-subscription-reconciliation|backfill-tenant-class|mrr\.db"
npm run local:validate
```

---

## Risks & rollback

| Risk                                                                                                                         | Likelihood | Blast radius           | Mitigation                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T2's version-resolution reorder (F3) mis-prices a real Stripe-originated row                                                 | low        | money wrong            | Opus-verifier gating per the design §4: T2's F3 fixture scope changes only if the verifier disproves F3; land the red test first, it must fail for F3's stated reason |
| T5's `priceTenant()` extraction breaks `getTenant()`'s other fields (`orders30d`, `counts.customerLinks`)                    | low        | cosmetic               | T5's files list is narrow (pricing only); acceptance criterion 6 plus the existing (untouched) spec cases for those fields                                            |
| N2's env-scrub misses a Railway var name and a future proxy var still leaks through                                          | med        | data lost (prod write) | T3's red test sets the exact vars N2 named; `railway variables` output should be diffed against the scrub list before this round's `final` DB-lane run                |
| The lesson-id ambiguity (L-131/132 vs the doc's stated L-133/134) causes a second collision if another lane mints in the gap | low-med    | tooling churn only     | T8 explicitly flags it rather than silently picking a number; do not write the N1/N2 lessons until routeflow-c4/0d confirms the id                                    |

- **Rollback:** revert the PR's diff; no migration, no data write beyond what T2's `--apply`
  performs (itself gated behind a human `console.table` read and the F4/F5 guards).
- **Feature flag:** none — this is a pre-merge review fix round on code not yet in production.
- **Observability:** T7's new `unpricedActiveTenants`/`activeWithoutSubscription` counts ARE the
  2am signal — a nonzero value post-deploy means real tenants are underpriced and visible, not
  silently absorbed.

---

## UI verification

None declared for this round — no new screen; T7's warning-chip render is covered by its own
Jest/RTL cases, not a Playwright pass. Add a `ui-verify` task later only if the owner wants a
screenshot of the new warning chip before merge.

---

## Pipeline args

_Prepared, NOT launched. Gated on the owner's explicit go (separate from routeflow-c4's "launch"
reply) and on routeflow-c4 confirming HOST is free._

```js
{
  buildPlanPath: '.claude/pipeline/2026-09-14-743-fix-round/build-plan.md',
  scriptsDir: 'C:/Users/nakram/.claude/skills/dev-pipeline/scripts',
  lessonsPath: '.claude/lessons/LESSONS.md',
  startedAt: '<ISO timestamp taken at actual launch>',
  runDir: '.claude/pipeline/2026-09-14-743-fix-round',
  scale: 'major',
  mode: 'feature',   // NOT 'bugfix' -- pre-merge review findings on an unmerged PR, no B### ids;
                      // flag to c4/Fable if 'bugfix' (harness-integrity read + sibling sweep) was intended instead
  workdir: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-phase0c',
  context: 'PR #743 fix round 3 (owner-escalated) -- close F1-F7 + N1-N9 per reviews/743-fable-review-and-fix-design.md',

  tasks: [
    { id: 'T1', title: 'Shared plan/class consts + admin form', type: 'feature',
      files: ['packages/types/api/enums.ts', 'apps/api/src/billing/plan-catalog.constants.ts',
              'apps/web/app/(platform-admin)/admin/tenants/new/page.tsx',
              'apps/api/src/platform-admin/dto/create-tenant.dto.ts'],
      tests: ['apps/web/app/(platform-admin)/admin/tenants/new/page.test.tsx',
              'apps/api/src/common/enum-parity.spec.ts'],
      dependsOn: [],
      brief: 'F1,N6. Add PLAN_KEYS/PlanKey + TENANT_CLASS_VALUES/TenantClass to packages/types/api/enums.ts; pin TenantClass set-equal to @prisma/client in enum-parity.spec.ts, PLAN_KEYS to the 4 non-legacy TenantPlan members. plan-catalog.constants.ts re-exports (no 2nd decl, L-072). admin/tenants/new/page.tsx derives plan options from PLAN_KEYS (head hand-types STARTER/PROFESSIONAL/ENTERPRISE -- PROFESSIONAL is not real, GROWTH/SCALE missing). create-tenant.dto.ts imports PLAN_KEYS for @IsIn. RED: page.test.tsx "REG-743-F1 every option is a PLAN_KEYS member and vice versa" (head offers PROFESSIONAL, fails); enum-parity.spec.ts "REG-743-N6 TenantClass mirror is pinned" (no mirror, fails import).' },

    { id: 'T3', title: 'Child-process env scrub for DB-lane specs', type: 'feature',
      files: [],
      tests: ['apps/api/src/common/backfill-subscription-reconciliation.db.spec.ts',
              'apps/api/src/common/backfill-tenant-class.db.spec.ts'],
      dependsOn: [],
      brief: 'N2. resolveDatabaseUrl() (scripts/lib/railway-db-url.mjs:20-28) returns the Railway TCP-proxy URL FIRST when POSTGRES_*/RAILWAY_TCP_PROXY_* are all set (ordinary local vars). Both db specs spawn their CLI via execSync with the FULL inherited env -- requireLocalDatabaseUrl() only guards the specs own Prisma client, not the child. Fix in EACH spec: build childEnv from process.env with every RAILWAY_* and POSTGRES_* key deleted, then DATABASE_URL: dbUrl; pass childEnv to every execSync call in the file. Keep the resolvers Railway-first order (railway run needs it) -- fix the caller, not the resolver. Have both CLIs print the redacted host they resolved (redactUrl) on stdout line 1. RED (add to each file): "REG-743-N2 the spawned CLI targets the local db even with Railway proxy vars present" -- set RAILWAY_TCP_PROXY_DOMAIN=prod.invalid + fake POSTGRES_* in the specs own env before spawning; assert the printed host is local (head resolves prod.invalid, fails).' },

    { id: 'T2', title: 'Reconciliation script guards', type: 'feature',
      files: ['apps/api/scripts/backfill-subscription-reconciliation.mjs'],
      tests: ['apps/api/src/common/backfill-subscription-reconciliation.db.spec.ts'],
      dependsOn: ['T3'],
      risk: 'HIGH',
      brief: 'F3,F4,F5,N3. Scope class:PRODUCTION,status:ACTIVE,deletedAt:null; select planVersionId on tenant+sub; skip unless stripeSubId set (never drop this filter, B327). Version = sub.planVersionId ?? tenant.planVersionId ?? published -- load those PlanVersion+PlanDefinition rows in ONE findMany, price from that definition; missing def -> manual decision. updateMany where adds stripeSubId:{not:null}; data sets planVersionId ONLY when scanned value was null (never overwrite a non-null pin, F3) -- per-row data. tenant.planVersionId null -> 2nd conditional tenant.updateMany (N3). Header + BillingEvent record the planVersionId used. RED (db spec, each fails on head): F3 archived-version-pinned-sub fixture (expect 149+unchanged pin, head writes 249+published); N3 null-vs-non-null tenant pin (2 fixtures); F4 no-stripeSubId row listed+never written+no event; F5 DEMO/CANCELLED rows out of scope. Existing partial-subscription fixture needs stripeSubId added or it becomes a correct skip -- update it, keep 2nd-apply idempotency green.' },

    { id: 'T4', title: 'Explicit tenant class on create', type: 'feature',
      files: ['apps/api/src/tenant/tenant-class.ts',
              'apps/api/src/platform-admin/dto/create-tenant.dto.ts',
              'apps/api/src/platform-admin/platform-admin.service.ts'],
      tests: ['apps/api/src/platform-admin/platform-admin.service.spec.ts',
              'apps/api/src/tenant/tenant-class.spec.ts'],
      dependsOn: ['T1'],
      brief: 'F7. Tenant.class @default(PRODUCTION), createTenant never sets it (fail-open). New tenant-class.ts exports classifyTenantSlug(slug):TenantClass -- SAME table as backfill-tenant-class.mjs classify() (qa-*/e2e-*/ux-audit-* ->TEST, routeflow-demo->DEMO, routeflow-hq->INTERNAL, else PRODUCTION), a from-scratch TS port. CreateTenantDto.class? @IsIn(TENANT_CLASS_VALUES). createTenant: resolvedClass = dto.class ?? classifyTenantSlug(slug); throw BadRequestException when dto.class===PRODUCTION AND classifier says TEST/DEMO/INTERNAL (fail closed); tx.tenant.create always writes class explicitly, never the DB default. Audit row includes class. RED (platform-admin.service.spec.ts): "writes class TEST for qa-* slug", "writes PRODUCTION for ordinary slug", "rejects PRODUCTION on e2e-* slug" (all fail on head). tenant-class.spec.ts: table-test against backfill-tenant-class.db.spec.ts fixtures shared slug table (dynamic import of the .mjs only if Jest ESM allows -- unverified; else the shared table is the guard).' },

    { id: 'T5', title: 'One engine for real: MrrService.priceTenant()', type: 'feature',
      files: ['apps/api/src/billing/mrr.service.ts', 'apps/api/src/platform-admin/platform-admin.service.ts'],
      tests: ['apps/api/src/platform-admin/platform-admin.service.spec.ts', 'apps/api/src/billing/mrr.service.spec.ts'],
      dependsOn: ['T4'],
      risk: 'HIGH',
      brief: 'N1 (L-119 seam). getTenant() (platform-admin.service.ts:203-214) still prices via _monthlyPriceUsd/_catalogPriceByPlanKey (:1417-1447 -- snapshot else PUBLISHED catalog price, no class/discount/addon filter), gated only on status ACTIVE. mrr.service.ts:98-121 is snapshot-only, minus discount, plus addons, class:PRODUCTION only. Card != dashboard by construction. Fix: extract priceSubscription(sub,addons) = base-discount+addons (pure) + priceTenant(tenantId) applying the SAME class:PRODUCTION/status:ACTIVE gate (else 0, no exceptions). getTenant() calls priceTenant(). DELETE _monthlyPriceUsd, _catalogPriceByPlanKey, and the 2 spec cases the PR added to pin the divergence as intended. computeOverview() sums priceSubscription -- card and dashboard become the SAME function. RED: platform-admin.service.spec.ts "REG-743-N1 getTenant prices through MrrService -- DEMO card=$0, snapshot-less ACTIVE card=$0, never catalog price" (head returns 149/249, fails). mrr.service.spec.ts "REG-743-N1 priceTenant equals the tenants share of computeOverview for the same fixture" (no such equality on head).' },

    { id: 'T6', title: 'Scope the sibling admin figures', type: 'feature',
      files: ['apps/api/src/platform-admin/platform-admin.service.ts'],
      tests: ['apps/api/src/platform-admin/platform-admin.service.spec.ts'],
      dependsOn: ['T5'],
      brief: 'N4. getBillingOverview() (:999-1009): tenantSubscription.findMany has no tenant filter, tenant.count()/TRIAL count have no class filter -- add where:{tenant:{class:PRODUCTION,deletedAt:null}} (subs) and class:PRODUCTION (both counts). getGrowth() (:985-987): monthly tenant.count by createdAt has no class filter -- add class:PRODUCTION. Declare in PR body: every platform-admin count is PRODUCTION-only except superAdminCount (staff carry no tenantId, deliberately global). RED: platform-admin.service.spec.ts "REG-743-N4 getBillingOverview and getGrowth scope every tenant query by class PRODUCTION" (assert where.class/where.tenant.class on every call -- head has none, fails).' },

    { id: 'T7', title: 'Honest labels + visibility counts', type: 'feature',
      files: ['apps/api/src/billing/mrr.service.ts'],
      tests: ['apps/api/src/billing/mrr.service.spec.ts', 'apps/api/src/common/mrr.db.spec.ts'],
      dependsOn: ['T5'],
      risk: 'HIGH',
      brief: 'N5,F2(visibility half). MrrOverview gains unpricedActiveTenants (ACTIVE,PRODUCTION,planKey set,snapshot null) and activeWithoutSubscription (ACTIVE,PRODUCTION,no sub row) -- F2 ruling: $0 is correct, never silent. payingTenants/byPlan[].tenants count ONLY rows where priceSubscription()>0 (head counts every payingWhere row even at $0). Web renders the 2 new counts as a warning chip on the existing MRR card when >0 -- no new component. NEW apps/api/src/common/mrr.db.spec.ts: first non-mock proof of invariant (i) -- seed PRODUCTION paying (priced), DEMO (excluded), TRIAL (excluded), ACTIVE PRODUCTION pilot with planKey+full discount (priced $0, not counted paying); assert computeOverview() against real Postgres rows. RED: mrr.service.spec.ts "REG-743-N5 a $0-priced row is not paying" (head counts it, fails); "REG-743-F2 unpricedActiveTenants reports a null-snapshot ACTIVE row" (field absent, fails). mrr.db.spec.ts "REG-743-N9 computeOverview against real rows" (file does not exist on head, fails to run).' },

    { id: 'T8', title: 'Docs, code-map, lessons', type: 'docs',
      files: ['apps/api/src/billing/plan-catalog.constants.ts',
              '.claude/code-map/api/feature-modules-1.md', '.claude/code-map/api/feature-modules-4.md',
              '.claude/lessons/LESSONS.md'],
      tests: [],
      dependsOn: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'],
      brief: 'F6,N7,N8. Fix stale TRIAL_LENGTH_DAYS docblock (plan-catalog.constants.ts:13-16, claims admin path NOT wired -- it is, flat 14 days; keep 14, declaration defect not code). Correct PR body ("per plan" wrong). Declare N7s undeclared trialLengthDays 1-90 admin override (create-tenant.dto.ts:52-59) in PR body, no code change. Add N8s RECONCILIATION_SNAPSHOT_BACKFILLED:"reconciliation.snapshot_backfilled" to BILLING_EVENTS with a comment the .mjs mirrors the string. Update code-map entries for mrr.service.ts, platform-admin.service.ts (getStats/getTenant/getBillingOverview/getGrowth), new tenant-class.ts. LESSON IDS ARE NOT FIXED NUMBERS -- read .claude/lessons/_meta.json fresh at the moment you write (this is the LAST task in the run; other lanes may have landed more commits by then): use its current nextId N for L-N (N2: a child process does not inherit a guard -- scrub env before spawning a prod-capable CLI) and N+1 for L-(N+1) (N1: a single-engine claim needs a grep for the old helpers remaining call sites, not just the one caller migrated); grep LESSONS.md to confirm neither id already exists before writing; set nextId to N+2 afterward; run node scripts/validate-lessons.mjs --digest and require it to report self-consistent before finishing this task. Do NOT use L-140/L-141 -- those were this rounds original placeholder and are already claimed by other lanes (confirmed stale as of the pre-launch merge).' },
  ],

  verifyCommands: {
    perRound: [
      'cd apps/api && npm run check-types',
      'cd apps/web && npm run check-types',
      'cd apps/api && npm run lint',
      'cd apps/web && npm run lint',
      'cd apps/api && npx jest --maxWorkers=2 --passWithNoTests --testPathPattern="platform-admin|mrr\\.service|backfill-subscription-reconciliation|backfill-tenant-class|enum-parity|tenant-class"',
      'cd apps/web && npx jest --passWithNoTests --testPathPattern="tenants/new/page"',
    ],
    final: [
      'npm run check-types',
      'npm run lint',
      'npm run test',
      'cd apps/api && npm run test:db -- --maxWorkers=2 --testPathPattern="backfill-subscription-reconciliation|backfill-tenant-class|mrr\\.db"',
      'npm run local:validate',
    ],
  },
  // formatCommand deliberately OMITTED: grepped the rebuilt pipeline.js source (2026-09-14) --
  // it has NO formatCommand mechanism at all (the WP-D/WP-E repo-wide-format wipe on the T12-T15
  // run was the LEGACY ten-phase engine's behavior, staged there by mistake; this arg appears to
  // be legacy-engine-only despite being documented in this SKILL.md's own template -- flag as a
  // doc/code mismatch, separate from this round).
}
```
