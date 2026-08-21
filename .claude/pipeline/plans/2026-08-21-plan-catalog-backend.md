# Plan: Publish catalog v8 — Starter/Growth/Scale/Enterprise at $99/$249/$499 + customer axis

> Authored by Fable 5 on 2026-08-21. Status: APPROVED
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".

## Objective

RouteFlow's plans-as-data catalog is **already live in production**: `PlanVersion` **v7 is PUBLISHED** (2026-07-07) with four definitions — STARTER "Starter" $59, TEAM "Team" $149, BUSINESS "Business" $349, ENTERPRISE "Enterprise" (custom) — plus 7 `AddonSku` rows. Do NOT treat the catalog as unseeded and do NOT create a "v1".

The owner has renamed and repriced the ladder. This PR publishes a **new catalog version (v8)** through the existing draft→publish lifecycle, renames the middle two plan keys, and adds the customer-count axis the new pricing is built on. It also stops the platform dashboard pricing tenants from a hardcoded stopgap constant.

**Authoritative target ladder (these become catalog ROWS — editable later without code):**

| planKey    | name       | monthlyPrice            | annualPrice | customersIncluded | seatsIncluded    |
| ---------- | ---------- | ----------------------- | ----------- | ----------------- | ---------------- |
| STARTER    | Starter    | 99                      | 990         | 100               | 3                |
| GROWTH     | Growth     | 249                     | 2490        | 250               | 10               |
| SCALE      | Scale      | 499                     | 4990        | 500               | 25               |
| ENTERPRISE | Enterprise | null (`isCustom: true`) | null        | null (unlimited)  | null (unlimited) |

Annual = monthly × 10 — compute it with the existing `annualPrice()` helper in `apps/api/src/billing/billing-math.ts`, never hardcode.

**The rename is data-safe (verified against production):** only three `TenantSubscription` rows carry a `planKey` and all three are `ENTERPRISE` (the owner's own `affa`, `test`, `e2e-routeflow`). **Zero tenants are on TEAM or BUSINESS**, so renaming those keys cannot orphan a paying customer. v7 keeps its historical TEAM/BUSINESS rows; code must tolerate reading them rather than rewriting history.

Admin UI, marketing-site pricing, and tenant plan pickers are a SEPARATE follow-up PR. **Do not touch `apps/web` or `apps/mobile` in this PR.**

## Constraints & conventions

- npm + Turbo monorepo. API: NestJS 11 + Prisma 7 (`apps/api`). Tests: Jest (`*.spec.ts`), `Test.createTestingModule`, mock at the module boundary. NO Vitest, NO snapshot tests.
- Prettier: semicolons, double quotes, printWidth 100, trailing commas.
- **Money discipline (CLAUDE.md):** monetary math goes through `apps/api/src/common/pricing.ts`; `roundMoney` every monetary write.
- **Never execute a migration.** Author the migration file only. Applying it is a separate human-run step.
- Do NOT touch: `apps/web/**`, `apps/mobile/**`, Stripe files (`stripe.service.ts`, `billing.service.ts` webhooks), `PlanFlagGuard` wiring (no controller gets gated here).
- Never reference live client tenant names in code, tests, or fixtures.

## Facts verified against the production database (trust these)

- `PlanVersion` v7 = PUBLISHED, the only version. 4 `PlanDefinition` rows, 7 `AddonSku` rows.
- Existing SKU prices to CARRY FORWARD unchanged into v8: `SEAT_EXTRA` $12 (PER_USER, SEATS, cap 1, stackable), `BUYER_PORTAL` $49 (FLAT), `REGULATED_ITEMS` $39 (FLAT), `OCR_PACK_250` $19 (FLAT, SCANS, cap 250, stackable), `FORECASTING` $19 (FLAT), `ROUTE_EXTRA` $15 (PER_ROUTE, ROUTES, cap 1, stackable), `MSG_BUNDLE_500` $10 (FLAT, MSGS, cap 500, stackable).
- v7 feature-flag counts per plan: Starter 1, Team 7, Business 12, Enterprise 14 — preserve this ascending shape in v8.
- `TenantSubscription` rows: 3, all `planKey = ENTERPRISE`, `basePriceSnapshot` null, `cycle` MONTHLY.

## Read before writing

- `apps/api/src/billing/plan-catalog.constants.ts` — `PLAN_KEYS`, `planRank()`, `FLAG_KEYS` (14), `ADDON_SKUS` (7), `METER_KEYS`, `BILLING_EVENTS`, `planKeyFromEnum()`, `FLAG_TO_ADDON_SKU`, `LEGACY_ADDON_KEY_TO_SKU`, `addonSkuCode()`.
- `apps/api/src/billing/plan-catalog.service.ts` — `getPublishedVersion()`, `getVersionForTenant()`, `getPublicCatalog()`, `createDraft()`, `updateDefinition()`, `updateSku()`, `publish()`, `discardDraft()`. **`publish()` supersedes the previous version and does NOT re-pin already-pinned tenants** — that is the grandfathering mechanism; rely on it.
- `apps/api/src/billing/entitlements.service.ts`, `meter.service.ts` (SEATS live-occupancy pattern), `billing-math.ts`, `plan-gate.ts` (`buildPlanGateBody`), `billing-cron.service.ts` (`expireGrace` + its grace-period constant).
- `apps/api/src/platform-admin/plan-pricing.constant.ts`, `platform-admin.service.ts` (`getStats()`), `platform-admin.controller.ts`.
- `apps/api/src/customers/customers.service.ts` `create()`, and the CSV/bulk import path.
- `apps/api/prisma/migrations/` — existing naming convention.

## Work packages

### WP1 — Plan-key rename, customer axis, schema

- **files:** `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/<timestamp>_plan_catalog_customers_axis/migration.sql` (new), `apps/api/src/billing/plan-catalog.constants.ts`, `apps/api/src/billing/billing-math.ts`
- **brief:**
  1. `schema.prisma`: add `CUSTOMERS` to `enum MeterKey`; add `customersIncluded Int?` to `model PlanDefinition` (null = unlimited). Nothing else. All additions nullable.
  2. Hand-author the migration SQL: `ALTER TYPE "MeterKey" ADD VALUE 'CUSTOMERS';` as its own statement at the top (Postgres cannot always add an enum value inside a transaction — do NOT wrap the file in BEGIN/COMMIT), then `ALTER TABLE "PlanDefinition" ADD COLUMN "customersIncluded" INTEGER;`. Timestamp-prefixed directory matching the existing convention.
  3. `plan-catalog.constants.ts` — the rename:
     - `PLAN_KEYS = ["STARTER", "GROWTH", "SCALE", "ENTERPRISE"]`.
     - Add `METER_KEYS` entry `"CUSTOMERS"`.
     - Add `ADDON_SKUS` entry `"CUSTOMER_PACK_100"`.
     - Add the legacy alias map + normalizer (exact code below) so historical v7 rows keyed `TEAM`/`BUSINESS` still resolve instead of ranking `-1`.
     - `planRank()` must normalize before indexing.
     - `planKeyFromEnum()` must map the legacy `TenantPlan` enum to the NEW keys: `TEAM → "GROWTH"`, `BUSINESS`/`PROFESSIONAL` → `"SCALE"`, `ENTERPRISE → "ENTERPRISE"`, else `"STARTER"`.
     - Update the file's header comment: it currently claims to mirror migration `20260708120000_billing_plans_v2`; state instead that the live catalog is versioned in the database and this file is the vocabulary.
     - Note beside `LEGACY_ADDON_KEY_TO_SKU` that the free-text key `developer_mode` is intentionally unmapped (no DEV_MODE sku exists).
  4. `billing-math.ts`: update the stale price-anchor comment ($59/$149/$349) to Starter $99→$990, Growth $249→$2490, Scale $499→$4990, Enterprise custom. No behavior change.
- **exact code** (add to `plan-catalog.constants.ts`):

```ts
/**
 * Historical plan keys from catalog versions published before the
 * Starter/Growth/Scale rename. Superseded versions keep their original rows, so
 * anything that reads a pinned older version must normalize before ranking.
 */
export const LEGACY_PLAN_KEY_ALIASES: Record<string, PlanKey> = {
  TEAM: "GROWTH",
  BUSINESS: "SCALE",
  PROFESSIONAL: "SCALE",
};

/** Map any historical or current plan key onto a current one. */
export function normalizePlanKey(planKey: string | null | undefined): PlanKey | null {
  if (!planKey) return null;
  if ((PLAN_KEYS as readonly string[]).includes(planKey)) return planKey as PlanKey;
  return LEGACY_PLAN_KEY_ALIASES[planKey] ?? null;
}
```

and rewrite `planRank` as:

```ts
export function planRank(planKey: string): number {
  const normalized = normalizePlanKey(planKey);
  return normalized ? PLAN_KEYS.indexOf(normalized) : -1;
}
```

### WP2 — Publish catalog v8

- **files:** `apps/api/prisma/publish-plan-catalog-v8.ts` (new), `apps/api/package.json`
- **brief:** A script that publishes the new catalog version through the DRAFT→PUBLISHED lifecycle. Add an npm script `"db:publish:catalog"` to `apps/api/package.json` — **first read how the existing `seed` script is invoked and mirror that runner exactly**; do not add a new runner dependency.
  1. **Idempotency guard:** read the currently published version. If it already contains a `GROWTH` definition priced 249, log "already published" and exit 0. Re-runs must write nothing.
  2. Create a DRAFT version (next version number after the current max) carrying **four** `PlanDefinition` rows exactly per the Objective table (`sortOrder` 0..3; `isCustom: true` only for ENTERPRISE; `annualPrice` via `annualPrice()`), and **all eight** `AddonSku` rows: the seven existing SKUs at their existing prices/units/meters/capacities listed under "Facts verified" above, plus the new `CUSTOMER_PACK_100` — name "Customer pack (+100)", `monthlyPrice` 50, `unit: "FLAT"`, `meteredKey: "CUSTOMERS"`, `capacityPerUnit: 100`, `stackable: true`, `grantsFlags: []`.
  3. Carry the non-price capacity columns forward sensibly and ascending: `routesConcurrent` 1 / 3 / 10 / null, `scansIncluded` 20 / 100 / 300 / null, `msgsIncluded` 200 / 200 / 200 / 200 (v7 used 200 across the board — keep it).
  4. `featureFlags` must stay ascending and cumulative: STARTER `["flag.returns"]`; GROWTH adds `["flag.reports","flag.ap_bills","flag.credit_limits","flag.pricing_tiers","flag.analytics","addon.buyer_portal"]`; SCALE adds `["flag.settlement","flag.forecasting","flag.import_integrations","addon.regulated_items","addon.ocr"]`; ENTERPRISE gets every key in `FLAG_KEYS` **except** `flag.dispatch_live`. **`flag.dispatch_live` must not appear in ANY plan** — dispatch is unreleased.
  5. **Publish** the draft. Prefer calling `PlanCatalogService.publish()`; if it needs a Nest context the script cannot cheaply build, replicate its exact field writes (set the new version PUBLISHED with `publishedAt`, mark the prior PUBLISHED version SUPERSEDED) and say so in a comment. **Do NOT re-pin existing tenants** — grandfathering is deliberate; tenants move when they next change plan.
  6. Reads `DATABASE_URL` from the environment; never hardcodes a connection string; deletes nothing. Print a banner naming the target DB with credentials masked, then one line per definition and SKU written.

### WP3 — CUSTOMERS meter, entitlement caps, customer soft-cap

- **files:** `apps/api/src/billing/meter.service.ts`, `apps/api/src/billing/entitlements.service.ts`, `apps/api/src/billing/meter.service.spec.ts`, `apps/api/src/billing/entitlements.service.spec.ts`, `apps/api/src/customers/customers.service.ts`, `apps/api/src/customers/customers.service.spec.ts`
- **brief:**
  1. `meter.service.ts`: add `customersUsed(tenantId)` = count of `customer` rows where `tenantId` matches and `deletedAt: null`. Wire `CUSTOMERS` into `read()`, `readAll()`, and `increment()`'s live-meter early-return **exactly** the way `SEATS` is handled — CUSTOMERS is live-occupancy (deleting a customer frees headroom), never accumulating.
  2. `entitlements.service.ts`: add `customers: number | null` to the caps shape, from `PlanDefinition.customersIncluded` plus stacked `CUSTOMER_PACK_100` capacity, reusing the file's existing cap-composition path — do not invent a second one.
  3. `customers.service.ts` `create()` (and the CSV/bulk import path): after a successful create, if usage now exceeds the cap and no grace window is open, start one (`graceStartedAt = now`, `graceMeter = "CUSTOMERS"`). **The create ALWAYS succeeds.** Before a create, if already over cap AND the open grace window is older than the grace-period constant `BillingCronService.expireGrace()` uses (find and reuse it — do not hardcode a second number), throw the structured plan-gate 403 from `plan-gate.ts` (`buildPlanGateBody`) as INLINE_RESOLVE naming `CUSTOMER_PACK_100`. Only brand-new customer creation is ever blocked.
  4. **Fail open:** if the plan/cap cannot be resolved for any reason (no catalog, lookup throws), treat as unlimited and create normally. A billing lookup must never break customer creation.
  5. Specs: `customersUsed` counts only non-deleted, tenant-scoped rows; `increment("CUSTOMERS")` is a no-op; caps compose plan + stacked packs; over-cap create succeeds and opens grace; create after expired grace while still over cap throws the plan-gate 403; unresolvable catalog ⇒ create succeeds.

### WP4 — Platform MRR from real data + admin entitlements endpoint

- **files:** `apps/api/src/platform-admin/plan-pricing.constant.ts`, `apps/api/src/platform-admin/platform-admin.service.ts`, `apps/api/src/platform-admin/platform-admin.controller.ts`, `apps/api/src/platform-admin/platform-admin.service.spec.ts`, `apps/api/src/billing/billing-math.spec.ts`
- **brief:**
  1. **Retire the stopgap.** `getStats().estMrrUsd` must stop reading `STOPGAP_PLAN_MONTHLY_USD` (which knows only STARTER/PROFESSIONAL/ENTERPRISE and silently prices everything else at 0). Compute per ACTIVE tenant: `TenantSubscription.basePriceSnapshot` when set, else the published catalog's `monthlyPrice` for that tenant's normalized `planKey`, else 0. Grep for other importers of `plan-pricing.constant.ts`; delete the file if it becomes unused, otherwise leave it with a deprecation comment and remove its use here.
  2. `planBreakdown` must key on the tenant's `planKey` (normalized via `normalizePlanKey`), falling back to `planKeyFromEnum(tenant.plan)` — so the dashboard stops reporting legacy names the catalog no longer uses.
  3. **New endpoint** `GET /platform-admin/tenants/:id/entitlements`, guarded exactly like its sibling routes on that controller. Returns `EntitlementsService.resolve(tenantId)` (`{flags, addons, caps}`) plus the resolved `planKey` and `MeterService.readAll(tenantId)`. This is the first way to see what a tenant actually has. Import whatever module exports those services (check `entitlements.module.ts`) rather than re-providing them.
  4. Specs: `estMrrUsd` sums snapshots and catalog fallbacks, and a GROWTH-plan tenant contributes its real price rather than 0; the entitlements route returns flags/addons/caps/planKey/usage; update any `billing-math.spec.ts` expectations asserting the old $59/$149/$349 anchors (helper math is unchanged — only the documented anchors move).

## Acceptance criteria

1. `npx prisma validate` passes. The migration adds only `MeterKey.CUSTOMERS` and `PlanDefinition.customersIncluded`, both nullable/additive, and is never executed by the implementation.
2. `PLAN_KEYS` is `["STARTER","GROWTH","SCALE","ENTERPRISE"]`; `planRank("TEAM") === 1` and `planRank("BUSINESS") === 2` via the alias map (historical rows still rank correctly); `planRank("NOPE") === -1`.
3. `planKeyFromEnum("TEAM") === "GROWTH"`, `planKeyFromEnum("PROFESSIONAL") === "SCALE"`, `planKeyFromEnum("BUSINESS") === "SCALE"`.
4. Running the publish script against a database whose published catalog is v7 creates a new DRAFT, writes 4 definitions at $99 / $249 / $499 / custom with `customersIncluded` 100 / 250 / 500 / null and 8 AddonSku rows, publishes it, and marks the prior version SUPERSEDED. Existing tenants keep their `planVersionId` (no re-pinning).
5. Running the publish script a second time writes nothing and exits 0.
6. No `PlanDefinition.featureFlags` array contains `flag.dispatch_live`.
7. `MeterService.readAll()` includes a CUSTOMERS entry equal to the tenant's non-deleted customer count; `increment("CUSTOMERS")` does not accumulate.
8. Creating a customer over cap succeeds and opens a grace window; creating one after that window expires while still over cap throws the structured plan-gate 403 naming `CUSTOMER_PACK_100`; an unresolvable catalog never blocks creation.
9. `getStats().estMrrUsd` no longer references `STOPGAP_PLAN_MONTHLY_USD`, and a GROWTH tenant contributes its real monthly price.
10. `GET /platform-admin/tenants/:id/entitlements` returns flags, addons, caps, planKey and meter usage behind the same guard as its siblings.
11. No file under `apps/web/**` or `apps/mobile/**` is modified; no controller gains `@RequirePlanFlag`; no Stripe file is touched.

## Verification commands

- `npx prisma generate --schema apps/api/prisma/schema.prisma`
- `npm run verify`

## Risks & rollback

- **The rename is the sharp edge.** It is safe only because no tenant is on TEAM/BUSINESS. Any code path that compares a stored `planKey` string against `PLAN_KEYS` must go through `normalizePlanKey` — grep for `PLAN_KEYS`, `planRank`, and direct `planKey ===` comparisons across `apps/api/src` and fix every one. A missed site silently mis-ranks an upgrade/downgrade.
- **Do not re-pin tenants on publish.** Re-pinning would move existing tenants onto new prices without consent. Grandfathering is the intended behavior.
- **The customer soft-cap is the only customer-visible behavior change** and must never block anything except creating a brand-new customer after an expired grace window. Fail open on any billing lookup error.
- Rollback: revert the PR. The published v8 rows can be superseded by re-publishing a corrected version through the same lifecycle; no destructive data change is involved.
