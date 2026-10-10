### FIX-866 — byPlan gross

`mrr.service.ts:249` →

```ts
// B866 / SA-277: gross — the SAME formula as the top-level baseMrr accumulator (L-119).
// Identity: mrr = Σ rowPrice = baseMrr − discountTotal + addonMrr; Σ byPlan.baseMrr = baseMrr.
row.baseMrr = roundMoney(row.baseMrr + base);
```

Update the `MrrPlanRow.baseMrr` doc comment ("gross base run-rate, before discounts"). `byPlan.tenants` unchanged.
