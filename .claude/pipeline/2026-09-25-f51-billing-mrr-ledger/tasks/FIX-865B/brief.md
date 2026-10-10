### FIX-865B — admin AddonService routes through the helper

`addon.service.ts`: ctor arg 7 `private readonly events: BillingEventService` (same module, no module change). In `enableAddon` replace the `const sku = LEGACY_ADDON_KEY_TO_SKU[addonKey]; if (sku) {…}` block:

```ts
const sku = LEGACY_ADDON_KEY_TO_SKU[addonKey] ?? addonKey;
const published = await this.catalog.getPublishedCatalog();
const skuDef = published.addonSkus.find((s) => s.sku === sku);
if (LEGACY_ADDON_KEY_TO_SKU[addonKey] && !skuDef)
  throw new BadRequestException(/* existing message */);
// B865 / SA-277: a billed add-on must be priceable from the catalog — fail closed BEFORE any Stripe write.
if (stripePriceId && !skuDef) {
  throw new BadRequestException(
    `Add-on "${addonKey}" has no catalog SKU to price — publish a catalog version defining "${sku}" before billing it`,
  );
}
// D1 (SA-277a): only a Stripe-billed enable carries revenue; a free grant is priced EXPLICITLY at 0 and books nothing.
const priceSnapshot = stripePriceId && skuDef ? Number(skuDef.monthlyPrice) : 0;
```

Stripe item create unchanged. Replace the bare upsert with a tx:

```ts
const addon = await this.prisma.$transaction(async (tx) => {
  const row = await tx.tenantAddon.upsert({
    where: { tenantId_addonKey: { tenantId, addonKey } },
    create: {
      tenantId,
      addonKey,
      sku,
      stripePriceId: stripePriceId ?? null,
      stripeItemId,
      active: true,
      priceSnapshot,
    },
    update: {
      active: true,
      sku,
      stripePriceId: stripePriceId ?? undefined,
      stripeItemId: stripeItemId ?? undefined,
      priceSnapshot,
    },
  });
  await emitAddonDelta(tx, this.events, {
    tenantId,
    sku,
    priceSnapshot,
    deltaQty: row.quantity ?? 1,
  });
  return row;
});
```

("already active" ConflictException stays → deltaQty is the full qty.) In `disableAddon`, after the Stripe delete:

```ts
const updated = await this.prisma.$transaction(async (tx) => {
  const row = await tx.tenantAddon.update({
    where: { tenantId_addonKey: { tenantId, addonKey } },
    data: { active: false, stripeItemId: null },
  });
  if (addon.active) {
    await emitAddonDelta(tx, this.events, {
      tenantId,
      sku: LEGACY_ADDON_KEY_TO_SKU[addonKey] ?? addonKey,
      priceSnapshot: addon.priceSnapshot,
      deltaQty: -addon.quantity,
    });
  }
  return row;
});
```
