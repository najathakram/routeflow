# RT-863 — tests-report (RED, observed)

Command:

```
cd apps/api && npx jest src/billing/billing-cron.service.spec.ts src/platform-admin/platform-admin.service.spec.ts -t "REG-B863"
```

Verbatim output:

```
FAIL src/platform-admin/platform-admin.service.spec.ts
  ● PlatformAdminService — audit provenance › activateManualSubscription — B557 books a compensating delta on activation › REG-B863-CYCLE 30 → MONTHLY

    expect(received).toBe(expected) // Object.is equality

    Expected: "MONTHLY"
    Received: undefined

      2270 |
      2271 |       const upsertArg = (prisma as any).tenantSubscription.upsert.mock.calls[0][0];
    > 2272 |       expect(upsertArg.create.cycle).toBe("MONTHLY");
           |                                      ^
      2273 |       expect(upsertArg.update.cycle).toBe("MONTHLY");
      2274 |     });
      2275 |

      at Object.<anonymous> (platform-admin/platform-admin.service.spec.ts:2272:38)

  ● PlatformAdminService — audit provenance › activateManualSubscription — B557 books a compensating delta on activation › REG-B863-CYCLE 365 → ANNUAL

    expect(received).toBe(expected) // Object.is equality

    Expected: "ANNUAL"
    Received: undefined

      2290 |
      2291 |       const upsertArg = (prisma as any).tenantSubscription.upsert.mock.calls[0][0];
    > 2292 |       expect(upsertArg.create.cycle).toBe("ANNUAL");
           |                                      ^
      2293 |       expect(upsertArg.update.cycle).toBe("ANNUAL");
      2294 |     });
      2295 |   });

      at Object.<anonymous> (platform-admin/platform-admin.service.spec.ts:2292:38)

FAIL src/billing/billing-cron.service.spec.ts
  ● BillingCronService › REG-B863-ROLL 365-day external row rolls +365d (flips REG-ROLL-MANUAL-ANNUAL, SA-277)

    expect(received).toBe(expected) // Object.is equality

    Expected: "2027-01-01T00:00:00.000Z"
    Received: "2026-02-01T00:00:00.000Z"

      872 |     const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
      873 |     expect(data.periodStart).toEqual(periodEnd);
    > 874 |     expect(data.periodEnd.toISOString()).toBe("2027-01-01T00:00:00.000Z");
          |                                          ^
      875 |     expect(prisma.tenantSubscription.findMany).toHaveBeenCalledWith(
      876 |       expect.objectContaining({
      877 |         select: expect.objectContaining({ periodStart: true, externalPayment: true }),

      at Object.<anonymous> (billing/billing-cron.service.spec.ts:874:42)

  ● BillingCronService › REG-B863-ROLL 90-day external row rolls +90d

    expect(received).toBe(expected) // Object.is equality

    Expected: "2026-04-01T00:00:00.000Z"
    Received: "2026-02-01T00:00:00.000Z"

      890 |     await svc.rollCycles();
      891 |     const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    > 892 |     expect(data.periodEnd.toISOString()).toBe("2026-04-01T00:00:00.000Z");
          |                                          ^
      893 |   });
      894 |
      895 |   it("REG-B863-ROLL 180-day external row rolls +180d", async () => {

      at Object.<anonymous> (billing/billing-cron.service.spec.ts:892:42)

  ● BillingCronService › REG-B863-ROLL 180-day external row rolls +180d

    expect(received).toBe(expected) // Object.is equality

    Expected: "2026-06-30T00:00:00.000Z"
    Received: "2026-02-01T00:00:00.000Z"

      903 |     await svc.rollCycles();
      904 |     const data = prisma.tenantSubscription.update.mock.calls[0][0].data;
    > 905 |     expect(data.periodEnd.toISOString()).toBe("2026-06-30T00:00:00.000Z");
          |                                          ^
      906 |   });
      907 |
      908 |   // Pin: a Stripe/catalog-priced row (externalPayment: false) is still rolled by `addCycle`

      at Object.<anonymous> (billing/billing-cron.service.spec.ts:905:42)

Test Suites: 2 failed, 2 total
Tests:       5 failed, 120 skipped, 125 total
Snapshots:   0 total
Time:        0.924 s, estimated 1 s
Ran all test suites matching src/billing/billing-cron.service.spec.ts|src/platform-admin/platform-admin.service.spec.ts with tests matching "REG-B863".
```

All 5 REG-B863 tests fail RED on the bug's own wrong value:

- T1/T2 (`REG-B863-CYCLE`): `Received: undefined` — `activateManualSubscription`'s upsert never writes `cycle`.
- T3/T4/T5 (`REG-B863-ROLL`): `Received: "2026-02-01T00:00:00.000Z"` — `rollCycles()` always does `addCycle(periodEnd, cycle)` regardless of `externalPayment`/observed period length.

## Pins verified green (not in the red gate; full-file run, no `-t` filter)

```
cd apps/api && npx jest src/billing/billing-cron.service.spec.ts src/platform-admin/platform-admin.service.spec.ts
```

```
Test Suites: 2 failed, 2 total
Tests:       5 failed, 1 todo, 119 passed, 125 total
```

The 5 failing are exactly the REG-B863 tests above; all other tests in both files — including the two new P1/P2 pins
(`rollCycles still rolls a Stripe/catalog row (externalPayment: false) by addCycle +1 month`, `rollCycles falls back
to addCycle for an external row with periodStart: null`) — pass unchanged.

## Deviation from the brief

The brief says to "replace the REG-ROLL-MANUAL-ANNUAL `it` with T3" in `billing-cron.service.spec.ts`. No `it` named
or tagged `REG-ROLL-MANUAL-ANNUAL` exists in this file at the current HEAD (`git log`/`grep` confirm it — the working
tree was clean before this task's edits). T3 was added as a new test instead of a replacement, with its title citing
`(flips REG-ROLL-MANUAL-ANNUAL, SA-277)` per the test-plan's own title text. Nothing was deleted.
