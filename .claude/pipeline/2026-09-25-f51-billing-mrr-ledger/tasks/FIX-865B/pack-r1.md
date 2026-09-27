# Review pack — build-plan.md — files: apps/api/src/billing/addon.service.ts — base: 28ee9b6d3bf079631cffd9b5339807c54d9bea55

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
index 92fcea67..090e70c7 100644
--- a/apps/api/src/billing/addon.service.ts
+++ b/apps/api/src/billing/addon.service.ts
@@ -207,20 +207,28 @@ export class AddonService {
             if (stripePriceId && !skuDef) {
               throw new BadRequestException(
                 `Add-on "${addonKey}" has no catalog SKU to price — publish a catalog version defining "${sku}" before billing it`,
               );
             }
           }

           // D1 (SA-277a): only a Stripe-billed enable carries revenue; a free grant is priced EXPLICITLY at 0 and books nothing.
           const priceSnapshot = stripePriceId && skuDef ? Number(skuDef.monthlyPrice) : 0;

+          // FIX-865B finding #1: only write `sku` when it actually resolved to a catalog SKU
+          // (bridged legacy key, or an unbridged key whose SKU we looked up above). An
+          // unbridged key with no catalog entry (e.g. "developer_mode") must keep sku null —
+          // writing the raw addonKey there makes `addonSkuCode()` treat it as a real SKU,
+          // which leaks it into EntitlementsService.compute()'s `activeCodes` / `ent.addons`
+          // and the catalog-refetch warning, none of which the spec asked to change.
+          const skuToStore = isBridged || skuDef ? sku : null;
+
           // Add Stripe subscription item if configured. A price means this add-on is
           // billed — the entitlement and the Stripe item must move together, so any
           // failure here refuses the whole call instead of silently granting an
           // unbilled add-on.
           let stripeItemId: string | null = null;
           if (stripePriceId && this.stripe.isConfigured) {
             const sub = await this.prisma.tenantSubscription.findUnique({
               where: { tenantId },
             });
             if (!sub?.stripeSubId) {
@@ -255,29 +263,29 @@ export class AddonService {
             }
           }

           // Upsert the add-on record and emit ledger delta in a transaction
           const addon = await this.prisma.$transaction(async (tx) => {
             const row = await tx.tenantAddon.upsert({
               where: { tenantId_addonKey: { tenantId, addonKey } },
               create: {
                 tenantId,
                 addonKey,
-                sku,
+                sku: skuToStore,
                 stripePriceId: stripePriceId ?? null,
                 stripeItemId,
                 active: true,
                 priceSnapshot,
               },
               update: {
                 active: true,
-                sku,
+                sku: skuToStore,
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
@@ -356,32 +364,48 @@ export class AddonService {
           );
         }
         // Already gone in Stripe — treat as success and clear the pointer below.
         this.logger.warn(
           `Stripe subscription item ${addon.stripeItemId} for add-on "${addonKey}" was already ` +
             `removed; clearing the local pointer`,
         );
       }
     }

+    // FIX-865B finding #0: `addon` above was read outside the transaction and before any
+    // lock, so two concurrent disables can both observe active=true and both emit a
+    // −snapshot×qty ledger delta (the Tenant FOR UPDATE lock inside `emitAddonDelta` only
+    // serialises the two transactions — it never re-checks `active`). Lock the row FIRST,
+    // then re-read it INSIDE the transaction and gate the update + emit on THAT read: the
+    // first transaction to acquire the lock sees active=true and proceeds; a concurrent
+    // second transaction blocks on the row lock until the first commits, then sees
+    // active=false already and no-ops instead of emitting a second delta.
     const updated = await this.prisma.$transaction(async (tx) => {
+      await tx.$queryRaw`SELECT id FROM "TenantAddon" WHERE id = ${addon.id} FOR UPDATE`;
+      const current = await tx.tenantAddon.findUnique({
+        where: { tenantId_addonKey: { tenantId, addonKey } },
+      });
+      if (!current?.active) {
+        // Already disabled by a concurrent call that won the race — nothing left to do.
+        return current ?? addon;
+      }
       const row = await tx.tenantAddon.update({
         where: { tenantId_addonKey: { tenantId, addonKey } },
         data: { active: false, stripeItemId: null },
       });
       // Only emit if the add-on was active and has a non-zero price
-      if (addon.active && addon.priceSnapshot != null && Number(addon.priceSnapshot) > 0) {
+      if (current.priceSnapshot != null && Number(current.priceSnapshot) > 0) {
         await emitAddonDelta(tx, this.events, {
           tenantId,
           sku: LEGACY_ADDON_KEY_TO_SKU[addonKey] ?? addonKey,
-          priceSnapshot: addon.priceSnapshot,
-          deltaQty: -addon.quantity,
+          priceSnapshot: current.priceSnapshot,
+          deltaQty: -current.quantity,
         });
       }
       return row;
     });

     this.entitlements.invalidate(tenantId);
     // B509: see the matching comment in enableAddon — the resolver cache needs its own
     // invalidation, separate from entitlements.invalidate().
     this.featureResolver.invalidate(tenantId);
     this.logger.log(`Add-on "${addonKey}" disabled for tenant ${tenantId}`);
```

## Call sites

(no new exported symbols in the diff)
