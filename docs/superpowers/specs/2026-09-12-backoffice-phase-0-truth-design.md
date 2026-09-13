# Phase 0 — Truth, hygiene, HQ bootstrap: implementation spec

Parent: `2026-09-12-platform-backoffice-design.md`. This is the first of seven sub-projects and
the only one with no user-visible feature; its output is that every number the founder already
reads becomes true, and the house tenant exists for every later phase to build on. Auto-approved
by the owner on 2026-09-12 (rulings 1, 3, 6, 13 apply here).

## Why this phase, why first

Every later phase depends on: one MRR number, a subscription row on every real tenant, a
tenant class that is not a guess, and the HQ tenant existing. Building invoicing (Phase 1) on
top of an unreconciled subscription set would invoice tenants for the wrong plan or invoice
tenants twice. Nothing here is a new feature; it is a data-correctness and bootstrap phase, and
it is verified by hand against the real book (roughly 6 paying tenants) before anything later
starts.

## Scope

In scope: `Tenant.class`, `Tenant.plan` enum widening, one shared `TRIAL_LENGTH_DAYS` constant,
the READ_ONLY quote-allowlist hotfix, subscription-set reconciliation (every real tenant gets a
`TenantSubscription` row with `planKey`/`basePriceSnapshot`/`planVersionId`), retiring the
`getStats()` MRR estimator in favor of `MrrService.computeOverview()`, filtering every admin KPI
query by tenant class, the OAuth device-column fix, and standing up the HQ tenant plus the
`TenantMirrorService`. Out of scope (later phases): invoicing, dunning, messaging, tenant 360,
security, catalog UI.

## 1. Tenant classification

`Tenant.class` enum: `PRODUCTION | DEMO | TEST | INTERNAL`. Backfill rule, in order: slug
matches `test-tenants.cjs`'s `qa-*`/`e2e-*`/`ux-audit-*` patterns or equals `test` or
`e2e-routeflow` → TEST; slug equals `routeflow-demo` → DEMO (owner ruling 6: visible in lists,
excluded from revenue and lifecycle sends, distinct from TEST which is hidden by default
everywhere); slug will equal `routeflow-hq` once created → INTERNAL; everything else →
PRODUCTION. The column ships **dark for one release**: populated and visible as a badge, but no
KPI query filters on it yet. Only after a manual check of the classified list against the known
real-tenant set (an artifact in the PR, not a script assertion) does a second small PR flip
every KPI query to `class = 'PRODUCTION'` by default, with an explicit `includeClasses` query
param for the admin UI's "show test/demo" toggles. This two-step order is required because a
backfill error in a single-step change would make a real tenant's revenue silently disappear in
the same PR whose purpose is to make revenue trustworthy.

`class` is admin-editable only, through a new `PATCH /platform-admin/tenants/:id/class` endpoint
that requires a reason string and writes both an `AdminAuditAction` (`TENANT_CLASS_CHANGED`,
new code) and a `BillingEvent` when the change moves a tenant into or out of PRODUCTION (so an
MRR change caused by reclassification is traceable in the ledger, not just the audit log).

## 2. Legacy plan enum

`TenantPlan` (`STARTER, TEAM, BUSINESS, PROFESSIONAL, ENTERPRISE`) cannot represent GROWTH or
SCALE, which is why the tenant detail page can show "Business" for a subscription actually
priced at Scale. This phase widens the enum to add `GROWTH` and `SCALE` (Prisma enum migration,
additive — Squawk-safe, no data rewrite required for existing rows) and stops every write path
(`createTenant`, `updateTenantPlan`, `activateManualSubscription`) from writing anything but the
tenant's live `TenantSubscription.planKey` value, mapped 1:1 to the enum. Every read path
(`getStats`, tenant list, tenant detail, `CreateTenantDto.plan`) switches from the legacy enum
to reading `GET /billing/plans` for the live catalog. The column itself is not dropped in this
phase — Phase 3 drops it once nothing reads or writes it, per the parent spec's roadmap table.

## 3. Subscription-set reconciliation

The critic's central finding: `MrrService.computeOverview()` only pays where a subscription row
carries a `planKey` and the tenant is ACTIVE; several ACTIVE tenants have no subscription row at
all (self-signup seeds none), and Stripe-originated rows are missing `planKey`/
`basePriceSnapshot`. A single column backfill cannot fix a tenant with no row to backfill.

Reconciliation script (`apps/api/scripts/backfill-subscription-reconciliation.mjs`, following
the existing `publish-plan-catalog-v*.ts` pattern): for every tenant with `class = PRODUCTION`
or `DEMO`, in dry-run mode by default:
- If a `TenantSubscription` row exists but is missing `planKey`/`basePriceSnapshot`/
  `planVersionId`: derive `planKey` from the tenant's legacy `plan` value (mapped once, by
  hand, in a lookup table checked into the script — not inferred), `basePriceSnapshot` from the
  currently published `PlanVersion`'s price for that key, and pin `planVersionId` to that
  version.
- If no `TenantSubscription` row exists at all: create one with `billingMode = NONE` initially
  (this phase does not decide STRIPE vs MANUAL for a tenant with no row — that decision needs a
  human to look at whether a Stripe customer id exists anywhere, which is Phase 1's job) and
  the same derived `planKey`/`basePriceSnapshot`/`planVersionId`.
- Every write emits a `BillingEvent` (`type: "reconciliation.subscription_created"` or
  `"reconciliation.snapshot_backfilled"`) tagged with the script run id, so the ledger shows
  exactly what this migration changed and it is excludable from future MRR-movement charts.

Dry-run output is a table: tenant, current display plan, current MRR contribution (old and
new engines), proposed `planKey`/price/mode, and a flag if the derived plan disagrees with what
the admin UI currently shows. The owner reviews and signs off on this table (ruling: "who signs
off on the dry-run diff" — the owner, per Section 5 decision 4 in the parent spec) before the
apply run, which is executed once against the local compose stack, then once against prod via
`railway run --service postgres node apps/api/scripts/backfill-subscription-reconciliation.mjs
--apply`, with a fresh backup taken immediately before.

## 4. One MRR engine

`PlatformAdminService.getStats()`'s `estMrrUsd` calculation (`_monthlyPriceUsd` over ACTIVE
tenants, no ledger reconciliation) is deleted. `getStats()` calls
`MrrService.computeOverview()` and returns its `mrr` field as the dashboard's only MRR number;
the admin Billing page already calls the MRR endpoint separately today and is changed to read
the same field. `ledgerMrr` (the reconciled-against-events figure) is exposed alongside `mrr` on
both the dashboard and Billing overview as a labelled secondary "reconciled" figure, never a
third silently-different number — this satisfies the gap matrix's `sma-reconciled-vs-estimated`
row without inventing a new display. `MrrService`'s own MRR sum is scoped to
`tenant.class = PRODUCTION`; the separate `ledgerMrr` sum (which today has no tenant filter at
all, per the critic's finding) gets the same filter added, otherwise it and `mrr` diverge again
the moment KPIs start excluding test tenants.

## 5. Trial length and the READ_ONLY hotfix

A single `TRIAL_LENGTH_DAYS = 14` constant (`apps/api/src/billing/plan-catalog.constants.ts`,
beside `PLAN_KEYS`) replaces the two current literals (`7` in
`platform-admin.service.ts::createTenant`, `14` in `tenants.service.ts::register`). Trials
already running keep their existing `trialEndsAt`; only new trials use the constant. The
`/signup` page copy ("14-day free trial") needs no change since 14 was already the self-serve
number; the admin Create Tenant form's implicit 7-day behavior changes to 14, with an explicit
"Trial length" field defaulting to the constant and allowing an admin override per tenant
(needed for Phase 1's manual-activation trials, which may be negotiated).

Hotfix, independent of the constant: `tenant-status.guard.ts`'s READ_ONLY allowlist adds
`POST /billing/quote` (and, checking at implementation time, any other read used by the
choose-plan page's Subscribe button) so an expired-trial tenant can price a plan and see the
Subscribe control render. This is the prior audit's CRITICAL and is the one change in this
phase that is a genuine bug fix rather than a data or bootstrap change — it ships as its own
small PR through bug-pipeline conventions (a repro test that fails on today's 403 and passes
after) even though it lands in the same phase window as everything else here.

## 6. Session device parsing

`RefreshToken.ipAddress`/`userAgent` are written on the credential login path but not the
Google OAuth path (`google-oauth.service.ts`'s token-issuance call site), which is why every
admin session in "My Account" reads "Unknown device". Three-line fix: call the same
`extractDeviceInfo()` helper (already used by the credential path) at the OAuth issuance site.
No schema change.

## 7. HQ tenant bootstrap

Creates the house tenant this and every later phase depends on:

- One-time script `apps/api/scripts/bootstrap-house-tenant.mjs`: creates `Tenant{slug:
  "routeflow-hq", class: INTERNAL, plan: ENTERPRISE}` (a real tenant row, so every existing
  guard, module and query path works unmodified), a `TenantConfig` with RouteFlow's own legal
  name/address (owner-supplied, held as a placeholder until provided), and a `TENANT_ADMIN`
  user for internal use. Guarded by `assertSafeTarget`-style idempotency: running it twice is a
  no-op if `routeflow-hq` already exists.
- `PlatformConfig` key `platform.houseTenantId` is set to the new tenant's id. Every later
  phase's platform-admin code resolves HQ through this config key, never a hardcoded slug
  string, so a future environment (staging, if one is ever added) can have its own HQ tenant.
- `Customer.representsTenantId` column added (nullable, unique) — schema-only in this phase; no
  writer yet. This unblocks Phase 1's invoicing work from needing its own migration.
- `TenantMirrorService` (new, `apps/api/src/platform-admin/tenant-mirror.service.ts`):
  `upsert(tenantId)` reads the target tenant's `TenantConfig` and its `TENANT_ADMIN` user(s),
  and creates or updates one HQ `Customer` (`representsTenantId = tenantId`, name from
  `businessName`, matched on `representsTenantId` not on name/email so a tenant rename does not
  create a duplicate) plus `ContactPerson` rows for each tenant admin (matched on email within
  that customer). Called synchronously at the end of `createTenant()` and `updateTenantConfig()`
  in `platform-admin.service.ts`, and from a new nightly `@LeaderCron("platform-admin.mirror-
  sync", "0 6 * * *")` job that walks every PRODUCTION/DEMO/MANUAL-eligible tenant and calls
  `upsert()`, logging a `JobRun`-shaped result even though the `JobRun` table itself is Phase
  1's addition (this job writes its outcome via `logger.log` in Phase 0 and gains the table in
  Phase 1 rather than blocking on it). A mirror-sync failure for one tenant does not abort the
  loop; it is collected and reported.
- This phase does **not** create any HQ `Invoice`, `ContactPerson.role` value, or messaging
  wiring — those are Phase 1 (invoicing) and Phase 4 (messaging). Phase 0's job is only that
  every real tenant has exactly one correctly-linked HQ `Customer` row by the time Phase 1
  starts writing invoices against it.

## Data model deltas (this phase only)

| Model | Change |
| --- | --- |
| Tenant | + `class` enum (PRODUCTION default, backfilled dark) |
| TenantPlan (enum) | + GROWTH, SCALE (additive) |
| TenantSubscription | no schema change; reconciliation is a data backfill only |
| Customer | + `representsTenantId String? @unique` (schema only, no writer yet) |
| PlatformConfig | + key `platform.houseTenantId` |
| AdminAuditAction (const) | + `TENANT_CLASS_CHANGED` |

New Prisma migration is one file covering `Tenant.class`, the `TenantPlan` enum widening, and
`Customer.representsTenantId` together, run through `npx prisma migrate dev` locally and
`prod-migrate.mjs` against prod per the standing runbook. Added to `MODEL_DOMAIN` in
`split-prisma-schema.mjs`: no new models this phase, only column/enum changes to existing
domain files (`tenancy.prisma`, `sales.prisma`), so no map entry is needed.

## API deltas (this phase only)

- `PATCH /platform-admin/tenants/:id/class` (new): body `{class, reason}`, SUPER_ADMIN only.
- `GET /platform-admin/tenants`, `GET /platform-admin/stats`: add `class` to each tenant row and
  an `includeClasses` query param (default `["PRODUCTION"]`); response gains `ledgerMrr`
  alongside `mrr`.
- `POST /platform-admin/tenants`: `CreateTenantDto.plan` becomes a live-catalog-validated string
  instead of the stale 3-value enum; add optional `trialLengthDays`.
- `tenant-status.guard.ts`: READ_ONLY allowlist gains `POST /billing/quote` (and any sibling
  route discovered during implementation).
- No new public API for the HQ bootstrap or mirror sync — both are internal scripts/cron, no
  admin UI in this phase (the parent spec's Contacts tab etc. is Phase 5).

## Error handling

- Reconciliation script: any tenant whose derived plan cannot be resolved (legacy `plan` value
  not in the lookup table) is skipped and listed in a separate "needs manual decision" section
  of the dry-run output rather than guessed at or defaulted.
- `TenantMirrorService.upsert()`: wrapped per-tenant in try/catch in the nightly job; a thrown
  error writes to the failure list and does not stop the loop; the synchronous call sites
  (`createTenant`, `updateTenantConfig`) let a mirror-sync failure surface as a warning in the
  response (tenant creation itself must not fail because the mirror sync failed — the mirror is
  best-effort in this phase, hardened once Phase 1 depends on it existing).
- Class change endpoint: rejects a transition into or out of PRODUCTION with no `reason`
  provided (400), consistent with money-affecting admin actions elsewhere.

## Testing

- Unit: `MrrService` scoped-by-class sum (a TEST tenant's subscription must not appear in
  `mrr` or `ledgerMrr`); `TenantMirrorService.upsert()` idempotency (calling twice does not
  create a second `Customer`); the legacy-plan-to-live-catalog-key lookup table's completeness
  (every value in the `TenantPlan` enum has a mapping, asserted by a spec that iterates
  `Object.values()`, per the enum-parity pattern already used elsewhere in the repo).
- DB-lane (`*.db.spec.ts`): reconciliation script's dry-run mode makes no writes (row counts
  unchanged before/after); apply mode creates exactly the rows the dry-run table predicted, run
  against a seeded fixture set mirroring the real book's shape (some Stripe-originated rows
  missing `planKey`, some tenants with no subscription row at all, one TEST tenant that must be
  skipped).
- Manual, hand-checked (not automated, per the parent spec's "sign off on the dry-run diff"
  requirement): the reconciliation table is read by the owner against the known real-tenant set
  before the prod apply run.
- E2E: no new Playwright coverage required this phase (no new UI); confirm the existing
  `01-super-admin.spec.ts` dashboard and tenant-list render checks still pass with `class` in
  the response shape.

## Exit criteria

- `Dashboard`, `Billing Overview`, and every `Tenant 360` page show the identical MRR figure for
  every PRODUCTION tenant, hand-checked against the real book.
- Every PRODUCTION and DEMO tenant has exactly one `TenantSubscription` row with a `planKey`
  that maps to a real catalog entry.
- Selecting Growth anywhere in admin creates and displays a GROWTH-keyed tenant; no page shows a
  plan name that disagrees with the tenant's actual `planKey`.
- An expired-trial tenant reaches the Subscribe button and completes a quote on the local
  compose stack.
- The `routeflow-hq` tenant exists, is INTERNAL-classed, and has exactly one `Customer` mirror
  row (with the correct `representsTenantId`) for every PRODUCTION and DEMO tenant, verified by
  a count query in the PR description.
- Admin sessions in "My Account" show a real device/browser for logins made after this phase
  ships (pre-existing sessions remain "Unknown device", which is expected and not fixed
  retroactively).

## Bookkeeping (lands in this phase's PR, per house convention)

- Code map: update the `api.md` entries for `platform-admin.service.ts`, `mrr.service.ts`, and
  add a new entry for `tenant-mirror.service.ts`.
- Lessons: this phase is data/bootstrap work, not a bug fix, so no lesson entry is owed unless
  something surprising happens during implementation (per the "no junk entry" rule); if the
  reconciliation script's dry-run/apply split saves real pain, that is worth one lesson.
- `docs/product/billing-plans.md`'s "Gaps for a great UX" table gets its CRITICAL row (expired-
  trial cannot subscribe) marked closed with a one-line pointer to this phase's PR.
