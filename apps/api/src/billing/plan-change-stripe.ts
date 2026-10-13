import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { toCents } from "@routeflow/pricing";
import type { StripeService } from "./stripe.service";
import { CHECKOUT_ADDON_EXPAND, checkoutAddonItems } from "./stripe-addon-items";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { prorationAllowedFor } from "./price-override";
import {
  armNeedsReconcile,
  clearNeedsReconcile,
  markNeedsReconcile,
  type Armed,
  type ReconcilePrisma,
} from "./needs-reconcile";
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
 * SA-733r3 [N4]: when the caller supplies `deps.prisma`, `needsReconcile` + the attempt nonce are COMMITTED
 * before the Stripe write (needs-reconcile.ts) and the push reports whether it armed the flag, so the caller
 * can clear it after the local write.
 *
 * Stripe amounts go through `toCents` only (SA-733 D9). No ledger: this file only talks to Stripe (and, for the
 * flag, the one needs-reconcile module).
 */

/** Fixed tenant-facing copy — never a Stripe/internal message. */
export const PLAN_CHANGE_BILLING_FAILED =
  "We couldn't change the plan because billing didn't go through. Nothing was changed. Please try again.";

/**
 * N4: who reads an error. A plan change a TENANT asked for (the self-serve upgrade) must never show operator
 * wording ("reconcile the subscription", "Stripe now bills $X"); an admin's own plan edit keeps the detail. The
 * default is the tenant: forgetting to say so fails safe.
 */
export type PlanChangeAudience = "tenant" | "admin";

/** Fixed tenant-facing copy for a plan change whose billing outcome is not settled yet - never a Stripe/internal detail. */
export const PLAN_CHANGE_NEEDS_SUPPORT =
  "We couldn't finish changing your plan. Our team has been notified and will sort it out shortly. " +
  "Please don't try again - contact support if you have any questions.";

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
  /** Present in production: the needsReconcile flag is armed before Stripe and raised on a stuck outcome. */
  prisma?: ReconcilePrisma | null;
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
  /** Who reads an error from this push (default: the tenant). */
  audience?: PlanChangeAudience;
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
  /** N4: this attempt raised `needsReconcile` before the Stripe write - the caller clears it after the local write. */
  reconcile?: Armed;
  /** Add-on item ids confirmed gone from Stripe: deleted by this push, or already absent. */
  settledItemIds: ReadonlySet<string>;
  /** True when nothing was sent BUT the live Stripe subscription was read (a custom-fee price that did not change). */
  live?: boolean;
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
    // `live`: the subscription IS live in Stripe and its add-on items were read - the retirement's
    // unsettled-item check must still apply (a row enabled after this read owns an item nobody deleted).
    return { ...skipped("price_unchanged"), live: true };
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
  // N4: the flag and the attempt's audit row (key + nonce) are COMMITTED before Stripe is touched. Unwritable =>
  // nothing was sent, so the caller's row and Stripe still agree.
  let reconcile: Armed | undefined;
  try {
    reconcile = await armNeedsReconcile(deps, {
      tenantId: a.tenantId,
      kind: "plan_change",
      key,
      nonce,
      stripeSubId: a.stripeSubId,
    });
  } catch (err) {
    logger.error(
      `Plan change tenant ${a.tenantId}: could not record needsReconcile before the Stripe write (${(err as Error).message}) - nothing was sent`,
    );
    throw new ServiceUnavailableException(PLAN_CHANGE_BILLING_FAILED);
  }
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
    // The update may have been APPLIED although its reply failed (a timeout, a 5xx after the commit). Re-read
    // Stripe before deciding: an applied push must not be reported as "nothing changed".
    const live = await stripe
      .getSubscription(a.stripeSubId, { expand: CHECKOUT_ADDON_EXPAND })
      .catch(() => null);
    if (!live) {
      // Cannot tell whether Stripe moved: it may now be ahead of the database. Alert, and say so distinctly.
      await markNeedsReconcile(deps, {
        tenantId: a.tenantId,
        stripeSubId: a.stripeSubId,
        key,
        local: a.localState,
        stripe: { attemptedAmountCents: newAmountCents, proration, outcome: "unknown" },
        error: err,
      });
      throw new BadGatewayException({
        code: API_ERROR_CODES.PLAN_CHANGE_STRIPE_AHEAD,
        message:
          a.audience === "admin"
            ? "We could not confirm whether Stripe applied the plan change - reconcile the subscription " +
              "before changing the plan again."
            : PLAN_CHANGE_NEEDS_SUPPORT,
      });
    }
    const liveItems: any[] = Array.isArray(live?.items?.data) ? live.items.data : [];
    const baseApplied =
      !baseChanged ||
      liveItems.find((i) => i?.id === base.id)?.price?.unit_amount === newAmountCents;
    const deletesApplied = deletes.every((d) => !liveItems.some((i) => i?.id === d.itemId));
    if (!(baseApplied && deletesApplied)) {
      // Stripe was READ and did not apply it: local and Stripe still agree - this attempt's flag comes down.
      await clearNeedsReconcile(deps, a.tenantId, reconcile);
      throw new ServiceUnavailableException(PLAN_CHANGE_BILLING_FAILED);
    }
    logger.warn(
      `Plan change tenant ${a.tenantId}: the Stripe update reported a failure but Stripe APPLIED it (${key}) - continuing`,
    );
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
    reconcile,
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

/** A plan-change compare-and-set that lost its race is a 409 — kept here so callers share one message. */
export const PLAN_CHANGE_ADDONS_CHANGED = "Add-ons changed concurrently — please retry.";
export const planChangeAddonsChanged = () => new ConflictException(PLAN_CHANGE_ADDONS_CHANGED);
