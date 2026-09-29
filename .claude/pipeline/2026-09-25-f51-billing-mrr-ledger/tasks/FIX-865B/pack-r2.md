# Review pack — build-plan.md — files: apps/api/src/billing/addon.service.ts — base: a325fbab041114731bcc0d4c6cbba83e29d0df31

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
diff --git a/apps/api/src/billing/addon.service.ts b/apps/api/src/billing/addon.service.ts
index 090e70c7..46450efb 100644
--- a/apps/api/src/billing/addon.service.ts
+++ b/apps/api/src/billing/addon.service.ts
@@ -271,21 +271,29 @@ export class AddonService {
                 tenantId,
                 addonKey,
                 sku: skuToStore,
                 stripePriceId: stripePriceId ?? null,
                 stripeItemId,
                 active: true,
                 priceSnapshot,
               },
               update: {
                 active: true,
-                sku: skuToStore,
+                // FIX-865B finding #1 (r2): `skuToStore` is null whenever this enable is
+                // unbridged with no resolvable catalog SKU (e.g. a legacy key re-enabled by
+                // an admin with no stripePriceId) — that says nothing about whether the
+                // EXISTING row already has a correct sku from an earlier enable. `sku: null`
+                // here would overwrite that good value and make addonSkuCode() drop the
+                // add-on from entitlements even though the row is active. Fall through to
+                // `undefined` (leave the column untouched) instead of clobbering it; only the
+                // create branch above may legitimately write a fresh row's sku as null.
+                sku: skuToStore ?? undefined,
                 stripePriceId: stripePriceId ?? undefined,
                 stripeItemId: stripeItemId ?? undefined,
                 priceSnapshot,
               },
             });
             // D1: only emit if the add-on has a non-zero price (free grants book nothing)
             if (priceSnapshot > 0) {
               await emitAddonDelta(tx, this.events, {
                 tenantId,
                 sku,
```

## Call sites

(no new exported symbols in the diff)
