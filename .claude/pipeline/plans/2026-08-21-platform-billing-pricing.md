# Plan: Platform billing — catalog-driven Stripe prices, custom tenant fees, annual prepay

> Authored by Fable 5, 2026-08-21. Status: APPROVED. This file is the ONLY context the
> implementation and review agents receive. It must stand alone.

## ⚠️ WORKING TREE

All paths are relative to the git worktree
`C:\ClaudeCode\routeflow\.claude\worktrees\stripe-connect` (branch
`feat/platform-billing-pricing`, forked from current master). Edit ONLY under that absolute
path. It has its own complete `node_modules`; run every command from inside it.

## Objective

RouteFlow charges tenants (platform SaaS billing). Today checkout reads env vars
(`STRIPE_PRICE_STARTER`/`PROFESSIONAL`/`ENTERPRISE`) that point at hand-created Stripe
Prices — GROWTH/SCALE (the real v8 mid tiers) cannot check out at all
(`getPriceIdForPlan` throws on their legacy enum shadows TEAM/BUSINESS), and price changes
require touching Stripe + env. Invert it:

1. **Prices are data.** `PlanDefinition.monthlyPrice`/`annualPrice` (plans-as-data, already
   in schema) are the source of truth; a per-tenant override beats the catalog.
2. **Stripe follows.** Checkout sessions send inline `price_data` (amount + recurring
   interval) computed at click time. No env price IDs, nothing to sync in the dashboard.
3. **Annual prepay = 2 months free.** Effective annual price = `annualPrice ?? monthlyPrice * 10`.
4. **Owner decision — price changes hit ACTIVE subscriptions at the NEXT BILLING CYCLE**
   (`proration_behavior: "none"`), never mid-period.
5. Super-admin UI edits plan prices and per-tenant custom fees; both fan out to live
   Stripe subscriptions automatically.

Catalog numbers stay 99/249/499 (owner decision) — the machinery makes future changes a
form edit.

## Ground truth (verified in code — do not re-derive)

- `apps/api/src/billing/stripe.service.ts` — `client` getter (throws when unconfigured),
  `isConfigured`, `getPriceIdForPlan(plan)` at :118-130 (env switch; DELETE its use, keep
  env vars declared in configuration.ts harmlessly).
- `apps/api/src/billing/billing.service.ts` — `createCheckoutSession` (:171-208) is the only
  caller of `getPriceIdForPlan`; reads `tenant.plan` (LEGACY enum — TEAM/BUSINESS shadows).
  `handleWebhookEvent` (:241-268) handles `checkout.session.completed`,
  `invoice.payment_succeeded/failed`, `customer.subscription.updated/deleted`.
- Reachable from: `POST /billing/checkout` (`billing.controller.ts`, SuperAdminGuard) and
  `POST /platform-admin/tenants/:id/billing/checkout` (`platform-admin.controller.ts:261-266`,
  wired to the admin tenant page `apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx`).
- Plans-as-data: `apps/api/src/billing/plan-catalog.service.ts` + `plan-catalog.constants.ts`
  (`normalizePlanKey`, `planKeyToEnum`, keys STARTER|GROWTH|SCALE|ENTERPRISE). `PlanDefinition`
  rows hang off a `PlanVersion`; `Tenant.planVersionId` pins each tenant's version (19 tenants
  grandfathered on v7 — price resolution MUST read the tenant's own pinned version, not
  latest). `PlanDefinition` has `planKey, monthlyPrice Decimal?, annualPrice Decimal?, isCustom`.
- `TenantSubscription` (schema ~:470-505): `stripeSubId String?`, `planKey String?`,
  `externalPayment` fields. NO price-override or interval columns yet.
- `SubscriptionMutationService` (tenant self-service subscribe/upgrade) deliberately never
  touches Stripe — DO NOT change that in this batch.
- Money-in-cents: Stripe wants integer cents — `Math.round(Number(decimal) * 100)`.
- Jest: `rootDir` is `src` — run `npx jest billing platform-admin` style patterns, NEVER a
  `src/…` prefix (matches nothing). Full API tsc: `npx tsc -p tsconfig.build.json --noEmit`
  from `apps/api`.

## Work packages (file lists are DISJOINT; do not touch files outside your package)

### WP1 — Schema + migration (additive only)

- **files:** `apps/api/prisma/schema.prisma`,
  `apps/api/prisma/migrations/20260829000000_tenant_price_override/migration.sql`
- On `TenantSubscription` add:
  - `priceOverrideMonthly Decimal? @db.Decimal(10, 2)` — custom monthly fee; null = catalog.
  - `priceOverrideAnnual  Decimal? @db.Decimal(10, 2)` — custom annual fee; null = derive.
  - `billingInterval      String?` — "month" | "year", stamped at checkout completion.
- Migration: hand-written `ALTER TABLE "TenantSubscription" ADD COLUMN IF NOT EXISTS …`
  (three columns, no defaults needed, no existing-row rewrite). Folder name EXACTLY
  `20260829000000_tenant_price_override` (sorts after every existing 202608\* migration).
- After editing schema run `npx prisma generate --schema apps/api/prisma/schema.prisma`
  from the worktree root so later packages compile.

### WP2 — Pricing resolution + Stripe checkout/sync (API core)

- **files:** `apps/api/src/billing/platform-pricing.service.ts` (new),
  `apps/api/src/billing/billing.service.ts`, `apps/api/src/billing/billing.module.ts`
- `PlatformPricingService`:
  - `resolveTenantPricing(tenantId)` → `{ planKey, planName, monthly: number, annual: number,
source: "override" | "catalog", currency: "usd" }`.
    Order: `TenantSubscription.priceOverrideMonthly` (and `priceOverrideAnnual ?? monthly*10`)
    when override set → else the tenant's PINNED PlanVersion's `PlanDefinition` for its
    current planKey (`normalizePlanKey(tenantSubscription.planKey ?? tenant.plan)`):
    `monthly = Number(monthlyPrice)`, `annual = Number(annualPrice) || monthly * 10`.
    Throw BadRequest with a clear message when no price is resolvable (e.g. ENTERPRISE /
    `isCustom` plans with no override — the admin must set a custom fee first).
  - `checkoutPriceData(tenantId, interval: "month" | "year")` → Stripe `price_data` object:
    `{ currency, product_data: { name: \`RouteFlow ${planName} — ${interval === "year" ?
    "annual" : "monthly"}\` }, unit_amount: Math.round((interval === "year" ? annual :
    monthly) \* 100), recurring: { interval } }`.
- `BillingService.createCheckoutSession(tenantId, interval = "month")`:
  replace the `getPriceIdForPlan` line-item with `price_data` from the service above;
  `mode: "subscription"`, metadata `{ tenantId, planKey, interval }`. Keep the existing
  customer-ensure logic and URLs. Remove the import/usage of `getPriceIdForPlan` (leave the
  method in stripe.service.ts but mark `@deprecated — env-price path replaced by
PlatformPricingService`, so nothing else breaks).
- `BillingService.syncStripeSubscriptionPrice(tenantId)`:
  - No `stripeSubId` or subscription not active → return `{ synced: false, reason }`.
  - Else `subscriptions.retrieve`, then `subscriptions.update(subId, { items: [{ id:
items.data[0].id, price_data: <from resolver, interval = existing item's interval ??
stored billingInterval ?? "month"> }], proration_behavior: "none" })` — **"none" is the
    owner-decided next-cycle semantics; never "create_prorations"**. Record a `BillingEvent`
    (follow the existing BillingEvent creation pattern in this module) with old/new amount.
  - Stripe price_data inside subscriptions.update requires a `product`: reuse the
    subscription item's existing `price.product` id when present; otherwise fall back to
    `product_data` — check the SDK typing and do what compiles against stripe v22.
- Webhook `checkout.session.completed`: also persist `billingInterval` from
  `session.metadata.interval` onto TenantSubscription (find the existing upsert and extend it).

### WP3 — Admin API endpoints

- **files:** `apps/api/src/platform-admin/platform-admin.controller.ts`,
  `apps/api/src/platform-admin/platform-admin.service.ts`,
  `apps/api/src/platform-admin/dto/update-tenant-price.dto.ts` (new),
  `apps/api/src/platform-admin/dto/update-plan-prices.dto.ts` (new)
- All under the existing `SuperAdminGuard` controller:
  - `GET /platform-admin/tenants/:id/billing/pricing` → resolver output + whether a live
    Stripe subscription exists (`stripeSubId` + status) so the UI can explain what "apply"
    will do.
  - `PATCH /platform-admin/tenants/:id/billing/price-override` body
    `{ monthly?: number|null, annual?: number|null }` (null clears) — class-validator:
    optional, min 0, max 100000. Saves, then calls `syncStripeSubscriptionPrice` and returns
    its result alongside the new resolution.
  - `POST /platform-admin/tenants/:id/billing/checkout` — EXTEND the existing endpoint to
    accept `{ interval?: "month" | "year" }` (default month).
  - `PATCH /platform-admin/plans/:planKey/prices` body `{ monthly: number, annual?: number|null }`
    — updates the CURRENT (latest) PlanVersion's PlanDefinition row for that key, then fans
    out `syncStripeSubscriptionPrice` to every tenant on that planKey **whose subscription
    has NO price override and whose pinned version is the latest** (overrides and
    grandfathered versions keep their own pricing). Best-effort loop (log failures, don't
    abort); return `{ updated, synced, failed }` counts.
- Delegate real logic to `PlatformPricingService`/`BillingService` — controllers stay thin.

### WP4 — Admin web UI

- **files:** `apps/web/lib/api/platform-pricing.ts` (new),
  `apps/web/app/(platform-admin)/admin/tenants/[id]/_components/TenantPricingCard.tsx` (new),
  `apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx` (mount the card),
  `apps/web/app/(platform-admin)/admin/plans/page.tsx` (new)
- Hooks file: TanStack Query via the platform-admin api client already used by
  `admin/tenants/[id]/page.tsx` (mirror its existing fetch pattern EXACTLY — find how that
  page calls `/platform-admin/*` and reuse; do NOT invent a new client).
- `TenantPricingCard`: shows resolved monthly/annual + `source` badge ("Custom fee" vs
  "Catalog"), the live-subscription state, inputs to set/clear the custom fee (confirm
  dialog restating: "applies from the next billing cycle"), interval picker + "Create
  checkout session" button (reuses the existing checkout mutation on that page if present —
  extend it with interval). Replace/absorb the page's existing "Create Checkout Session"
  button so there is ONE checkout entry point.
- `admin/plans/page.tsx`: table of the latest PlanVersion's plans (key, name, monthly,
  annual with the "= 10× monthly" placeholder when null) with inline edit + save per row;
  after save, toast the `{ updated, synced, failed }` fan-out counts. Add a nav link
  wherever the platform-admin shell lists sections (find the existing admin nav and add
  "Plans & Pricing").
- Any `useSearchParams` usage MUST sit under a Suspense boundary (Next 14 production build
  fails otherwise — CI does not run `next build`, Railway does). Prefer not using it at all.

### WP5 — Specs

- **files:** `apps/api/src/billing/platform-pricing.service.spec.ts` (new),
  `apps/api/src/billing/billing.service.spec.ts` (extend if it exists; create focused specs
  otherwise — check first)
- `Test.createTestingModule`, collaborators mocked at the module boundary (mirror
  `apps/api/src/payment-requests/payment-requests.service.spec.ts` style, incl. the
  createMockPrisma helper in `apps/api/src/testing/prisma-mock.ts`).
- Cover: override beats catalog; annual falls back to 10× monthly; annual override wins over
  the fallback; unresolvable price (isCustom, no override) throws; checkout builds
  `price_data` with integer cents (99 → 9900, 249 annual fallback → 249000) and
  `recurring.interval`; sync uses `proration_behavior: "none"` and skips when no
  `stripeSubId`; plan-price fan-out excludes tenants with overrides.
- NO snapshot tests. NO Vitest.

## Acceptance criteria

1. Admin can check out a GROWTH or SCALE tenant (month or year) — no env price vars involved.
2. Setting a tenant custom fee updates its live Stripe subscription with
   `proration_behavior: "none"` and the UI says "from the next billing cycle".
3. Editing a plan price fans out only to latest-version tenants without overrides.
4. Annual amounts are exactly 10× monthly when `annualPrice` is null.
5. Grandfathered (v7-pinned) tenants resolve THEIR version's prices, untouched by v8 edits.
6. All money amounts sent to Stripe are integer cents.
7. `SubscriptionMutationService`, `payment-requests/*`, `stripe-connect/*` are untouched.

## Verification commands (from the worktree root)

- `cd apps/api && npx tsc -p tsconfig.build.json --noEmit`
- `cd apps/api && npx jest billing platform-admin` (jest rootDir is `src` — no `src/` prefix)
- `npm run check-types` (all workspaces — covers web)

## Risks

- Stripe SDK v22 typing for `price_data` inside `subscriptions.update` items — resolve
  against the installed SDK, not memory; the repo uses `require("stripe")` untyped in
  stripe.service.ts, so `as any` at the call boundary is acceptable if typings fight.
- The admin tenant page is large (~2600 lines); mount the new card surgically, do not
  reformat the file.
- Fan-out loops must never throw past the first failure — report counts.
