# RT-866 — tests-report (RED)

Command: `npx jest src/billing/mrr.service.spec.ts` (run from `apps/api`)

Both target tests fail on the bug's own wrong values (`339`, `499`) against the unfixed tree.
All 13 other tests in the file remain green.

```
FAIL src/billing/mrr.service.spec.ts
  MrrService.computeOverview
    ✓ computes MRR = Σ(base + add-ons − discounts) from snapshots (2 ms)
    ✓ reconciles against the BillingEvent ledger + reports MoM delta
    ✕ T15 REG-B866-BYPLAN byPlan baseMrr is gross, highest first (flips :78 'net of discounts', SA-277) (3 ms)
    ✓ only counts add-ons for tenants with a PAYING base plan (planKey != null)
    ✓ uses a fixed trailing 30-day window for momDelta (no month-overflow)
    ✓ excludes non-PRODUCTION tenants from mrr and ledgerMrr
    ✓ splits unpriced (F2) vs zero-priced (full-discount) rows, and wires activeWithoutSubscription to its own query
    ✓ REG-743-F4 a null-snapshot row rescued by add-ons counts as paying, never as unpriced
    ✓ REG-743-N5 excludes a $0 row (full discount) from payingTenants and byPlan tenant counts
    ✓ prices only the paying PRODUCTION tenant — DEMO and a no-subscription pilot contribute $0
    ✓ REG-743-N1 priceTenant equals the tenant's own share of computeOverview for the same fixture (1 ms)
  MrrService — feature-override MRR exclusion oracle (brief B)
    ✓ STARTER tenant at $S: a PILOT GRANT override never moves MRR; purchasing the real AddonSku does; revoking the override leaves the purchase untouched
    ✓ same invariant for a GRANDFATHER-kind override (1 ms)
    ✓ computeOverview() never queries tenantFeatureOverride at all
  MrrService.computeOverview — REG-MRR-ANNUAL (6-tenant v11 fixture)
    ✕ T16 REG-B866-BYPLAN prices A(STARTER 99) B(GROWTH 249+addons) C(SCALE 499 fully discounted) D(manual, unpriced) E(addon-rescued) F(SCALE ANNUAL, snapshot=monthly 499) (flips REG-MRR-ANNUAL, SA-277)

  ● MrrService.computeOverview › T15 REG-B866-BYPLAN byPlan baseMrr is gross, highest first (flips :78 'net of discounts', SA-277)

    expect(received).toEqual(expected) // deep equality

    - Expected  - 1
    + Received  + 1

    @@ -1,8 +1,8 @@
      Array [
        Object {
    -     "baseMrr": 349,
    +     "baseMrr": 339,
          "planKey": "BUSINESS",
          "tenants": 1,
        },
        Object {
          "baseMrr": 59,

      76 |   it("T15 REG-B866-BYPLAN byPlan baseMrr is gross, highest first (flips :78 'net of discounts', SA-277)", async () => {
      77 |     const o = await make().svc.computeOverview();
    > 78 |     expect(o.byPlan).toEqual([
         |                      ^
      79 |       { planKey: "BUSINESS", tenants: 1, baseMrr: 349 }, // gross — same formula as the top-level baseMrr accumulator
      80 |       { planKey: "STARTER", tenants: 1, baseMrr: 59 },
      81 |     ]);

      at Object.<anonymous> (billing/mrr.service.spec.ts:78:22)

  ● MrrService.computeOverview — REG-MRR-ANNUAL (6-tenant v11 fixture) › T16 REG-B866-BYPLAN prices A(STARTER 99) B(GROWTH 249+addons) C(SCALE 499 fully discounted) D(manual, unpriced) E(addon-rescued) F(SCALE ANNUAL, snapshot=monthly 499) (flips REG-MRR-ANNUAL, SA-277)

    expect(received).toEqual(expected) // deep equality

    - Expected  - 1
    + Received  + 1

      Object {
    -   "baseMrr": 998,
    +   "baseMrr": 499,
        "planKey": "SCALE",
        "tenants": 1,
      }

      514 |     // for SCALE that's C(499) + F(499) = 998, not the pre-fix 499 (which wrongly subtracted
      515 |     // each row's discount a second time, C(499-499=0) + F(499-0=499)).
    > 516 |     expect(o.byPlan.find((p) => p.planKey === "SCALE")).toEqual({
          |                                                         ^
      517 |       planKey: "SCALE",
      518 |       tenants: 1, // only F prices > 0; C nets to $0 and is excluded from the tenant count too
      519 |       baseMrr: 998,

      at Object.<anonymous> (billing/mrr.service.spec.ts:516:57)

Test Suites: 1 failed, 1 total
Tests:       2 failed, 13 passed, 15 total
Snapshots:   0 total
Time:        0.345 s, estimated 1 s
Ran all test suites matching src/billing/mrr.service.spec.ts.
```

## Notes

- T15: reworded/renamed the pre-existing `:75-81` "breaks MRR down by plan" `it` into T15,
  flipping its expected `BUSINESS` `baseMrr` from `339` (net of the row's $10 discount) to `349`
  (gross), citing SA-277. Received value on the unfixed tree is the bug's own wrong value `339`.
- T16: the `REG-MRR-ANNUAL` block this brief refers to does not exist on this branch's
  `mrr.service.spec.ts` yet — it lives on local branch `test/billing-qa` (commit `7c3a5d61`,
  not an ancestor of this branch's HEAD). Added the block fresh (same 6-tenant `A`–`F` fixture,
  same non-flipped assertions for `mrr`/`baseMrr`/`addonMrr`/`discountTotal`/`payingTenants`/
  `unpricedActiveTenants`/`zeroPricedActiveTenants` — covering P8's "unchanged" pins), with the
  SCALE `byPlan` assertion flipped from the old commit's code-observed `499` to T16's `998`, its
  incorrect "the plan's figure assumed..." NOTE replaced with a SA-277 note explaining the gross
  formula, and two new identity assertions (`mrr === roundMoney(baseMrr - discountTotal +
addonMrr)` and `Σ byPlan.baseMrr === baseMrr`). Received value on the unfixed tree is the bug's
  own wrong value `499`.
- No implementation code was touched — `mrr.service.ts` is unmodified; both failures come from
  the buggy `byPlan[].baseMrr` formula already in that file (`row.baseMrr = roundMoney(row.baseMrr
  - base - discount)`at`mrr.service.ts:249`vs. the top-level accumulator`baseMrr += base;`at`mrr.service.ts:242`, per SA-277/cause-ruling.md).
