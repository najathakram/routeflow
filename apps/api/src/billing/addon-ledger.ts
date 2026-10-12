import { Prisma } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { BillingEventService } from "./billing-event.service";
import { BILLING_EVENTS, type BillingEventType } from "./plan-catalog.constants";
import { isPayingRow } from "./mrr.service";

/** One side (before/after) of an add-on's price × quantity state. A null snapshot prices as 0. */
export interface AddonLedgerSide {
  priceSnapshot: unknown; // the STORED TenantAddon.priceSnapshot — never a live catalog read
  quantity: number;
}

export interface AddonDelta {
  tenantId: string;
  sku: string; // catalog SKU code (caller bridges a legacy addonKey)
  before: AddonLedgerSide;
  after: AddonLedgerSide;
  actorId?: string | null;
  payload?: Prisma.InputJsonObject;
}

/**
 * SA-277a D2 / SA-508 — the house lock order (plan-transition hook → tenant row → subscription/add-on
 * rows → ledger): every $transaction that writes the subscription or add-on rows, or books the ledger,
 * takes this as its FIRST STATEMENT AFTER the plan-transition hook (its first statement where there is
 * no hook), before any TenantAddon/TenantSubscription write, so the tenant row lock is always acquired
 * before any FK-referencing row lock (avoids the FOR KEY SHARE → FOR UPDATE upgrade deadlock).
 * `tenant-lock-order.tripwire.spec.ts` enforces it for every subscription-writing transaction.
 */
export async function lockTenantForLedger(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
}

/**
 * B865 / SA-277 — the single add-on ledger writer (L-167): every enable/disable call site books
 * through here INSIDE its own tx — lock the tenant row (SA-163 shape, via `lockTenantForLedger`),
 * read the paying-set inputs UNDER that lock, and book the priced CHANGE between `before` and
 * `after` ONLY for a currently-paying row (`isPayingRow`, `mrr.service.ts`). A TRIAL tenant's
 * add-on is booked once, at activation/subscribe, from the same stored snapshot, never here.
 *
 * amountDelta = roundMoney(after.priceSnapshot × after.quantity − before.priceSnapshot × before.quantity).
 * A zero delta (e.g. a free grant, or a no-op re-enable at the same price/qty) writes NO event
 * (SA-277a D1). The label follows the MONEY: ADDON_ENABLED when the run-rate grew (amount > 0),
 * ADDON_DISABLED when it shrank. For every plain enable/raise/disable/price change that is the same
 * as reading the quantity (more units cost more); it differs only when quantity and price move
 * together in opposite directions (checkout adoption of a row at a different quantity), where
 * labelling by quantity called a +$45 adoption "disabled". There is no quantity-change event type
 * and nothing reads the label — the run-rate is Σ amountDelta — so no new type is introduced.
 *
 * Returns the amountDelta booked (0 when gated or zero).
 */
export async function emitAddonDelta(
  tx: Prisma.TransactionClient,
  events: BillingEventService,
  d: AddonDelta,
): Promise<number> {
  const beforeAmount = Number(d.before.priceSnapshot ?? 0) * d.before.quantity;
  const afterAmount = Number(d.after.priceSnapshot ?? 0) * d.after.quantity;
  const amountDelta = roundMoney(afterAmount - beforeAmount);
  // SA-277a D1: a free grant / zero net change emits nothing.
  if (amountDelta === 0) return 0;

  await lockTenantForLedger(tx, d.tenantId);
  const row = await tx.tenant.findUniqueOrThrow({
    where: { id: d.tenantId },
    select: {
      status: true,
      class: true,
      deletedAt: true,
      subscription: { select: { planKey: true, couponFull: true } },
    },
  });
  if (!isPayingRow(row, row.subscription?.planKey ?? null, row.subscription?.couponFull ?? false)) {
    return 0;
  }

  const type: BillingEventType =
    amountDelta > 0 ? BILLING_EVENTS.ADDON_ENABLED : BILLING_EVENTS.ADDON_DISABLED;
  await events.emit(
    d.tenantId,
    type,
    { ...(d.payload ?? {}), sku: d.sku },
    { amountDelta, actorId: d.actorId, tx },
  );
  return amountDelta;
}

/** One add-on's priced state, as stored on its TenantAddon row. */
export interface CrossingAddon {
  sku: string;
  priceSnapshot: unknown;
  quantity: number;
}

/**
 * SA-277b — the ONE definition of an add-on's contribution across a paying-set CROSSING (a
 * tenant that was NOT in `isPayingRow`'s set moving into it — TRIAL→paying at `subscribe()`, or
 * a manual activation at `activateManualSubscription`). Both call sites book their kept/prior
 * add-ons through this, which loops `emitAddonDelta` per add-on: `before` is the add-on's stored
 * state when the tenant was ALREADY paying (nothing changes — `emitAddonDelta` nets to 0 and
 * books nothing, since there is no crossing to price) or {0,0} when it was not (the crossing
 * prices the add-on's full contribution for the first time); `after` is always the add-on's
 * current stored state. Returns the total amountDelta booked across all add-ons.
 */
export async function bookAddonsOnCrossing(
  tx: Prisma.TransactionClient,
  events: BillingEventService,
  tenantId: string,
  addons: CrossingAddon[],
  wasPaying: boolean,
  actorId?: string | null,
): Promise<number> {
  let total = 0;
  for (const a of addons) {
    const state: AddonLedgerSide = { priceSnapshot: a.priceSnapshot, quantity: a.quantity };
    const before: AddonLedgerSide = wasPaying ? state : { priceSnapshot: 0, quantity: 0 };
    total += await emitAddonDelta(tx, events, {
      tenantId,
      sku: a.sku,
      before,
      after: state,
      actorId,
    });
  }
  return total;
}
