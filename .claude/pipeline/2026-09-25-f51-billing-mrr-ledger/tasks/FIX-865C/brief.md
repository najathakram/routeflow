### FIX-865C — self-serve sites route through the helper

`subscription-mutation.service.ts` `enableAddon` (:1259-1265) — replace the ADDON_ENABLED emit:

```ts
if (deltaQty !== 0) {
  await emitAddonDelta(tx, this.events, {
    tenantId,
    sku,
    priceSnapshot: skuDef.monthlyPrice,
    deltaQty,
    actorId,
    payload: { quantity: qty, prorated: preview.proratedToday },
  });
  if (sku === "SEAT_EXTRA" && priorQty === 0) {
    /* SEAT_ADDED emit unchanged */
  }
}
```

`disableAddon` (:1318-1329): delete the `version`/`skuDef`/`monthly` catalog read; inside the tx replace the ADDON_DISABLED emit with `await emitAddonDelta(tx, this.events, { tenantId, sku: code, priceSnapshot: addon.priceSnapshot, deltaQty: -addon.quantity, actorId });` (SEAT_FREED unchanged).
