# Review pack — build-plan.md — files: apps/api/src/billing/mrr.service.ts — base: 4e80b024a232f70c57d04eb1d3220d8cd7b5996b

## Spec excerpt

## Objective

B863 manual activation never writes `cycle` (365-day row rolls +1mo). B864 override on a TRIAL tenant books +monthly, activation books it again. B865 admin add-on path writes no `priceSnapshot`/no emit; self-serve emits ungated; disable books −catalog. B866 `byPlan[].baseMrr` net vs top-level gross.
**Out of scope:** non-30/365 proration (own bug); whether prepaid rows roll (B327); data repair (none); B868/B869.

## Acceptance criteria

1. B863 both upsert branches write `cycle` (30→MONTHLY, 365→ANNUAL); external rows roll by prior length; Stripe rows unchanged.
2. B864 non-paying override writes the snapshot, emits nothing; activation books +1200 exactly once; both under `FOR UPDATE`.
3. B865 four sites → one helper; priced admin enable snapshots + gated emit; disables book −stored snapshot; unpriceable `stripePriceId` → 400 before Stripe; D1 in the PR.
4. B866 `Σ byPlan.baseMrr === baseMrr`; `mrr === baseMrr − discountTotal + addonMrr` (408/1346 fixtures).
5. No module/DTO/schema/`rollCycles`-`where` change; no live catalog read in any disable path.

## Diff

```diff
diff --git a/apps/api/src/billing/mrr.service.ts b/apps/api/src/billing/mrr.service.ts
index 09b669f4..ef8e3bcd 100644
--- a/apps/api/src/billing/mrr.service.ts
+++ b/apps/api/src/billing/mrr.service.ts
@@ -32,20 +32,21 @@ export function isPayingRow(
     // which would reject `undefined` (a caller's select that never fetched the column).
     tenant.deletedAt == PAYING_TENANT_CONDITIONS.deletedAt &&
     tenant.class === PAYING_TENANT_CONDITIONS.class &&
     planKey != null
   );
 }

 export interface MrrPlanRow {
   planKey: string;
   tenants: number;
+  /** B866 / SA-277: gross base run-rate, before discounts — Σ raw basePriceSnapshot. */
   baseMrr: number;
 }

 export interface MrrOverview {
   /** Monthly run-rate = Σ(base + add-ons − discounts) over paying (ACTIVE, subscribed) tenants. */
   mrr: number;
   baseMrr: number;
   addonMrr: number;
   discountTotal: number;
   payingTenants: number;
@@ -239,21 +240,23 @@ export class MrrService {
         (sum, a) => sum + (a.priceSnapshot != null ? Number(a.priceSnapshot) : 0) * a.quantity,
         0,
       );
       baseMrr += base;
       discountTotal += discount;
       addonMrr += addonSum;
       const rowPrice = this.priceSubscription(s, tenantAddons);
       mrr += rowPrice;
       const key = s.planKey as string;
       const row = byPlanMap.get(key) ?? { tenants: 0, baseMrr: 0 };
-      row.baseMrr = roundMoney(row.baseMrr + base - discount);
+      // B866 / SA-277: gross — the SAME formula as the top-level baseMrr accumulator (L-119).
+      // Identity: mrr = Σ rowPrice = baseMrr − discountTotal + addonMrr; Σ byPlan.baseMrr = baseMrr.
+      row.baseMrr = roundMoney(row.baseMrr + base);
       // REG-743-N5: a row's `payingWhere` match (a planKey) is not the same claim as "this
       // tenant pays" — a null snapshot or a full discount prices it $0. Count it as paying
       // ONLY when it actually contributes money, so "N paying tenants" and "$0" are never
       // both true for the same row.
       if (rowPrice > 0) {
         payingTenants += 1;
         row.tenants += 1;
       } else if (s.basePriceSnapshot == null) {
         // Missing a snapshot AND add-ons didn't rescue it above $0 — genuinely unpriced.
         unpricedActiveTenants += 1;
```

## Call sites

(no new exported symbols in the diff)

## Radius

(no usages found in call sites)

## Test-plan excerpt

# Bug test plan — B863 B864 B865 B866 · F51 billing/MRR ledger

> Fable @ high, 2026-09-25, from cause-ruling.md (SA-277 — FIXED). Sonnet types the tests in the engine.
> Red bar is BEHAVIOURAL: every REG test fails TODAY on the bug's own wrong value (below, verbatim).
> Jest for `apps/api` is configured in `apps/api/package.json` (rootDir `src`, `*.spec.ts`; `*.db.spec.ts`
> only under `jest.db.config.js`). Every flipped current-behaviour pin cites SA-277 in a comment.

## Red set (REG-tagged; in the red gate)

| T#  | Title (it() name starts with token)                                                                                       | Setup                                                                                                                                                                                                                                                                                                                                                                                                  | Asserts                                                                                                                                                                                                             | Fails TODAY with                                                            | File                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------ |
| T1  | `REG-B863-CYCLE 30 → MONTHLY`                                                                                             | `activateManualSubscription` describe at :2163 (its `beforeEach`), `findUniqueOrThrow` → TRIAL/PRODUCTION/sub null, `billingPeriodDays: 30`                                                                                                                                                                                                                                                            | `upsert.create.cycle === "MONTHLY"` AND `upsert.update.cycle === "MONTHLY"`                                                                                                                                         | `Expected: "MONTHLY" Received: undefined`                                   | `apps/api/src/platform-admin/platform-admin.service.spec.ts` |
| T2  | `REG-B863-CYCLE 365 → ANNUAL`                                                                                             | same, `billingPeriodDays: 365`                                                                                                                                                                                                                                                                                                                                                                         | both branches `cycle === "ANNUAL"`                                                                                                                                                                                  | `Expected: "ANNUAL" Received: undefined`                                    | same                                                         |
| T3  | `REG-B863-ROLL 365-day external row rolls +365d (flips REG-ROLL-MANUAL-ANNUAL, SA-277)`                                   | `make({ rollSubs: [{ tenantId:"t-manual-annual", cycle:"MONTHLY", externalPayment:true, periodStart:2025-01-01Z, periodEnd:2026-01-01Z }] })`                                                                                                                                                                                                                                                          | `update.data.periodStart` = 2026-01-01Z, `periodEnd.toISOString()` = `"2027-01-01T00:00:00.000Z"`; `findMany` `select` includes `periodStart`, `externalPayment`                                                    | `Expected: "2027-01-01T00:00:00.000Z" Received: "2026-02-01T00:00:00.000Z"` | `apps/api/src/billing/billing-cron.service.spec.ts`          |
| T4  | `REG-B863-ROLL 90-day external row rolls +90d`                                                                            | periodStart 2025-10-03Z, periodEnd 2026-01-01Z, cycle MONTHLY, externalPayment true                                                                                                                                                                                                                                                                                                                    | periodEnd `"2026-04-01T00:00:00.000Z"`                                                                                                                                                                              | `Received: "2026-02-01T00:00:00.000Z"`                                      | same                                                         |
| T5  | `REG-B863-ROLL 180-day external row rolls +180d`                                                                          | periodStart 2025-07-05Z, periodEnd 2026-01-01Z                                                                                                                                                                                                                                                                                                                                                         | periodEnd `"2026-06-30T00:00:00.000Z"`                                                                                                                                                                              | `Received: "2026-02-01T00:00:00.000Z"`                                      | same                                                         |
| T6  | `REG-B864-TRIAL-OVERRIDE books nothing on a TRIAL tenant (flips REG-OVERRIDE-BACKFILL-TRIAL + :1144, SA-277)`             | `tenant.findUnique` → {id,slug}; `tenant.findUniqueOrThrow` → `{status:"TRIAL",class:"PRODUCTION",deletedAt:null,subscription:{planKey:"ENTERPRISE"}}`; `tenantSubscription.findUnique` → `{priceOverrideMonthly:null,planKey:"ENTERPRISE",basePriceSnapshot:null}`; `updateTenantPriceOverride(TENANT_ID,{monthly:1200},ADMIN_ID)`                                                                    | upsert `update.basePriceSnapshot === 1200` (snapshot STILL written); `emit.mock.calls.map(c=>c[3]?.amountDelta)` `toEqual([])`                                                                                      | `Expected: [] Received: [1200]`                                             | platform-admin spec                                          |
| T7  | `REG-B864-TRIAL-OVERRIDE override then activation books exactly +1200 once`                                               | T6 fixture, then `findUniqueOrThrow` → TRIAL/PRODUCTION `subscription:{planKey:"ENTERPRISE",basePriceSnapshot:1200,discount:0}`, `tenantAddon.findMany` → []; catalog `getPublishedVersion` → `{id:"v-9",definitions:[{planKey:"SCALE",monthlyPrice:499,isCustom:false}]}`; `activateManualSubscription(TENANT_ID,{plan:"PROFESSIONAL",billingPeriodDays:365,paymentMethod:"BANK_TRANSFER"},ADMIN_ID)` | Σ `amountDelta` over all `emit` calls `toBe(1200)`; the one emit carries `actorId: ADMIN_ID`                                                                                                                        | `Expected: 1200 Received: 2400`                                             | platform-admin spec                                          |
| T8  | `REG-B865-ADMIN priced enable writes priceSnapshot and books +10 for a paying tenant (flips REG-ADMIN-ADDON-MRR, SA-277)` | `make({ stripe:{isConfigured:true,client:{subscriptionItems:{create}}}, subscription:{stripeSubId:"sub_1"}, publishedSkus:["REGULATED_ITEMS"], tenantRow:{status:"ACTIVE",class:"PRODUCTION",deletedAt:null,subscription:{planKey:"SCALE"}} })`; `enableAddon("t1","REGULATED_ITEMS","price_x")`                                                                                                       | `upsert.create.priceSnapshot === 10` and `update.priceSnapshot === 10`; `events.emit` called with `"addon.enabled"`, `objectContaining({amountDelta:10})`                                                           | `Expected: 10 Received: undefined`                                          | `apps/api/src/billing/addon.service.spec.ts`                 |
| T9  | `REG-B865-ADMIN priced enable on a TRIAL tenant writes the snapshot but books nothing`                                    | T8 with `tenantRow.status:"TRIAL"`                                                                                                                                                                                                                                                                                                                                                                     | `create.priceSnapshot === 10`; `emit` deltas `toEqual([])`                                                                                                                                                          | `Expected: 10 Received: undefined`                                          | same                                                         |
| T10 | `REG-B865-ADMIN disable books −priceSnapshot×qty from the STORED snapshot`                                                | `existingAddon:{id:"addon1",addonKey:"REGULATED_ITEMS",active:true,priceSnapshot:10,quantity:2,stripeItemId:null}`, paying tenantRow; `disableAddon("t1","REGULATED_ITEMS")`                                                                                                                                                                                                                           | `emit` called with `"addon.disabled"`, `amountDelta: -20`                                                                                                                                                           | `Expected: [-20] Received: []` (assert on the deltas array)                 | same                                                         |
| T11 | `REG-B865-ADMIN a stripePriceId whose key has no catalog SKU is a 400 before Stripe`                                      | stripe configured + `create` mock, `subscription:{stripeSubId:"sub_1"}`, `publishedSkus:[]`; `enableAddon("t1","not_in_catalog","price_x")`                                                                                                                                                                                                                                                            | `rejects.toBeInstanceOf(BadRequestException)`; `create` not called; `upsert` not called                                                                                                                             | `Received promise resolved instead of rejected`                             | same                                                         |
| T12 | `REG-B865-SELF TRIAL tenant enabling CUSTOMER_PACK_100 ×2 books nothing (activation books it once)`                       | `make({ tenantStatus:"TRIAL" })` with the tx-mock additions in Harness notes; `enableAddon("t1","CUSTOMER_PACK_100",2,"admin")`                                                                                                                                                                                                                                                                        | `tx.tenantAddon.upsert` create/update `priceSnapshot: 12`; `emit` deltas `toEqual([])`                                                                                                                              | `Expected: [] Received: [24]`                                               | `apps/api/src/billing/subscription-mutation.service.spec.ts` |
| T13 | `REG-B865-SELF disable books −stored snapshot, not −catalog`                                                              | paying tx tenantRow; `addonRow:{id:"a1",addonKey:"CUSTOMER_PACK_100",sku:"CUSTOMER_PACK_100",quantity:2,active:true,priceSnapshot:9}` (catalog says 12)                                                                                                                                                                                                                                                | `deltaOf(events,"addon.disabled") === -18`                                                                                                                                                                          | `Expected: -18 Received: -24`                                               | same                                                         |
| T14 | `REG-B865-LEDGER emitAddonDelta books ±snapshot×deltaQty only for a paying row`                                           | new `addon-ledger.spec.ts`; stub `tx` with `$queryRaw`, `tenant.findUniqueOrThrow`; stub `events.emit`                                                                                                                                                                                                                                                                                                 | paying + deltaQty 2, snapshot 12 → emit `amountDelta: 24`, `tx` forwarded; TRIAL → no emit; deltaQty 0 → no emit; snapshot null → no emit; `$queryRaw` called BEFORE `findUniqueOrThrow` (mock.invocationCallOrder) | `Cannot find module './addon-ledger'` (file this plan CREATES)              | `apps/api/src/billing/addon-ledger.spec.ts` (new)            |
| T15 | `REG-B866-BYPLAN byPlan baseMrr is gross (flips :78 "net of discounts", SA-277)`                                          | default `make()`                                                                                                                                                                                                                                                                                                                                                                                       | `byPlan` `toEqual([{planKey:"BUSINESS",tenants:1,baseMrr:349},{planKey:"STARTER",tenants:1,baseMrr:59}])`                                                                                                           | `Expected: 349 Received: 339`                                               | `apps/api/src/billing/mrr.service.spec.ts`                   |
| T16 | `REG-B866-BYPLAN 6-tenant fixture: SCALE 998 + identity (flips REG-MRR-ANNUAL, SA-277)`                                   | the existing REG-MRR-ANNUAL fixture                                                                                                                                                                                                                                                                                                                                                                    | SCALE `{tenants:1,baseMrr:998}`; `o.mrr === roundMoney(o.baseMrr - o.discountTotal + o.addonMrr)`; `Σ byPlan.baseMrr === o.baseMrr` (1346)                                                                          | `Expected: 998 Received: 499`                                               | same                                                         |

Old pins REG-ROLL-MANUAL-ANNUAL, REG-OVERRIDE-BACKFILL-TRIAL, REG-ADMIN-ADDON-MRR, REG-MRR-ANNUAL and the :1144
"price-override back-fills … emits" test and :78 "net of discounts" are REPLACED in place by the rows above (delete
the old `it`, keep the legacy token in the new title). No other 7c3a5d61 pin is touched.

## Pins (no REG token; outside the red gate)

| T#  | Frozen behavior                                                                                                                                                                                                                                                                                                  | File                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| P1  | Stripe/catalog row (`externalPayment:false`, periodStart 90d back, cycle MONTHLY) still rolls `addCycle` +1 month                                                                                                                                                                                                | billing-cron spec          |
| P2  | External row with `periodStart:null` falls back to `addCycle`                                                                                                                                                                                                                                                    | billing-cron spec          |
| P3  | ACTIVE/PRODUCTION/planKey tenant override still books +1200 with `actorId: ADMIN_ID`, and `$queryRaw` (FOR UPDATE) ran inside the tx before `findUniqueOrThrow`                                                                                                                                                  | platform-admin spec        |
| P3b | Lock-order pin (SA-277a D2), BOTH `updateTenantPriceOverride` and `activateManualSubscription`: via `mock.invocationCallOrder`, the FOR UPDATE `$queryRaw` is the tx's FIRST call — before every `tenantSubscription.*` call and before `billingEventService.emit` (no op-log-tx.ts import; it is not on master) | platform-admin spec        |
| P9  | UI-865: EnableAddonModal renders the API's no-catalog-SKU 400 message verbatim, modal stays open, submit re-enabled                                                                                                                                                                                              | EnableAddonModal.test.tsx  |
| P4  | Grandfathered snapshot (:1166) still emits nothing — unchanged                                                                                                                                                                                                                                                   | platform-admin spec        |
| P5  | Free grant (no stripePriceId) of a published SKU writes `priceSnapshot: 0` EXPLICITLY (create AND update payloads) and emits nothing; add-on MRR for it = 0 (SA-277a D1)                                                                                                                                         | addon spec                 |
| P6  | Unbridged key with no SKU and no price (developer_mode) still resolves, no snapshot, no emit                                                                                                                                                                                                                     | addon spec                 |
| P7  | Self-serve idempotent re-enable at same qty (:813 second half) still emits nothing; paying tenant ×2 still books 24                                                                                                                                                                                              | subscription-mutation spec |
| P8  | `mrr.service` top-level `baseMrr` 408 / 1346 and `payingTenants`/`unpriced`/`zeroPriced` unchanged                                                                                                                                                                                                               | mrr spec                   |

## NEED-DB lane (run by the F2 prover, NOT in engine gates)

`apps/api/src/common/override-activation-ledger.db.spec.ts` (new; pattern = `update-tenant-class-ledger.db.spec.ts`
from #1335: `describeDb`, real `PrismaClient` via `PrismaPg`, `assertTestTenant("qa-f51-…")`, `PlatformAdminService`
constructed directly with real `PrismaService`/`BillingEventService`/`MrrService`/`PlanCatalogService(prisma)`, stubs
for the rest — `billingService:{syncStripeSubscriptionPrice: async()=>null}`, `platformPricingService:
{resolveTenantPricing: async()=>({})}`, `planTransition:{isEnabled:async()=>false, transactionOptions:()=>undefined,
invalidateCaches:()=>{}}`, `tenantStatusGuard:{invalidate(){}}`, `auditService:{log: async()=>{}}`).
Requires a published catalog (`npm run local:seed`); `getPublishedVersion()` null → `throw` a clear message.

- DB1: TRIAL PRODUCTION tenant, subscription `{planKey:"SCALE", basePriceSnapshot:null}` → `updateTenantPriceOverride(monthly:1200)` → ledger Σ = 0, snapshot 1200 → `activateManualSubscription({plan:"PROFESSIONAL", billingPeriodDays:365, paymentMethod:"BANK_TRANSFER"})` → ledger Σ = **1200**, exactly one `plan.changed` row, `priceTenant()` = 1200, subscription `cycle === "ANNUAL"`.
- DB2: TRIAL tenant, `SubscriptionMutationService.enableAddon("CUSTOMER_PACK_100", 2)` (real prisma/catalog/events; proration stub `{prorationPreview: async()=>({proratedToday:0})}`, subscription stub, entitlements/stripe/notification/planTransition stubs) → ledger Σ = 0, `TenantAddon.priceSnapshot` = catalog price → activation → ledger Σ = base + snapshot×2, ONE row; then `disableAddon` → ledger Σ = base.
  Marked in the spec header: `NEED-DB: run by the F2 prover, not in engine gates`.
