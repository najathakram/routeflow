### FIX-864 — gate the override emit in-tx under the tenant lock; lock activation too

Replace the `$transaction` body of `updateTenantPriceOverride` (:1441-1463):

```ts
await this.prisma.$transaction(async (tx) => {
  // B864 / SA-277 (SA-163 shape): lock → read paying-set inputs → decide; a racing activation serialises here.
  await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${id} FOR UPDATE`;
  // Re-read the subscription UNDER the lock: backfillBase must be decided from the locked row, not
  // from `existing` read before the tx (a racing activation could have written the snapshot).
  const row = await tx.tenant.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      class: true,
      deletedAt: true,
      subscription: { select: { planKey: true } },
    },
  });
  await tx.tenantSubscription.upsert({/* unchanged */});
  // Snapshot written regardless; ONLY the emit is gated — a non-paying tenant books once, at activation.
  if (backfillBase && isPayingRow(row, row.subscription?.planKey ?? null)) {
    await this.billingEventService.emit(
      id,
      BILLING_EVENTS.PLAN_CHANGED,
      { toPlan: existing.planKey, platformAdmin: true, priceOverrideBackfill: true },
      { amountDelta: roundMoney(dto.monthly!), actorId: adminId, tx },
    );
  }
});
```

Fix the :1432-1435 comment (a set snapshot IS rewritten by `reconcilePriceLedger`). In `activateManualSubscription`'s tx (:938) insert as the FIRST statement:

```ts
// B864 / SA-277 (D2): same tenant row lock as updateStatus/updateTenantClass/updateTenantPriceOverride.
await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${id} FOR UPDATE`;
```
