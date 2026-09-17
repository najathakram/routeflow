# Lite plan (invite-only, $99/mo) — cross-cutting, 2026-09-15

Split out of `feature-modules-4.md` when it hit the 100,000-byte area cap with zero headroom
(precedent: `api/returns-inline.md`). Cross-cutting: touches `billing/`, `estimates/`,
`recurring-invoices/`, `credit-notes/`, `suppliers/`, `messages/`, `customers/` — see each
module's own part file (`feature-modules-1.md` through `-6.md`) for the module itself; this file
covers only what the Lite lane added on top.

- **Lite-L2 (2026-09-15, WP1-WP13)** — invite-only LITE plan ($99/mo, below STARTER) + 5
  newly-enforced flags (`flag.{estimates,recurring_invoices,credit_notes,suppliers,messaging}`,
  see `pricing-plans.md` §Feature-flag keys). Migration `20260915000000_tenant_plan_lite`.
  `plan-catalog.constants.ts`: `INVITE_ONLY_PLAN_KEYS`/`ALWAYS_ENFORCED_PLAN_KEYS`/
  `inviteOnlyCheckoutAllowed()`; `PLAN_KEYS` leads `"LITE"`. New `plan-flag-policy.ts` (dark-flag
  policy split out of `plan-flag.guard.ts`; REMOVE by 2026-10-01). Invite-only refused on
  `subscribe`/`upgrade`/`downgrade` and hidden from the public catalog; `getSubscription()`
  gains `flags`/`paymentRequired`; new no-body `POST /billing/subscription/checkout`. New v12
  catalog (`plan-catalog-v{11,12}.definitions.ts`, `publish-plan-catalog-v12.ts`,
  `db:publish:catalog:v12`) adds LITE + the 5 flags catalog-wide; those 5 flags' controllers
  (`estimates`, `recurring-invoices`, `credit-notes`, `suppliers`, `messages`) + `customers`'
  portal endpoints gained a matching `PlanFlagGuard`/`RequirePlanFlag`. Specs:
  `estimates.plan-gate.spec.ts`, `recurring-invoices.plan-gate.spec.ts`,
  `credit-notes.plan-gate.spec.ts`, `suppliers.plan-gate.spec.ts`, `messages.plan-gate.spec.ts`,
  `customers.portal-plan-gate.spec.ts`, `plan-flag-guard-module-import.spec.ts`.
- **WP14 / B445 (2026-09-15) — `onCheckoutCompleted`'s upsert never wrote `planKey`** (create
  branch read the wrong metadata key — `metadata.plan`, always undefined; checkout stamps
  `metadata.planKey` — so neither branch wrote `planKey`), starving `emitPayingDelta`/billing-cron's
  MRR filter forever. Pre-existing prod defect; Lite's self-checkout just depends on it. Fix:
  `resolvedPlanKey = metadata.planKey ?? metadata.plan ?? null`; `resolvedBasePrice` via
  `this.pricing.resolveCatalogPricing(tenantId)`, try/catch'd (webhook must never throw
  uncaught). Create writes both fields unconditionally; UPDATE uses present-only spreads (never
  null-overwrites an existing value). **No new idempotency mechanism** — the existing
  `transitionAndEmit` CAS is still the only gate. No backfill. Spec: `billing.service.spec.ts`'s
  `onCheckoutCompleted — B445` describe.
- **Fix-round findings 1-7 (2026-09-15, owner-approved scope)** — `apps/api/prisma/`
  `plan-catalog-v11.definitions.ts`'s `ENTERPRISE_FLAGS` (finding 3) is now a FROZEN 13-key
  literal, not derived from the live `FLAG_KEYS` array (that derivation silently grew v11's
  ENTERPRISE from 13→18 flags whenever WP1 added a new flag key — pinned by a new test in
  `plan-catalog-v12.spec.ts`). `billing-cron.service.ts`'s `applyScheduledDowngrades` (finding 1)
  re-pins `planVersionId` to whichever catalog version actually defines the downgrade target
  (falls back from the tenant's pinned version to the published one) and throws a new
  `PlanNotInCatalogError` (`plan-catalog.constants.ts`, alongside `UnknownPlanKeyError`) — caught
  by the same per-tenant skip-and-log as an unresolvable plan key — instead of silently pricing
  an unresolvable target as $0. `platform-admin.service.ts` gained a shared private
  `resolvePublishedPlan(planKey)` guard (finding 2) used by `createTenant`, `updatePlan`, and
  `activateManualSubscription` alike — the last of these previously wrote no catalog validation
  and no `planKey`/`planVersionId` at all. `billing.service.ts`'s `onCheckoutCompleted` (finding 4) now preserves an existing `priceOverrideMonthly`/`priceOverrideAnnual` negotiated override —
  it no longer overwrites `basePriceSnapshot` from `resolveCatalogPricing()` when one is set.
  `settings-billing.controller.ts`'s `createCheckout` (finding 6) now checks
  `inviteOnlyCheckoutAllowed(planKey, INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT)` and refuses when the
  kill switch is off, instead of only hiding the web button (test mocks the module: `jest.mock`
  overriding `INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT`, since the controller must read the constant
  as an imported binding — not the function's own default param — for the lever to be mockable).
  Finding 5 (web+mobile, fail-open on absent `flags`) is documented in `packages.md` under
  `api/billing.ts`'s `SubscriptionView`. Finding 7: the 6 new `*.plan-gate.spec.ts` files (listed
  above) failed `tsc` under real project options (TS2352 on `as Record<string, unknown>` prototype
  casts, invisible to `check-types` because its config excludes `*.spec.ts`) — fixed to
  `as unknown as Record<string, unknown>`; proven by a new scoped config,
  `apps/api/tsconfig.plan-gate-specs.json` (extends `tsconfig.json`, `include`s only these 6
  files), run via `npx tsc --noEmit -p tsconfig.plan-gate-specs.json`. Findings 8-10 are tracked
  follow-ups, deliberately not fixed here.
- **PREPIN_DARK_FLAGS (P0, 2026-09-17, #806)** — prod flipped `PLAN_FLAG_ENFORCEMENT=on` with
  #777's five v12 flags (`flag.{estimates,recurring_invoices,credit_notes,suppliers,messaging}`)
  still missing from the pinned v11 catalogs, so every non-LITE tenant without a manual grant was
  denied these features outright. `plan-flag-policy.ts`'s `isDarkFlag()` now ORs in a new,
  unconditional `PREPIN_DARK_FLAGS` set (the same five keys) ahead of the `DARK_PLAN_FLAGS &&
!isPlanFlagEnforcementOn()` check — these five stay dark (courtesy-allowed) regardless of the
  kill switch until the catalogs are re-pinned with them; `allowsFlag()`'s always-enforced-plan
  exclusion is untouched, so LITE tenants remain gated normally. `subscription.service.ts`'s
  client-visible `flags` list already goes through `allowsFlag()`, so the web lock sees the fix
  too, no separate change needed there. No migration, no registry change — an INTERIM patch per
  [[project_entitlements_one_rule_2026-09-17]] (PLAN_FLAG_ENFORCEMENT stays off going forward;
  entitlements consolidate to one preset+grants−denies rule in a later PR-0, which deletes this
  set). Specs: `plan-flag-policy.spec.ts` (a v11 SCALE tenant sees all five with enforcement ON; a
  LITE tenant does not), `subscription.service.spec.ts`, `feature-registry.spec.ts`.
- **B450 (2026-09-17) — diagnostic scripts for a Lite-L2-flag-shaped 403 (`e2e-routeflow`
  `POST /recurring-invoices` red since #777)**, all going through the REAL platform-admin/billing
  API over HTTP rather than a raw DB read or a hand-rolled mirror of `EntitlementsService` (unlike
  `audit-tenant-entitlements.mjs`, which has to reimplement that logic in SQL) — so a read can
  never drift from what a live admin click / the tenant's own dashboard actually sees. Shared
  client: **`scripts/lib/platform-admin-http.mjs`** — `resolveApiBase()` (`API_URL`, default
  `localhost:3000/api/v1`), `loginAsSuperAdmin()` (`SUPER_ADMIN_USERNAME`/`_PASSWORD` env, asserts
  role), `findTenantBySlug()` (exact case-insensitive match, throws on zero/multiple),
  `getTenantDetail()`, `getResolvedSubscription()` (impersonates the tenant's `TENANT_ADMIN` —
  audit-logged by the API as `IMPERSONATION_STARTED`, the one side effect a read makes — then
  calls `/billing/subscription` as them), `updateTenantPlan()` (`PATCH
/platform-admin/tenants/:id/plan`), `LITE_L2_FLAGS` (the 5 flags, display labels only).
  **`scripts/report-tenant-plan.mjs <slug>`** — read-only: prints the legacy `Tenant.plan` enum,
  the raw `TenantSubscription` row, the RESOLVED planKey/flags, and a granted/missing table for
  the 5 Lite-L2 flags; NOT restricted to approved test tenants (a read, not a test/seed/cleanup
  action). **`scripts/set-e2e-tenant-plan.mjs --slug <slug> --plan <PLAN> [--apply]`** — the
  paired WRITE script, dry-run by default; calls `assertTestTenant()` BEFORE any network call (no
  override — can only ever target `e2e-routeflow`/`test`/`routeflow-demo`/`qa-*`/`e2e-*`/
  `ux-audit-*`), prints current-vs-would-be resolved state, and only writes with `--apply`.
