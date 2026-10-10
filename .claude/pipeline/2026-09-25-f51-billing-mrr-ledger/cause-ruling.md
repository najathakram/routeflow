# Cause ruling — F51 B863–B866 (SA-277, Senior Architect, 2026-09-25)

Source: SA session "Senior Architect role and operating rules", ruling SA-277, over cause-brief.md + refutation.md,
squared with SA-140(2), SA-163, B327, B216. Recorded verbatim in substance.

## 1. Cause verdict

All four accepted as CONFIRMED by S2 (refutation.md).

## 2. Fix design

- **B863** — `activateManualSubscription`: `cycle = billingPeriodDays >= 365 ? ANNUAL : MONTHLY` in BOTH upsert
  branches. `rollCycles`: a prepaid manual row still rolls and stays ACTIVE (B327, no policy change), but rolls
  LENGTH-PRESERVING for `externalPayment` rows: start := old end, end := start + (old end − old start). rollCycles
  selects periodStart/periodEnd for those rows. Stripe/catalog rows keep `addCycle` calendar clamping.
  Out of scope: proration of non-30/365 manual rows (proration.service :167/:211) → file as its own bug.
- **B864** — Option A: keep the in-tx snapshot write; gate the EMIT on `isPayingRow`, reading status/class/deletedAt
  inside the same tx under the tenant row lock (FOR UPDATE, SA-163 shape) so an activation racing the override can
  never book twice; actorId preserved. Option B (delete backfill, rely on post-commit reconcilePriceLedger) REJECTED.
- **B865** — ONE add-on ledger helper (`emitAddonDelta(tx, tenant, sku, snapshot, deltaQty)` or equivalent):
  snapshot = catalog SKU monthlyPrice; gate on `isPayingRow` inside the tx; book ±priceSnapshot × deltaQty from the
  STORED snapshot. Used by admin enableAddon (new $transaction), admin disableAddon (−snapshot × qty), AND the two
  self-serve sites (subscription-mutation :1259-1265, :1324-1329). Widening bounded to routing those four call sites.
  A stripePriceId with no catalog SKU → 400 (fail closed). Verify whether admin web ever sends stripePriceId; state it
  in the PR.
- **B866** — `byPlan[].baseMrr` gross (same as top level); byPlan.tenants stays rowPrice > 0; byPlan.baseMrr sums the
  same payingWhere rows as the top level. Identity pinned: mrr = Σ rowPrice = baseMrr(gross) − discountTotal +
  addonMrr. Verify getStats forwards byPlan before calling it "API-visible only".

## 3. Regression tests / pins (flip on SA-277)

- B863: 30 → MONTHLY, 365 → ANNUAL, 90/180 roll by own length; REG-ROLL-MANUAL-ANNUAL flips to +365d/+12mo.
- B864: TRIAL override → no emit; later activation books exactly +1200 (unit AND real Postgres); spec
  platform-admin.service.spec.ts :1144-1165 flips; REG-OVERRIDE-BACKFILL-TRIAL flips.
- B865: REG-ADMIN-ADDON-MRR flips (snapshot written, gated emit); self-serve TRIAL add-on → activation books once;
  disable books −snapshot not −catalog.
- B866: mrr.service.spec :78 BUSINESS 339 → 349; REG-MRR-ANNUAL SCALE 499 → 998; identity assertion.
  Every flipped current-behaviour pin cites SA-277.

## 4–5. Radius / sibling patterns

Radius: billing ledger emits (platform-admin, addon.service, subscription-mutation, mrr.service, billing-cron).
Sibling patterns: `billingEventService\.emit\(` / `amountDelta:` sites not routed through isPayingRow;
`addCycle\(` callers on external rows.

## 6. Data repair

None. Report only, no prod write (the one live B863-shaped row is class TEST, planKey NULL).

## 7. Probe plan / proof

Revert probes on each fixed file. Executed proof: F2 prover's billing DB lane at the head (#1335 specs + new
TRIAL→activation and add-on cases) — post NEED-DB.

## Sequencing

This PR → B868 → B869 (B869 re-pins REG-MRR-ANNUAL row F to annual ÷ 12).
