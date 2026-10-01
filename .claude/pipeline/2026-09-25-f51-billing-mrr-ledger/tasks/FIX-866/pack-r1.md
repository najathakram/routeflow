# Review pack — build-plan.md — files: apps/api/src/billing/mrr.service.ts — base: 6fc0bb213546278ebc3fa21a0fff09b183d90c58

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

(no changes in the named files against 6fc0bb213546278ebc3fa21a0fff09b183d90c58)

## Call sites

(no new exported symbols in the diff)
