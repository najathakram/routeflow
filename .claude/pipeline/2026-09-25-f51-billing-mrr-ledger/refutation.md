# S2 Refutation — F51 (B863–B866)

## Verdicts

- **B863 confirmed.** Diverges at `platform-admin.service.ts:963-995` (upsert, no `cycle`) → `billing-cron.service.ts:496` `addCycle(start, s.cycle)` → `billing-math.ts:105` (`MONTHLY` → +1 month). Nothing else sets the period length on roll.
- **B864 confirmed.** Diverges at `platform-admin.service.ts:1454-1461`: the emit runs whenever `backfillBase` is true, with no status or class read. The double-book trace holds: the override books +1200 on the TRIAL row. The follow-on `syncStripeSubscriptionPrice → reconcilePriceLedger` is a no-op because the snapshot is already 1200 (`billing.service.ts:522-524`). Then activation reads snapshot 1200, gets `wasPaying=false→isPaying=true` and emits +1200 (`:1012-1037`). Ledger +2400 against an MRR of 1200.
- **B865 confirmed.** Diverges at `addon.service.ts:246-260`: the upsert has no `priceSnapshot`, and there is no emit anywhere in the method. `mrr.service.ts:237-238` prices a null snapshot at $0.
- **B866 confirmed.** Diverges at `mrr.service.ts:242` (gross) vs `:249` (net of discount). Both lines are in one loop and read the same inputs.

## Corrections to S1

1. **B864, non-backfill branch.** S1 and the code comment at `:1432-1435` both say a set snapshot is "grandfathered… deliberately does not rewrite it". That is false in effect. `updateTenantPriceOverride` always calls `syncStripeSubscriptionPrice` (`:1464`), which calls `reconcilePriceLedger` (`billing.service.ts:506-548`). That method rewrites `basePriceSnapshot` to the newly resolved monthly price whenever it changes, even when no Stripe sub exists, and emits `new−old` gated on `isPayingRow`. It is the SA-140 "gate the emit, not the snapshot" shape. So changing an existing override does emit, and it moves MRR immediately (Stripe bills from next cycle).
2. **Self-serve emits are not paying-gated.** `subscription-mutation.service.ts:1259-1265` and `:1324-1329` emit for any tenant, TRIAL included. Activation's `contribution` includes active add-ons (`:1007-1018`). So a TRIAL tenant that self-enables an add-on and is then activated double-books that add-on, the same class as B864. This is a new sibling and was out of S1 scope. Separately, self-serve disable books `−catalog price × qty` rather than `−priceSnapshot`, so it goes asymmetric if the catalog price changed.
3. The sibling map's "Self-serve emits gate on SKU checks instead" is wrong for the ledger. The SKU checks are validation, not a paying-set gate.

## Facts for the fix designer

### B863

- **Period length.** It can be recovered at roll time: `periodEnd − periodStart` are both set by the manual upsert (`:970-971`, `:981-982`). But `rollCycles` selects only `tenantId, cycle, periodEnd` (`billing-cron:490`). A length-preserving roll must be limited to `externalPayment=true` rows. Stripe and catalog rows need calendar-month clamping, and their lengths vary from 28 to 31 days. Rolling a fixed length forward keeps it (start := old end).
- **Policy question to raise.** Any roll of a prepaid manual CASH period grants an unpaid next period. Status is untouched and `rollCycles` has no status or externalPayment filter. Whether a manual row should roll at all needs an owner ruling.
- **Every `cycle` reader (non-spec), and what ANNUAL would change:**
  - `billing-cron:496` addCycle: +12 months instead of +1.
  - `proration.service.ts:211` `proratedDiff` (used by self-serve upgrade/preview `subscription-mutation:588` and admin `updatePlan` `platform-admin:774`): ANNUAL uses `annualPrice(delta)=delta×10` over the period window. **Today's MONTHLY on a 365d row is also wrong.** It takes the in-window branch (`:217-219`) and prorates a _monthly_ delta over a 365-day window, a ~12× under-quote. ANNUAL fixes that for 365d rows.
  - `proration.service.ts:167` add-on proration: MONTHLY uses the sub period as the window, so a 365d MONTHLY row prorates the monthly add-on price over a year (~12× under). ANNUAL falls back to the calendar month (correct).
  - `subscription-mutation.service.ts:245` (B58 same-cycle guard) and `:504` `sameCycle` in `planChangePreview`: ANNUAL makes a MONTHLY self-serve pick a cycle change rather than NOOP.
  - `subscription.service.ts:97` → web `settings/billing/page.tsx:147,218,223`: badge "Annual", price shows `annualPrice` "/yr". That is override×10 or the catalog annual price, not what the tenant actually paid manually.
  - `platform-admin.service.ts:774` updatePlan preserves the prior cycle.
  - No notification or email reader of `cycle` was found in `apps/api/src`.
- **Web options.** `admin/tenants/[id]/page.tsx:740-745` offers 30/90/180/365. No `BillingCycle` value fits 90 or 180. Mapping either to MONTHLY rolls +1 month; mapping to ANNUAL rolls +12 months and quotes ×10/yr. Both are wrong. Options: (a) restrict the DTO to 30/365; (b) a length-preserving roll for external rows, independent of `cycle`; (c) a new enum value, which needs a migration and enum-parity work.

### B864

- Gating the emit on `isPayingRow` (keeping the snapshot write) gives exactly one +1200 at activation. The TRIAL override writes snapshot 1200 and emits nothing. Reconcile is then a no-op, and activation emits +1200.
- `updateTenantPriceOverride` does not read tenant status, class or deletedAt. The fix must add that read, inside the tx to be race-free.
- **Simpler equivalent.** Delete the in-tx backfill (both write and emit). Then `reconcilePriceLedger` does the snapshot write plus the gated emit (old 0 → new 1200). Trade-off: that path runs after the tx commits, so the override write and ledger write are not atomic, and the emit carries no `actorId`.
- The existing test `platform-admin.service.spec.ts:1144-1165` asserts an ungated +1200 and must be updated. Discount interplay is consistent: the pre-backfill ledger already carried `−discount`.

### B865

- **Self-serve derivation.** `priceSnapshot = skuDef.monthlyPrice` from the published catalog (`:1224-1225`, `:1255-1257`). The emit is `monthlyPrice×deltaQty` whenever `deltaQty≠0`. It is not paying-gated (see Correction 2).
- **What the admin path can price.** It can price only catalog SKUs: `LEGACY_ADDON_KEY_TO_SKU[addonKey] ?? addonKey` → `published.addonSkus.find(sku)` → `monthlyPrice`. Catalog addon SKUs carry no `stripePriceId`, so an arbitrary admin `stripePriceId` can be priced only by a Stripe `prices.retrieve` (and interval normalisation), or by refusing a `stripePriceId` without a catalog SKU.
- **The admin path needs a tx.** Its upsert is not in a `$transaction`, so a tx must be added for an atomic emit.
- **Gate the admin emit on `isPayingRow`.** Otherwise activation double-books it through the add-on term.
- **Admin `disableAddon` must mirror the enable.** It should emit `−priceSnapshot×qty` using the stored snapshot.
- **DI.** `AddonService` is provided only in `billing.module.ts` (`:43`, exported `:71`; the other modules import BillingModule). `BillingEventService` is provided in the same module (`:48`) and `MrrService` at `:50`. `isPayingRow` is a pure import. So a new `BillingEventService` constructor dep is safe for boot. Spec mocks need a `billingEvent`/`$transaction` mock.

### B866

- **The consistent identity.** `mrr = Σ rowPrice = baseMrr(gross) − discountTotal + addonMrr`, up to per-row rounding. So top-level gross `:242` is the internally consistent one. `byPlan[].baseMrr` should also be gross, or be renamed to a net figure.
- **byPlan counting quirk.** `byPlan[].tenants` counts only `rowPrice>0` (`:255-257`), but `byPlan[].baseMrr` accumulates every payingWhere row, including unpriced and zero-priced ones. A null-snapshot row with a discount adds a negative amount.
- **Consumers.** Outside `mrr.service` there are none in web, mobile, packages or scripts. The only other hits are mock fixtures in `platform-admin.service.spec.ts:122,128,1330,1336`. The raw API `GET billing/admin/mrr` (`billing.controller.ts:38`) and `getStats` (`platform-admin:1228`) do return the object, so the field is visible in the API response. I did not verify whether `getStats` forwards `byPlan`.
