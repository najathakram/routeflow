### FIX-865A — the ONE add-on ledger helper (new file)

`apps/api/src/billing/addon-ledger.ts` (CREATED; no DI):

```ts
import { Prisma } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { BillingEventService } from "./billing-event.service";
import { BILLING_EVENTS, type BillingEventType } from "./plan-catalog.constants";
import { isPayingRow } from "./mrr.service";

export interface AddonDelta {
  tenantId: string;
  sku: string; // catalog SKU code (caller bridges a legacy addonKey)
  priceSnapshot: unknown; // the STORED TenantAddon.priceSnapshot — never a live catalog read on disable
  deltaQty: number; // +qty enabled / −qty disabled; 0 emits nothing
  actorId?: string | null;
  payload?: Prisma.InputJsonObject;
}

/**
 * B865 / SA-277 — the single add-on ledger writer (L-167): every enable/disable site books through here INSIDE
 * its tx — lock the tenant row (SA-163), read the paying-set inputs under it, emit ±priceSnapshot × deltaQty
 * ONLY for a paying row. A TRIAL tenant's add-on is booked once, at activation, from the same stored snapshot.
 * Returns the amountDelta booked (0 when gated).
 */
export async function emitAddonDelta(
  tx: Prisma.TransactionClient,
  events: BillingEventService,
  d: AddonDelta,
): Promise<number> {
  if (d.deltaQty === 0 || d.priceSnapshot == null) return 0;
  await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${d.tenantId} FOR UPDATE`;
  const row = await tx.tenant.findUniqueOrThrow({
    where: { id: d.tenantId },
    select: {
      status: true,
      class: true,
      deletedAt: true,
      subscription: { select: { planKey: true } },
    },
  });
  if (!isPayingRow(row, row.subscription?.planKey ?? null)) return 0;
  const amountDelta = roundMoney(Number(d.priceSnapshot) * d.deltaQty);
  const type: BillingEventType =
    d.deltaQty > 0 ? BILLING_EVENTS.ADDON_ENABLED : BILLING_EVENTS.ADDON_DISABLED;
  await events.emit(
    d.tenantId,
    type,
    { sku: d.sku, ...(d.payload ?? {}) },
    { amountDelta, actorId: d.actorId, tx },
  );
  return amountDelta;
}
```
