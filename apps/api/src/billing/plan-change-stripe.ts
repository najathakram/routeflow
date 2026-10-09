import {
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { toCents } from "@routeflow/pricing";
import type { StripeService } from "./stripe.service";
import { CHECKOUT_ADDON_EXPAND, checkoutAddonItems } from "./stripe-addon-items";
import { prorationAllowedFor } from "./price-override";
import {
  isLiveStripeSubscriptionStatus,
  isTerminalStripeSubscriptionStatus,
  stripeBaseItem,
  stripeRefId,
} from "./stripe-period";

/**
 * SA-733 D8 / SA-733r [M7]: a plan change reaches Stripe BEFORE the local write (Stripe-first), as ONE
 * `subscriptions.update` — the base item's new inline `price_data` plus `{ id, deleted: true }` for each
 * add-on the new plan includes (B1103). If the local write then fails, ONE compensating update restores the
 * prior items; if that fails too, `markNeedsReconcile` raises an ERROR-level alert. Stripe is never left
 * silently ahead of the local row.
 *
 * Stripe amounts go through `toCents` only (SA-733 D9). No Prisma, no ledger: this file only talks to Stripe.
 */

/** Fixed tenant-facing copy — never a Stripe/internal message. */
export const PLAN_CHANGE_BILLING_FAILED =
  "We couldn't change the plan because billing didn't go through. Nothing was changed. Please try again.";

/**
 * A subscription that is paused or incomplete cannot take a price change; retrying will not help. Says what to
 * do instead, never "try again".
 */
export const PLAN_CHANGE_SUBSCRIPTION_INACTIVE =
  "We couldn't change the plan because the subscription isn't active. Update the payment method, or contact support to reactivate it.";

/** `create_prorations` for an upgrade (the difference lands on the next invoice); `none` for a scheduled downgrade. */
export type PlanChangeProration = "create_prorations" | "none";

/** The Stripe surface this file needs (the real `StripeService`, or a mock of it at the module boundary). */
export type PlanChangeStripe = Pick<
  StripeService,
  "isConfigured" | "getSubscription" | "updateSubscription"
> & { client: any };

export interface PlanChangeDeps {
  stripe: PlanChangeStripe;
  logger: Pick<Logger, "log" | "warn" | "error">;
}

/** An add-on's Stripe item that the new plan makes redundant, with the local row that owns it. */
export interface DeletableAddonItem {
  itemId: string;
  rowId: string;
}

export interface PlanChangePushArgs {
  tenantId: string;
  stripeSubId: string | null | undefined;
  targetPlanKey: string;
  targetPlanVersionId: string;
  planName: string;
  /** The RESOLVED price (a tenant override already beat the plan price); null = nothing resolvable. */
  price: { monthly: number; annual: number } | null;
  proration: PlanChangeProration;
  /** Every Stripe item id a TenantAddon row owns — how the base-plan item is told from an add-on item. */
  knownAddonItemIds: ReadonlySet<string>;
  deleteItems: readonly DeletableAddonItem[];
  /** The local row's state, carried only into the needs-reconcile alert. */
  localState?: Record<string, unknown>;
}

interface PriceData {
  currency: string;
  unit_amount: number;
  recurring: { interval: "month" | "year"; interval_count?: number };
  product: string;
}

interface RevertPlan {
  baseId: string;
  /** The base item's price BEFORE this push. */
  baseBefore: PriceData;
  /** False when the base item was left out of the update (its amount did not change): a revert leaves it alone. */
  baseChanged: boolean;
  restore: { oldItemId: string; rowId: string; price_data: PriceData; quantity: number }[];
}

export interface PlanChangePush {
  /** True when a `subscriptions.update` was sent (and may need reverting). */
  pushed: boolean;
  /** Why nothing was sent (no subscription, Stripe off, a terminal subscription). */
  reason?: string;
  tenantId: string;
  stripeSubId?: string;
  /** The proration behaviour actually SENT (a past_due / unpaid subscription downgrades `create_prorations` to `none`). */
  proration: PlanChangeProration;
  /** The per-attempt idempotency key; the revert uses `${key}:revert`. */
  key?: string;
  nonce?: string;
  /** Add-on item ids confirmed gone from Stripe: deleted by this push, or already absent. */
  settledItemIds: ReadonlySet<string>;
  newAmountCents?: number;
  /** The Stripe product this push created for the new price — a revert checks the base item still carries it. */
  productId?: string;
  revert?: RevertPlan;
}

/** The item's price as a `price_data` that recreates it; null when Stripe's object does not carry a faithful one. */
function priceDataOf(item: any): PriceData | null {
  const price = item?.price;
  const unit = price?.unit_amount;
  const interval = price?.recurring?.interval;
  const product = stripeRefId(price?.product);
  if (!Number.isInteger(unit) || unit < 0 || !product) return null;
  if (interval !== "month" && interval !== "year") return null;
  const count = price.recurring.interval_count;
  return {
    currency: typeof price.currency === "string" && price.currency ? price.currency : "usd",
    unit_amount: unit,
    recurring: {
      interval,
      ...(Number.isInteger(count) && count > 1 ? { interval_count: count } : {}),
    },
    product,
  };
}

/**
 * Send the plan change to Stripe. Resolves `pushed: false` when there is nothing to bill (no subscription,
 * Stripe off, a terminal subscription). THROWS — before any Stripe write — when it cannot do the push
 * faithfully: Stripe unreadable, a subscription that is not live (paused / incomplete), no resolvable price,
 * or items it could not restore on a revert. A failed update throws too: the caller's local row must not move
 * while Stripe still bills the old plan.
 */
export async function pushPlanChange(
  deps: PlanChangeDeps,
  a: PlanChangePushArgs,
): Promise<PlanChangePush> {
  const skipped = (reason: string): PlanChangePush => ({
    pushed: false,
    reason,
    tenantId: a.tenantId,
    proration: a.proration,
    // Nothing to delete from: every pointer the caller holds is moot.
    settledItemIds: new Set(a.deleteItems.map((d) => d.itemId)),
  });
  const { stripe, logger } = deps;
  if (!a.stripeSubId) return skipped("no_stripe_subscription");
  if (!stripe.isConfigured) {
    logger.warn(`Plan change tenant ${a.tenantId}: Stripe is not configured — no push`);
    return skipped("stripe_not_configured");
  }

  let sub: any;
  try {
    sub = await stripe.getSubscription(a.stripeSubId, { expand: CHECKOUT_ADDON_EXPAND });
  } catch (err) {
    logger.error(`Plan change tenant ${a.tenantId}: Stripe read failed: ${(err as Error).message}`);
    throw new ServiceUnavailableException(PLAN_CHANGE_BILLING_FAILED);
  }
  if (isTerminalStripeSubscriptionStatus(sub?.status)) {
    logger.warn(
      `Plan change tenant ${a.tenantId}: Stripe subscription is ${sub?.status} — no push`,
    );
    return skipped(`subscription_${sub?.status}`);
  }
  if (!isLiveStripeSubscriptionStatus(sub?.status)) {
    logger.error(
      `Plan change tenant ${a.tenantId}: Stripe subscription is ${sub?.status} — refusing, it would stay on the old price`,
    );
    throw new ServiceUnavailableException(PLAN_CHANGE_SUBSCRIPTION_INACTIVE);
  }
  // Same rule as the price override: a mid-period proration on a subscription nobody is paying piles
  // credit/charge onto an invoice that will not be settled, so a delinquent subscription gets `none`.
  const proration: PlanChangeProration =
    a.proration === "create_prorations" && !prorationAllowedFor(sub.status) ? "none" : a.proration;
  if (!a.price) {
    throw new BadRequestException(
      "No price is resolvable for this plan — set the tenant's custom monthly fee first.",
    );
  }

  const items: any[] = Array.isArray(sub?.items?.data) ? sub.items.data : [];
  // An add-on item is told from the base-plan item by the ids our rows own AND by the checkout SKU marker on its
  // product (a checkout-made item no row has adopted yet).
  const addonItemIds = new Set([
    ...a.knownAddonItemIds,
    ...checkoutAddonItems(sub).map((i) => i.itemId),
  ]);
  const base = stripeBaseItem(sub, addonItemIds);
  const basePrior = base && !addonItemIds.has(base.id) ? priceDataOf(base) : null;
  if (!basePrior || typeof base?.id !== "string") {
    logger.error(
      `Plan change tenant ${a.tenantId}: no readable base-plan item on ${a.stripeSubId}`,
    );
    throw new ServiceUnavailableException(PLAN_CHANGE_BILLING_FAILED);
  }

  // Only items Stripe still has can be deleted (a stale pointer is already settled); the ones it has are
  // snapshotted so a revert can re-create them.
  const present = new Map<string, any>(items.map((i) => [i.id, i]));
  const settled = new Set<string>();
  const deletes: { itemId: string; rowId: string; price_data: PriceData; quantity: number }[] = [];
  for (const d of a.deleteItems) {
    const item = present.get(d.itemId);
    if (!item) {
      settled.add(d.itemId);
      continue;
    }
    const price_data = priceDataOf(item);
    if (!price_data || !Number.isInteger(item.quantity) || item.quantity < 1) {
      logger.error(`Plan change tenant ${a.tenantId}: add-on item ${d.itemId} is not restorable`);
      throw new ServiceUnavailableException(PLAN_CHANGE_BILLING_FAILED);
    }
    deletes.push({ ...d, price_data, quantity: item.quantity });
  }

  const interval = basePrior.recurring.interval;
  const newAmountCents = toCents(interval === "year" ? a.price.annual : a.price.monthly);
  // A custom-fee tenant moves plan but not price: swapping the item's price would only mint a new Price and
  // net-zero proration lines while the API says "unchanged". Leave the base item out of the update.
  const baseChanged = newAmountCents !== basePrior.unit_amount;
  if (!baseChanged && deletes.length === 0) {
    logger.log(
      `Plan change tenant ${a.tenantId}: base price unchanged, no add-on to delete — no push`,
    );
    return skipped("price_unchanged");
  }
  const nonce = randomUUID();
  const key = `${a.tenantId}:plan-change:${a.targetPlanVersionId}:${nonce}`;

  let productId = basePrior.product;
  if (baseChanged) {
    try {
      const product = await stripe.client.products.create(
        { name: `RouteFlow ${a.planName} — ${interval === "year" ? "annual" : "monthly"}` },
        { idempotencyKey: `${key}:product` },
      );
      productId = product.id;
    } catch (err) {
      logger.error(
        `Plan change tenant ${a.tenantId}: Stripe product failed: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException(PLAN_CHANGE_BILLING_FAILED);
    }
  }

  const newPriceData: PriceData = {
    ...basePrior,
    unit_amount: newAmountCents,
    product: productId,
  };
  // Logged BEFORE the write: if the process dies between Stripe's reply and the local commit, this line (with
  // the key) is how an operator finds the push to reconcile.
  logger.log(
    `billing.plan_change.push ${JSON.stringify({
      tenantId: a.tenantId,
      stripeSubId: a.stripeSubId,
      idempotencyKey: key,
      targetPlanKey: a.targetPlanKey,
      targetPlanVersionId: a.targetPlanVersionId,
      priorAmountCents: basePrior.unit_amount,
      basePriceCents: newAmountCents,
      baseChanged,
      proration,
      deleteItemIds: deletes.map((d) => d.itemId),
    })}`,
  );
  try {
    await stripe.updateSubscription(
      a.stripeSubId,
      {
        items: [
          ...(baseChanged ? [{ id: base.id, price_data: newPriceData }] : []),
          ...deletes.map((d) => ({ id: d.itemId, deleted: true })),
        ],
        proration_behavior: proration,
      },
      { idempotencyKey: key },
    );
  } catch (err) {
    logger.error(
      `Plan change tenant ${a.tenantId}: Stripe update failed: ${(err as Error).message}`,
    );
    throw new ServiceUnavailableException(PLAN_CHANGE_BILLING_FAILED);
  }
  for (const d of deletes) settled.add(d.itemId);
  logger.log(
    `Plan change pushed tenant ${a.tenantId} (${key}): ${basePrior.unit_amount} -> ${newAmountCents} cents ` +
      `(${interval}, proration_behavior=${proration}, ${deletes.length} add-on item(s) deleted)`,
  );

  return {
    pushed: true,
    tenantId: a.tenantId,
    stripeSubId: a.stripeSubId,
    proration,
    key,
    nonce,
    settledItemIds: settled,
    newAmountCents,
    productId,
    revert: {
      baseId: base.id,
      baseBefore: basePrior,
      baseChanged,
      restore: deletes.map((d) => ({
        oldItemId: d.itemId,
        rowId: d.rowId,
        price_data: d.price_data,
        quantity: d.quantity,
      })),
    },
  };
}

/** The pointer rewrite a revert needs: the deleted add-on item was re-created under a NEW id. */
export interface RestoredItem {
  rowId: string;
  oldItemId: string;
  newItemId: string | null;
}

/**
 * Undo a push: ONE `subscriptions.update` putting the base item back on its prior price and re-creating every
 * deleted add-on item (a deleted item cannot be revived; the new one is tagged with the old id so the caller
 * can rewrite `TenantAddon.stripeItemId`). Same proration as the push, so the two nets out. THROWS when Stripe
 * refuses — the caller turns that into {@link markNeedsReconcile}.
 */
export async function revertPlanChange(
  deps: PlanChangeDeps,
  push: PlanChangePush,
): Promise<RestoredItem[]> {
  if (!push.pushed || !push.revert || !push.key || !push.stripeSubId) return [];
  const { baseId, baseBefore, baseChanged, restore } = push.revert;
  const res = await deps.stripe.updateSubscription(
    push.stripeSubId,
    {
      items: [
        ...(baseChanged ? [{ id: baseId, price_data: baseBefore }] : []),
        ...restore.map((r) => ({
          price_data: r.price_data,
          quantity: r.quantity,
          metadata: { restoredFromItem: r.oldItemId },
        })),
      ],
      proration_behavior: push.proration,
    },
    { idempotencyKey: `${push.key}:revert` },
  );
  const created: any[] = Array.isArray(res?.items?.data) ? res.items.data : [];
  return restore.map((r) => ({
    rowId: r.rowId,
    oldItemId: r.oldItemId,
    newItemId:
      created.find(
        (i) => i?.metadata?.restoredFromItem === r.oldItemId && typeof i?.id === "string",
      )?.id ?? null,
  }));
}

export interface NeedsReconcileInfo {
  tenantId: string;
  stripeSubId?: string;
  /** The idempotency key of the push that Stripe applied. */
  key?: string;
  /** What the local row holds (it is NOT where Stripe now is). */
  local?: unknown;
  /** What Stripe now holds after the forward push (the intended state) and what the revert tried to restore. */
  stripe?: unknown;
  error?: unknown;
}

/**
 * SEAM — SA-733r [M7]: "if the revert fails, set `needsReconcile` and alert". Stripe is ahead of the local row
 * and nothing automatic will fix it, so a human must.
 *
 * TODO(SA-733r M7 / B2-B3 migration): `TenantSubscription.needsReconcile` is a COLUMN that ships in the B2/B3
 * migration, NOT in this PR (no schema change here). When it lands, set it in this function (and clear it after
 * the next successful local write, SA-733r3 N4). Until then this raises the ERROR-level structured alert only —
 * grep the logs for `billing.plan_change.needs_reconcile`.
 */
export function markNeedsReconcile(logger: Pick<Logger, "error">, info: NeedsReconcileInfo): void {
  logger.error(
    `billing.plan_change.needs_reconcile ${JSON.stringify({
      event: "billing.plan_change.needs_reconcile",
      severity: "ERROR",
      tenantId: info.tenantId,
      stripeSubId: info.stripeSubId ?? null,
      idempotencyKey: info.key ?? null,
      localState: info.local ?? null,
      stripeState: info.stripe ?? null,
      error: info.error instanceof Error ? info.error.message : (info.error ?? null),
    })}`,
  );
}

/** A plan-change compare-and-set that lost its race is a 409 — kept here so callers share one message. */
export const PLAN_CHANGE_ADDONS_CHANGED = "Add-ons changed concurrently — please retry.";
export const planChangeAddonsChanged = () => new ConflictException(PLAN_CHANGE_ADDONS_CHANGED);
