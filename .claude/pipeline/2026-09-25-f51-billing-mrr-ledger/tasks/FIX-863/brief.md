### FIX-863 — cycle on manual activation + length-preserving external roll

`activateManualSubscription`, after `const periodEnd = …`:

```ts
// B863 / SA-277: 365-day prepaid = ANNUAL, shorter = MONTHLY; external rows roll length-preserving (rollCycles).
const cycle: "MONTHLY" | "ANNUAL" = dto.billingPeriodDays >= 365 ? "ANNUAL" : "MONTHLY";
```

Add `cycle,` to BOTH `create` and `update` of the upsert (:965-994). In `rollCycles` (:484-498):

```ts
select: { tenantId: true, cycle: true, periodStart: true, periodEnd: true, externalPayment: true },
// …
const start = s.periodEnd as Date;
// B863 / SA-277: an external (prepaid) row rolls by its OWN prior length (start := old end, end := start + prior
// length); Stripe/catalog rows keep addCycle's calendar clamping (B329 note above).
const priorMs = s.periodStart ? start.getTime() - s.periodStart.getTime() : 0;
const periodEnd =
  s.externalPayment && priorMs > 0 ? new Date(start.getTime() + priorMs) : addCycle(start, s.cycle);
await this.prisma.tenantSubscription.update({ where: { tenantId: s.tenantId }, data: { periodStart: start, periodEnd } });
```
