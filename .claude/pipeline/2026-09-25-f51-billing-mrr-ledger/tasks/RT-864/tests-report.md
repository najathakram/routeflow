# RT-864 — tests report (RED)

Author-side repro tests for T6, T7 (red gate) and P3, P4 (pins) in
`apps/api/src/platform-admin/platform-admin.service.spec.ts`. Only that file was touched — no
implementation code.

## Command

```
cd apps/api && npx jest src/platform-admin/platform-admin.service.spec.ts -t "REG-B864-TRIAL-OVERRIDE"
```

## Observed output (verbatim)

```
  ● PlatformAdminService — audit provenance › REG-B864-TRIAL-OVERRIDE books nothing on a TRIAL tenant (flips REG-OVERRIDE-BACKFILL-TRIAL + :1144, SA-277)

    expect(received).toEqual(expected) // deep equality

    - Expected  - 1
    + Received  + 3

    - Array []
    + Array [
    +   1200,
    + ]

      1168 |     expect(upsertArg.update.basePriceSnapshot).toBe(1200);
      1169 |     // RED today: the bug books the delta regardless of the tenant's paying-set status.
    > 1170 |     expect(billingEventService.emit.mock.calls.map((c: any) => c[3]?.amountDelta)).toEqual([]);
           |                                                                                    ^
      1171 |   });
      1172 |
      1173 |   it("REG-B864-TRIAL-OVERRIDE override then activation books exactly +1200 once", async () => {

      at Object.<anonymous> (platform-admin/platform-admin.service.spec.ts:1170:84)

  ● PlatformAdminService — audit provenance › REG-B864-TRIAL-OVERRIDE override then activation books exactly +1200 once

    expect(received).toBe(expected) // Object.is equality

    Expected: 1200
    Received: 2400

      1219 |       0,
      1220 |     );
    > 1221 |     expect(totalDelta).toBe(1200);
           |                        ^
      1222 |     expect(billingEventService.emit).toHaveBeenCalledWith(
      1223 |       TENANT_ID,
      1224 |       "plan.changed",

      at Object.<anonymous> (platform-admin/platform-admin.service.spec.ts:1221:24)

Test Suites: 1 failed, 1 total
Tests:       2 failed, 86 skipped, 88 total
Snapshots:   0 total
Time:        5.402 s, estimated 13 s
Ran all test suites matching src/platform-admin/platform-admin.service.spec.ts with tests matching "REG-B864-TRIAL-OVERRIDE".
```

T6 fails with the bug's own wrong value `[1200]` (expected `[]`) — the current code books the
run-rate delta on the override write regardless of the tenant's paying-set status. T7 fails with
`2400` (expected `1200`) — the override's spurious +1200 on top of the activation's correct
+1200 double-books the same negotiated fee for one real crossing into the paying set.

## Full-file run (no other test in this file was touched or broken)

```
cd apps/api && npx jest src/platform-admin/platform-admin.service.spec.ts
```

`Tests: 2 failed, 86 passed, 88 total` — the 2 failures are exactly the two new REG-B864-TRIAL-OVERRIDE
tests above; every other test (including the new P3 pin — "price-override on an ACTIVE/PRODUCTION
tenant still books the run-rate delta with actorId (P3)" — and the unchanged P4 test at the old
:1166 — "price-override leaves a grandfathered basePriceSnapshot alone and emits nothing") passes.
