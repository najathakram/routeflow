# Bug test plan — B216 reinstatement-leaves-downgrade-armed (train 4, Run C)

> **Model note:** bug-pipeline policy puts S4 on Fable 5.1. Fable was out of usage credits on 2026-09-10
> (direct probe: HTTP 429), so **Opus 5 wrote this, as the documented fallback.**
> Inputs: `local-assets/handoff/2026-09-09/planning/train4/cause-{brief,refutation,ruling}.md`, re-grounded
> at master `edd379bf`. Nothing drifted: the only intervening commit (#682) touches neither
> `billing.service.ts` nor its spec.
> Sonnet types these tests inside the engine. The red bar is **behavioral**: each REG test must fail
> today on its own wrong value.

## The defect in one paragraph

`BillingService.onPaymentSucceeded` (`apps/api/src/billing/billing.service.ts:555-602`) and
`onCheckoutCompleted` (`:493-552`) reinstate a lapsed tenant through
`transitionAndEmit(... {status:{not:"ACTIVE"}} -> "ACTIVE" ...)`. That call returns `true` only when it wins
the non-ACTIVE->ACTIVE compare-and-swap. Neither handler clears `downgradeToPlanKey`,
`downgradeEffectiveAt` or `retainedUserIds`. A tenant that lapsed with a downgrade armed keeps it through
reinstatement. The 02:00 `applyScheduledDowngrades` sweep (`billing-cron.service.ts:121-176`) filters on
`tenant.status = "ACTIVE"`, so it skipped the stale schedule while the tenant was lapsed and applies it
at the first 02:00 after reactivation. The results are a plan flip, a second MRR delta, and
non-retained staff deactivated. The fix must clear the schedule **only when `transitionAndEmit` returns
true**. An ordinary renewal of an already-ACTIVE tenant (CAS count 0) must leave a legitimate, freshly
scheduled downgrade alone.

## Where the tests go

Everything goes in **one existing file**: `apps/api/src/billing/billing.service.spec.ts`. Tests are
unit-only, per cause-ruling ("unit for the rest"). No `*.db.spec.ts` exists or is warranted for B216.

Add a **new top-level `describe`** placed right after the
`describe("BillingService — Stripe churn/reactivation MRR ledger", ...)` block closes. That is the
`});` just before the `/** BillingService.syncStripeSubscriptionPrice ...` doc comment. Reuse the
file's module-scope `make()`, `deltaOf` and `emitted` helpers. **Do not modify `make()`.**

Describe title: `"B216 — a Stripe reinstatement disarms a downgrade scheduled before the lapse"`. It must
contain `B216` but **not** `REG-B216`, so `-t "REG-B216"` selects only the red set.

Local fixtures, declared inside the describe:

```ts
// A subscription that lapsed with a downgrade armed (scheduled while ACTIVE, then the tenant dropped out).
const armedSub = (over: Record<string, unknown> = {}) => ({
  tenantId: "t1",
  planKey: "BUSINESS",
  basePriceSnapshot: 349,
  discount: 0,
  stripeSubId: null,
  downgradeToPlanKey: "STARTER",
  downgradeEffectiveAt: new Date("2026-08-01T00:00:00.000Z"),
  retainedUserIds: ["u-keep"],
  ...over,
});
// The tenantSubscription.update call that touches the downgrade schedule, if any.
const disarmCall = (prisma: any) =>
  prisma.tenantSubscription.update.mock.calls.find(
    (c: any[]) => c[0]?.data && "downgradeToPlanKey" in c[0].data,
  );
const DISARMED = {
  where: { tenantId: "t1" },
  data: { downgradeToPlanKey: null, downgradeEffectiveAt: null, retainedUserIds: [] },
};
const checkoutSession = { metadata: { tenantId: "t1" }, subscription: "sub_1", customer: "cus_1" };
```

## Red set (REG-tagged; in the red gate)

| T#  | Title (starts with REG-B216)                                                                                      | Setup                                                                                                                                        | Asserts (one oracle)                                                                                                                                                                                              | Fails TODAY with                                                                                                                                                                                                          | After fix                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| T1  | `REG-B216-A onPaymentSucceeded reinstatement (CAS won) disarms the armed downgrade`                               | `make({ sub: armedSub(), transitionCount: 1 })`; `await (svc as any).onPaymentSucceeded({ customer: "cus_1" })`                              | `expect(disarmCall(prisma)?.[0]).toEqual(DISARMED)`                                                                                                                                                               | expected the `DISARMED` object, **received `undefined`**: no `tenantSubscription.update` call carries `downgradeToPlanKey`. With `stripeSubId: null` the handler issues **zero** `tenantSubscription.update` calls today. | the disarm call exists with exactly that shape                                                 |
| T2  | `REG-B216-B onCheckoutCompleted reinstatement (CAS won) disarms the armed downgrade`                              | `make({ sub: armedSub(), transitionCount: 1 })` (the `upsert` mock returns `sub`); `await (svc as any).onCheckoutCompleted(checkoutSession)` | `expect(disarmCall(prisma)?.[0]).toEqual(DISARMED)`                                                                                                                                                               | expected the `DISARMED` object, **received `undefined`**. Only `upsert` is written today, never `update`.                                                                                                                 | the disarm call exists with exactly that shape                                                 |
| T3  | `REG-B216-C onPaymentSucceeded with a live Stripe sub writes the disarm as its own update after the period write` | `make({ sub: armedSub({ stripeSubId: "sub_1" }), transitionCount: 1 })`; `await (svc as any).onPaymentSucceeded({ customer: "cus_1" })`      | `expect(prisma.tenantSubscription.update.mock.calls.map((c: any[]) => Object.keys(c[0].data).sort())).toEqual([["periodEnd", "periodStart"], ["downgradeEffectiveAt", "downgradeToPlanKey", "retainedUserIds"]])` | **received `[["periodEnd","periodStart"]]`**: only the pre-CAS period write exists today                                                                                                                                  | two writes: the unchanged period update (before the CAS), then the separate three-field disarm |

**Why T3 exists:** it pins the disarm as a _separate_ write. A builder who folds the three fields into
the period-date `update` at `billing.service.ts:598-611` would clear the schedule _before_ the CAS and on
every renewal. T3 goes red on that mistake (one write, five keys), and pin T4 catches its renewal half.

`toEqual` in T1/T2 is deliberate. The disarm writes **exactly** the three downgrade fields. It must
**not** set `cancelAtPeriodEnd`: Stripe's `customer.subscription.updated` owns that flag, and a
reinstatement is not a cancellation (unlike `onSubscriptionDeleted`'s `cancelAtPeriodEnd: true`).

## Pins (no REG token; outside the red gate; must PASS today and after)

| T#  | Title                                                                                                | Setup                                                                                                                                | Frozen behavior (one oracle)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T4  | `pin B216: an ordinary renewal (CAS count 0) leaves a scheduled downgrade armed`                     | `make({ sub: armedSub({ stripeSubId: "sub_1" }), transitionCount: 0 })`; `onPaymentSucceeded({ customer: "cus_1" })`                 | `expect(disarmCall(prisma)).toBeUndefined()`. This guards the refutation's refinement: a renewal of an ACTIVE tenant must never wipe a downgrade that tenant legitimately scheduled. It also catches a disarm merged into the period update.                                                                                                                                                                                                                                                        |
| T5  | `pin B216: a checkout that loses the CAS (tenant already ACTIVE) leaves a scheduled downgrade armed` | `make({ sub: armedSub(), transitionCount: 0 })`; `onCheckoutCompleted(checkoutSession)`                                              | `expect(disarmCall(prisma)).toBeUndefined()`                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| T6  | `pin B216: a reinstatement emits SUBSCRIPTION_RESUMED exactly once (no resume() double emit)`        | `make({ sub: armedSub(), transitionCount: 1 })`; `onPaymentSucceeded({ customer: "cus_1" })`                                         | `expect(emitted(events).filter((t: string) => t === BILLING_EVENTS.SUBSCRIPTION_RESUMED)).toHaveLength(1)`                                                                                                                                                                                                                                                                                                                                                                                          |
| T7  | `pin B216: suspending an overdue tenant leaves a scheduled downgrade armed`                          | `make({ sub: armedSub({ stripeSubId: "sub_1" }), stripeStatus: "unpaid", transitionCount: 1 })`; `await svc.suspendOverdueTenants()` | `expect(disarmCall(prisma)).toBeUndefined()`, after `expect(tx.tenant.updateMany).toHaveBeenCalled()` proves the suspension CAS really ran (non-vacuity). This is the fourth `transitionAndEmit` site, the ONE that must never disarm: an overdue tenant keeps the downgrade it legitimately scheduled while ACTIVE, so the sweep can still apply it on reinstatement. Backs acceptance criterion 6 (build-plan: the suspension transition `suspendOverdueTenants`, `:764`, still does not disarm). |

Existing tests already freeze the sibling handlers. They stay untouched and must stay green after WP1
spreads the shared helper into them:

- `billing.service.spec.ts:128-140` (`onSubscriptionDeleted` disarm, `toMatchObject` on `calls[0]`)
- `billing.service.spec.ts:151-160` (`onSubscriptionUpdated` arms cancel -> disarm)
- `billing.service.spec.ts:162-172` (ordinary update -> `not.toHaveProperty` on the three keys)

## Harness notes (verified by the engine's harness-integrity check)

- `make()` (`billing.service.spec.ts:33-86`) builds `new BillingService(prisma, stripe, email, tenantStatus, events)`
  with **5 of the 6** constructor args, so `pricing` is `undefined`. The fix touches only `this.prisma`, so
  this is harmless. **Remedy if a builder reaches for `this.pricing` in either handler: don't. It is
  out of the fix design and would throw here.**
- `prisma.tenantSubscription.update` is already a `jest.fn().mockResolvedValue({})` in `make()`, so
  no mock gains a method.
- `tx` in `make()` has no `tenantSubscription`. The disarm must use `this.prisma`, **not** the CAS `tx`
  (by design; see build-plan WP1). A builder who moves it into `tx` gets
  `TypeError: Cannot read properties of undefined (reading 'update')`. That is a design violation, not
  a harness gap.
- The existing `onPaymentSucceeded`/`onCheckoutCompleted` tests (`:198-239`) never assert on
  `tenantSubscription.update`, so the new disarm write breaks none of them. The default `make()` sub has
  `stripeSubId: null`, so the period write is skipped there.
- `SubscriptionMutationService` is not injected into `BillingService` and must not become so. `resume()`
  (`subscription-mutation.service.ts:782-798`) emits `SUBSCRIPTION_RESUMED` a second time.

## Commands

- `redGate.commands`: `cd apps/api && npx jest src/billing/billing.service.spec.ts --runInBand -t "REG-B216"`,
  expected to fail. T1 must show received `undefined`, T2 received `undefined`, and T3 received
  `[["periodEnd","periodStart"]]`.
- Pins: `cd apps/api && npx jest src/billing/billing.service.spec.ts --runInBand -t "pin B216"`. Must pass
  before and after.
- Registry proof lines at close-out: `REG-B216-A`, `REG-B216-B`, `REG-B216-C` (and the revert-probe result).
