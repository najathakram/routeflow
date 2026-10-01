# RT-865 tests report — repro tests T8–T14, P5–P7

Command:

```
cd apps/api && npx jest src/billing/addon.service.spec.ts src/billing/subscription-mutation.service.spec.ts src/billing/addon-ledger.spec.ts --maxWorkers=2
```

Observed result: RED, as required (7 new/changed assertions fail on the bug's own wrong value;
`addon-ledger.spec.ts` fails to even load since `addon-ledger.ts` doesn't exist yet — FIX-865A
creates it). All 153 pre-existing tests in these two files still pass — the harness edits
(new `tenant.findUniqueOrThrow`/`$queryRaw`/`$transaction` mocks, the 7th `AddonService` ctor
arg, the `msrp`/`MSRP` B342-race-test fixture swap, the `priceSnapshot` additions to the P7
fixtures) are additive and don't change current behavior.

Verbatim runner output (Nest logger lines stripped — they carry no assertion data):

```
FAIL src/billing/addon.service.spec.ts
  ● AddonService.enableAddon/disableAddon — B865 ledger (SA-277) › REG-B865-ADMIN priced enable writes priceSnapshot and books +10 for a paying tenant (flips REG-ADMIN-ADDON-MRR, SA-277)

    expect(jest.fn()).toHaveBeenCalledWith(...expected)

    Expected: ObjectContaining {"create": ObjectContaining {"priceSnapshot": 10}, "update": ObjectContaining {"priceSnapshot": 10}}
    Received: {"create": {"active": true, "addonKey": "REGULATED_ITEMS", "stripeItemId": "si_9", "stripePriceId": "price_x", "tenantId": "t1"}, "update": {"active": true, "stripeItemId": "si_9", "stripePriceId": "price_x"}, "where": {"tenantId_addonKey": {"addonKey": "REGULATED_ITEMS", "tenantId": "t1"}}}

    Number of calls: 1

      533 |     await svc.enableAddon("t1", "REGULATED_ITEMS", "price_x");
      534 |
    > 535 |     expect(prisma.tenantAddon.upsert).toHaveBeenCalledWith(
          |                                       ^
      536 |       expect.objectContaining({
      537 |         create: expect.objectContaining({ priceSnapshot: 10 }),
      538 |         update: expect.objectContaining({ priceSnapshot: 10 }),

      at Object.<anonymous> (billing/addon.service.spec.ts:535:39)

  ● AddonService.enableAddon/disableAddon — B865 ledger (SA-277) › REG-B865-ADMIN priced enable on a TRIAL tenant writes the snapshot but books nothing

    expect(jest.fn()).toHaveBeenCalledWith(...expected)

    Expected: ObjectContaining {"create": ObjectContaining {"priceSnapshot": 10}}
    Received: {"create": {"active": true, "addonKey": "REGULATED_ITEMS", "stripeItemId": "si_9", "stripePriceId": "price_x", "tenantId": "t1"}, "update": {"active": true, "stripeItemId": "si_9", "stripePriceId": "price_x"}, "where": {"tenantId_addonKey": {"addonKey": "REGULATED_ITEMS", "tenantId": "t1"}}}

    Number of calls: 1

      563 |     await svc.enableAddon("t1", "REGULATED_ITEMS", "price_x");
      564 |
    > 565 |     expect(prisma.tenantAddon.upsert).toHaveBeenCalledWith(
          |                                       ^
      566 |       expect.objectContaining({ create: expect.objectContaining({ priceSnapshot: 10 }) }),
      567 |     );
      568 |     expect(deltasOf(events, "addon.enabled")).toEqual([]);

      at Object.<anonymous> (billing/addon.service.spec.ts:565:39)

  ● AddonService.enableAddon/disableAddon — B865 ledger (SA-277) › REG-B865-ADMIN disable books −priceSnapshot×qty from the STORED snapshot

    expect(received).toEqual(expected) // deep equality

    - Expected  - 3
    + Received  + 1

    - Array [
    -   -20,
    - ]
    + Array []

      589 |     await svc.disableAddon("t1", "REGULATED_ITEMS");
      590 |
    > 591 |     expect(deltasOf(events, "addon.disabled")).toEqual([-20]);
          |                                                ^
      592 |   });
      593 |
      594 |   it("REG-B865-ADMIN a stripePriceId whose key has no catalog SKU is a 400 before Stripe", async () => {

      at Object.<anonymous> (billing/addon.service.spec.ts:591:48)

  ● AddonService.enableAddon/disableAddon — B865 ledger (SA-277) › REG-B865-ADMIN a stripePriceId whose key has no catalog SKU is a 400 before Stripe

    expect(received).rejects.toBeInstanceOf()

    Received promise resolved instead of rejected
    Resolved to value: {"active": true, "id": "addon1"}

      600 |     });
      601 |
    > 602 |     await expect(svc.enableAddon("t1", "not_in_catalog", "price_x")).rejects.toBeInstanceOf(
          |           ^
      603 |       BadRequestException,
      604 |     );
      605 |     expect(create).not.toHaveBeenCalled();

      at expect (../../../node_modules/jest-cli/node_modules/expect/build/index.js:2116:15)
      at Object.<anonymous> (billing/addon.service.spec.ts:602:11)

  ● AddonService.enableAddon/disableAddon — B865 ledger (SA-277) › PIN P5 (SA-277a D1): a free grant (no stripePriceId) of a published SKU writes priceSnapshot 0 explicitly and books nothing

    expect(jest.fn()).toHaveBeenCalledWith(...expected)

    Expected: ObjectContaining {"create": ObjectContaining {"priceSnapshot": 0}, "update": ObjectContaining {"priceSnapshot": 0}}
    Received: {"create": {"active": true, "addonKey": "REGULATED_ITEMS", "stripeItemId": null, "stripePriceId": null, "tenantId": "t1"}, "update": {"active": true, "stripeItemId": undefined, "stripePriceId": undefined}, "where": {"tenantId_addonKey": {"addonKey": "REGULATED_ITEMS", "tenantId": "t1"}}}

    Number of calls: 1

      620 |     await svc.enableAddon("t1", "REGULATED_ITEMS");
      621 |
    > 622 |     expect(prisma.tenantAddon.upsert).toHaveBeenCalledWith(
          |                                       ^
      623 |       expect.objectContaining({
      624 |         create: expect.objectContaining({ priceSnapshot: 0 }),
      625 |         update: expect.objectContaining({ priceSnapshot: 0 }),

      at Object.<anonymous> (billing/addon.service.spec.ts:622:39)

FAIL src/billing/addon-ledger.spec.ts
  ● Test suite failed to run

    Cannot find module './addon-ledger' from 'billing/addon-ledger.spec.ts'

    However, Jest was able to find:
    	'./addon-ledger.spec.ts'

    You might want to include a file extension in your import, or update your 'moduleFileExtensions', which is currently ['js', 'json', 'ts'].

    See https://jestjs.io/docs/configuration#modulefileextensions-arraystring

       9 |  * it is the RED state for this task.
      10 |  */
    > 11 | import { emitAddonDelta } from "./addon-ledger";
         | ^
      12 | import { BILLING_EVENTS } from "./plan-catalog.constants";
      13 |
      14 | function makeTx(tenantRow: any) {

      at Resolver._throwModNotFoundError (../../../node_modules/jest-cli/node_modules/jest-resolve/build/index.js:863:11)
      at Object.<anonymous> (billing/addon-ledger.spec.ts:11:1)

FAIL src/billing/subscription-mutation.service.spec.ts
  ● SubscriptionMutationService.enableAddon/disableAddon — B865 ledger gating (SA-277) › REG-B865-SELF TRIAL tenant enabling CUSTOMER_PACK_100 ×2 books nothing (activation books it once)

    expect(received).toEqual(expected) // deep equality

    - Expected  - 1
    + Received  + 3

    - Array []
    + Array [
    +   24,
    + ]

      876 |     );
      877 |     const deltas = events.emit.mock.calls.map((c: any[]) => c[3]?.amountDelta);
    > 878 |     expect(deltas).toEqual([]);
          |                    ^
      879 |   });
      880 |
      881 |   it("REG-B865-SELF disable books −stored snapshot, not −catalog", async () => {

      at Object.<anonymous> (billing/subscription-mutation.service.spec.ts:878:20)

  ● SubscriptionMutationService.enableAddon/disableAddon — B865 ledger gating (SA-277) › REG-B865-SELF disable books −stored snapshot, not −catalog

    expect(received).toBe(expected) // Object.is equality

    Expected: -18
    Received: -24

      893 |     await svc.disableAddon("t1", "CUSTOMER_PACK_100");
      894 |
    > 895 |     expect(deltaOf(events, BILLING_EVENTS.ADDON_DISABLED)).toBe(-18); // 9 × 2, not 12 × 2
          |                                                            ^
      896 |   });
      897 | });
      898 |

      at Object.<anonymous> (billing/subscription-mutation.service.spec.ts:895:60)

Test Suites: 3 failed, 3 total
Tests:       7 failed, 153 passed, 160 total
Snapshots:   0 total
Time:        0.85 s, estimated 2 s
```

## Mapping to the plan's wrongValues

| Test                                      | wrongValue (plan)                     | Observed                                                                                             |
| ----------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| T8 (REG-B865-ADMIN priced enable, paying) | `undefined`                           | `priceSnapshot` absent from the upsert payload entirely (received object has no `priceSnapshot` key) |
| T9 (REG-B865-ADMIN priced enable, TRIAL)  | `undefined`                           | same — no `priceSnapshot` written                                                                    |
| T10 (REG-B865-ADMIN disable)              | `[]`                                  | `Array []` vs expected `[-20]`                                                                       |
| T11 (REG-B865-ADMIN no-SKU stripePriceId) | `resolved`                            | "Received promise resolved instead of rejected"                                                      |
| T12 (REG-B865-SELF TRIAL enable)          | `[24]`                                | `Array [24]` vs expected `[]`                                                                        |
| T13 (REG-B865-SELF disable)               | `-24`                                 | `Received: -24` vs expected `-18`                                                                    |
| T14 (REG-B865-LEDGER)                     | `Cannot find module './addon-ledger'` | exact match — module doesn't exist yet                                                               |

## Files touched (test-only, per task scope)

- `apps/api/src/billing/addon.service.spec.ts` — harness (`tenant.findUniqueOrThrow`, `$queryRaw`,
  `$transaction`, 7th ctor arg `events`, new `Opts.tenantRow`, `deltasOf` helper), T8–T11, P5, P6,
  and the B342 race-test fixture swap (`ai_scanning`/`price_1` → `msrp`/`MSRP`, per the
  test-plan's harness note — that test's catalog stub is now consulted unconditionally once the
  fix lands).
- `apps/api/src/billing/subscription-mutation.service.spec.ts` — harness (`tx.tenant.findUniqueOrThrow`,
  `tx.$queryRaw`), T12, T13, the P7 fixture edit (`addonRow.priceSnapshot: 12` on the existing
  `:825` disable pin), and the same two tx members added to the standalone REG-F1 race test's
  inline `tx`.
- `apps/api/src/billing/addon-ledger.spec.ts` (new) — T14, importing the not-yet-created
  `./addon-ledger` module.

No implementation file was created or modified (FIX-865A/B/C are separate tasks). `ran: true` —
the jest command above executed to completion (a failing/erroring run, not a skip).
