# Plan: enforce plan entitlement flags behind a default-off kill switch

> Status: IMPLEMENTED (2026-08-23, autopilot; clean=true, 12 findings fixed, gate green 2613 tests; INERT until PLAN_FLAG_ENFORCEMENT=on) · Authored 2026-08-23 from the verified 2026-08-22 flag-wiring recon. This file is
> the ONLY context implementers receive. The wiring map below is CONFIRMED against the code — do
> not re-derive it, implement it.

## ⚠️ WORKTREE — read before anything else

ALL work happens in:

```
C:\ClaudeCode\routeflow\.claude\worktrees\ap-flag-wiring
```

Your process may start in `C:\ClaudeCode\routeflow` (main checkout) — do NOT touch files there.
`cd` into the worktree before ANY command; ABSOLUTE paths under the worktree for every file
read/edit. Branch is already `feat/enforce-plan-flags`; do not commit, stage or push. NEVER run
`railway` or anything that reaches production — the audit script in WP4 is WRITTEN here, never
executed.

## Objective

The plan catalog defines 11 entitlement flags; NONE is enforced server-side (the only live gate is
`@RequireAddon("tobacco_dealer")`). Plan tiers do not exist at runtime. This PR wires enforcement —
**shipping INERT**: a `PLAN_FLAG_ENFORCEMENT` env (default `off`) makes every new gate a no-op, so
merging can never break a live tenant. The owner flips it on only after running the WP4 audit
against prod.

Existing machinery (all in `apps/api/src/billing/`): `EntitlementsService` (resolve/hasFlag,
cached, server-authoritative), `PlanFlagGuard` + `@RequirePlanFlag` decorator
(`plan-flag.guard.ts`, `require-plan-flag.decorator.ts`), structured `PLAN_GATE` 403 body
(`plan-gate.ts`: LOCKED_PAGE / INLINE_RESOLVE).

## Known catalog drift (context for comments/PR body — verified, do not re-check)

v7→v8 grant changes: `flag.analytics` and `flag.pricing_tiers` widened DOWN a tier in v8 (GROWTH+)
vs v7 (BUSINESS+ only — a v7 TEAM tenant would newly lose them); `flag.returns` is granted to v8
STARTER but not v7 STARTER; `flag.dispatch_live` is granted to NOBODY in v8. 19 live tenants are
grandfathered on v7. Always reason through `normalizePlanKey` (TEAM→GROWTH, BUSINESS→SCALE).

## Work packages

### WP1 — kill switch in the guard + guard specs (files: `apps/api/src/billing/plan-flag.guard.ts`, `apps/api/src/billing/plan-flag.guard.spec.ts`)

Read the guard first. Add, at the top of its `canActivate`:

```ts
// Release toggle (REMOVE by 2026-10-01): plan-flag enforcement ships dark.
// "on" = enforce; anything else = allow everything. The owner flips this on
// only after the prod entitlement audit (scripts/audit-tenant-entitlements.mjs)
// proves no live tenant loses a surface it uses today.
if ((process.env.PLAN_FLAG_ENFORCEMENT ?? "off") !== "on") return true;
```

Extend `plan-flag.guard.spec.ts`: with `PLAN_FLAG_ENFORCEMENT=on`, flag present → allow, flag
absent → 403 whose body is the `buildPlanGateBody` shape; with it unset/off → always allow
(restore `process.env` after each test). Also assert a SCALE-plan entitlement set (all v8 flags)
passes every gate added in this plan.

### WP2 — controller gates (files: `apps/api/src/analytics/analytics.controller.ts`, `apps/api/src/vendor-bills/vendor-bills.controller.ts`, `apps/api/src/import/migration.controller.ts`, `apps/api/src/inventory/inventory.controller.ts`, `apps/api/src/customers/customers.controller.ts`, `apps/api/src/bookkeeping/bookkeeping.controller.ts`, `apps/api/src/returns/returns.controller.ts`)

Apply EXACTLY this map — nothing more, nothing less. Check each controller's existing
`@UseGuards(...)` includes (or gains) the `PlanFlagGuard` in whatever registration style the
codebase uses (read how `AddonGuard`/`@RequireAddon` is wired on
`apps/api/src/tobacco/tobacco.controller.ts` and mirror the mechanism; if the guard is global,
decorators suffice).

- CLASS-level `@RequirePlanFlag("flag.analytics")` on `AnalyticsController` (all 16 endpoints are
  analytics-only; no DRIVER/CUSTOMER traffic).
- CLASS-level `@RequirePlanFlag("flag.ap_bills")` on `VendorBillsController` (OPERATOR-only
  end to end).
- CLASS-level `@RequirePlanFlag("flag.import_integrations")` on `MigrationController` ONLY. The
  CSV import controllers (`import.controller.ts`, `batch`, `alias`, `numbering`, `resolution`)
  stay UNGATED — core onboarding for every tenant.
- METHOD-level `@RequirePlanFlag("flag.forecasting")` on exactly two `InventoryController`
  handlers: the `GET inventory/forecasting` handler and the
  `PATCH inventory/products/:productId/reorder-settings` handler. Everything else on that
  controller is core inventory.
- METHOD-level `@RequirePlanFlag("flag.pricing_tiers")` on exactly the three
  `/customers/:id/prices*` handlers in `CustomersController` (~L228-243: get, upsert, delete).
  Note they are `@Roles(OPERATOR, DRIVER)` — leave roles untouched.
- METHOD-level `@RequirePlanFlag("flag.reports")` on each `reports/*` GET handler in
  `BookkeepingController` (~18 of them: pl, aging, cashflow, ar-aging-invoices,
  sales-by-customer, sales-by-item, customer-balance, invoice-details, bad-debts,
  payments-received, time-to-get-paid, expense-details, expenses-by-category,
  expenses-by-customer, sales-by-driver, ar-aging-details, estimate-details, refund-history,
  receivable-summary — enumerate from the actual controller, gate every `reports/` route). The
  core money endpoints on the SAME controller (summary, dashboard, transactions, expenses,
  bills/bulk-mark-paid) stay UNGATED. `finance-dashboard` stays UNGATED (owner decision pending —
  add a one-line comment saying so).
- CLASS-level `@RequirePlanFlag("flag.returns")` on `ReturnsController`, with a comment: it serves
  CUSTOMER and DRIVER roles too, and must stay behind the kill switch until the v7-STARTER audit
  question is answered.

DO NOT decorate anything for: `flag.api_sso` (no SSO code exists), `flag.settlement` (no driver
run-settlement feature exists — do not confuse with Stripe payment settlement),
`flag.dispatch_live` (v8 grants it to nobody; dispatch is deliberately UI-gated by the
`developer_mode` addon; enforcing would break the e2e canary and demo tenant). These three are
documented in WP5's doc comment instead.

Module wiring: any module whose controller now uses the guard/decorator must import whatever
module exports `PlanFlagGuard`/`EntitlementsService` (check how `billing.module.ts` /
`entitlements.module.ts` export them and how tobacco's module imports the addon guard — mirror it).

### WP3 — service-level gate for credit limits (files: `apps/api/src/orders/orders.service.ts`, `apps/api/src/orders/orders.module.ts`, `apps/api/src/orders/orders.service.spec.ts`)

`creditLimit` enforcement is `OrdersService.assertWithinCreditLimit` (private, ~L3517, called from
three internal sites) — no route of its own, so no decorator. Inject `EntitlementsService` into
`OrdersService` (add the module import if needed) and at the top of `assertWithinCreditLimit`:

```ts
// flag.credit_limits gates the CHECK, not customer CRUD: an unflagged tenant's
// creditLimit values persist but are inert. Same kill switch as PlanFlagGuard.
if ((process.env.PLAN_FLAG_ENFORCEMENT ?? "off") !== "on") {
  // enforcement dark — legacy behavior: always check
} else if (!(await this.entitlements.hasFlag(tenantId, "flag.credit_limits"))) {
  return;
}
```

CAREFUL: legacy behavior today is that the check ALWAYS runs (there is no flag). The kill-switch-off
path must therefore keep running the check — the snippet above encodes exactly that; do not invert
it. Spec: enforcement on + flag absent → an over-limit order passes (check skipped); enforcement on

- flag present → over-limit order still rejected; enforcement off → over-limit rejected (legacy).

### WP4 — read-only prod audit script, written NOT run (files: `apps/api/scripts/audit-tenant-entitlements.mjs`)

New script, read-only. It will be run by the OWNER later via
`railway run --service postgres node apps/api/scripts/audit-tenant-entitlements.mjs` — never by
you. Mechanics (mirror an existing script in `apps/api/scripts/` that talks to the prod DB for the
connection pattern): assemble the URL from `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`/
`RAILWAY_TCP_PROXY_DOMAIN`/`RAILWAY_TCP_PROXY_PORT` (that service does NOT expose `DATABASE_URL`);
resolve `pg` via `createRequire` against `apps/api/package.json` if the template does. For every
ACTIVE tenant print one row: tenantId, slug, planVersionId, planKey (normalized), flags[],
addons[] — computed the same way `EntitlementsService.compute` does (replicate the
plan-definition + addon-grants union in plain SQL/JS; read `entitlements.service.ts` and
`plan-catalog.constants.ts` for the exact rules including the published-catalog fallback for
unknown SKUs). Then a `## DISCREPANCIES` section flagging: any v7-pinned tenant whose normalized
tier would lose `flag.analytics`/`flag.pricing_tiers`/`flag.returns` under the new gates, and any
tenant resolving zero flags. Plain console.table/text output. No writes anywhere; no tenant slugs
hardcoded.

### WP5 — web 403 handling + docs (files: `apps/web/lib/api/client.ts`, `apps/web/components/PlanGateNotice.tsx`, `apps/api/src/billing/plan-catalog.constants.ts`)

1. Find how the web api client surfaces errors (`apps/web/lib/api/client.ts` or wherever the
   axios/fetch wrapper lives — locate it first; the file list may need adjusting, report if so).
   Add minimal handling: when a response is 403 with body `code === "PLAN_GATE"`, surface a
   friendly notice (toast or inline component `PlanGateNotice.tsx`: the body's `message` + an
   "Upgrade" hint from `upgrade.planKey`/`addonSku`) instead of a raw failure. Keep it small —
   full LOCKED_PAGE/INLINE_RESOLVE page states are out of scope; report in your notes what exists
   today (grep web for `PLAN_GATE` first — if a handler already exists, extend rather than
   duplicate).
2. In `plan-catalog.constants.ts`, add a short doc comment block above the flag list documenting:
   which flags are now enforced (list), which are reserved-unimplemented (`flag.api_sso`,
   `flag.settlement`) and why `flag.dispatch_live` is deliberately unenforced.

## Acceptance criteria

1. With `PLAN_FLAG_ENFORCEMENT` unset, EVERY existing spec passes with zero behavioral change —
   this is the whole point. The full suite green proves it.
2. With it `on` (specs only): gated endpoints 403 with the PLAN_GATE body when the flag is absent
   and pass when present; credit-limit check skips for unflagged tenants; SCALE entitlements reach
   analytics/reports/returns.
3. No migration, no schema change, no prod access, no `railway` invocation anywhere in the run.
4. The three reserved flags are documented, not decorated.

## Verification commands (from the worktree root)

```
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-flag-wiring && npm run check-types
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-flag-wiring && npm run lint
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-flag-wiring && npm run test
```

## Out of scope

Turning enforcement on · running the audit · catalog v7/v8 changes · mobile 403 UI ·
`.claude/code-map` (orchestrator updates it).
