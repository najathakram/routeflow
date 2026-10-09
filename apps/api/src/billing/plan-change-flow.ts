import { PrismaService } from "../prisma/prisma.service";
import type { Prisma } from "@prisma/client";
import { resolvePlanPrice } from "./plan-price";
import type { BillingEventService } from "./billing-event.service";
import {
  addonsIncludedAtPlan,
  retireIncludedAddonsTx,
  NO_STRIPE_PUSH,
  type AddonRowLike,
  type AddonSkuDef,
  type PlanChangeCtx,
} from "./addon-retirement";
import {
  markNeedsReconcile,
  pushPlanChange,
  revertPlanChange,
  type DeletableAddonItem,
  type PlanChangeDeps,
  type PlanChangeProration,
  type PlanChangePush,
} from "./plan-change-stripe";

/**
 * SA-733r [M7]: the Stripe-first shape every PRICE-MOVING plan write shares — the tenant upgrade, the admin
 * plan edit, and (wired by the cron's owner) the scheduled downgrade:
 *
 *   1. `beginStripeFirstPlanChange` pushes the RESOLVED price (override beats the plan price) to Stripe, with
 *      the retired add-on items deleted in the same update (plan-change-stripe.ts);
 *   2. the caller starts its own local write (a transaction reading `flow.ctx`, calling `flow.retireAddons`);
 *   3. `flow.settle(write)`: if that write throws for ANY reason, Stripe is put back (one compensating
 *      update), the add-on pointers a re-created item changed are rewritten, and the original error is
 *      rethrown. If the compensation fails, `markNeedsReconcile` raises the alert — Stripe is never left
 *      silently ahead.
 *
 * A tenant with no Stripe subscription (or Stripe off) skips step 1: no Stripe read, no extra query.
 */

export interface PlanChangeFlowDeps extends Omit<PlanChangeDeps, "stripe"> {
  prisma: PrismaService;
  /** Absent in an environment without Stripe wired (a spec, a script): the push is skipped. */
  stripe?: PlanChangeDeps["stripe"] | null;
}

export interface PlanChangeFlowArgs {
  tenantId: string;
  stripeSubId: string | null | undefined;
  targetPlanKey: string;
  targetPlanVersionId: string;
  targetPlanName: string;
  /** The RESOLVED price; null when the target has no catalog price and the row no override. */
  price: { monthly: number; annual: number } | null;
  proration: PlanChangeProration;
  /** An upgrade retires the add-ons the new plan includes (B1103); a downgrade/same-rank change does not. */
  retireAddons: boolean;
  addonSkus: readonly AddonSkuDef[];
  localState?: Record<string, unknown>;
}

/** A plan change whose Stripe half has run: the context for the local write, and its compensation. */
export interface StripeFirstPlanChange {
  /** What Stripe settled — the ledger event records its idempotency key. */
  ctx: PlanChangeCtx;
  /**
   * B1103, INSIDE the local write's transaction: retire the add-ons the new plan includes (a no-op unless the
   * flow was begun with `retireAddons`).
   */
  retireAddons(
    tx: Prisma.TransactionClient,
    events: BillingEventService,
    o: { manualPay: boolean; tenantLabel: string; actorId?: string | null },
  ): Promise<unknown>;
  /**
   * Await the local write through this. If it rejects (for ANY reason) and Stripe was pushed, Stripe is put
   * back before the SAME error is rethrown. The write is started by the caller, so its code keeps its shape.
   */
  settle<T>(write: Promise<T>): Promise<T>;
}

export async function beginStripeFirstPlanChange(
  deps: PlanChangeFlowDeps,
  a: PlanChangeFlowArgs,
): Promise<StripeFirstPlanChange> {
  const { prisma, logger } = deps;
  const retireWith =
    (ctx: PlanChangeCtx): StripeFirstPlanChange["retireAddons"] =>
    (tx, events, o) =>
      a.retireAddons
        ? retireIncludedAddonsTx(tx, events, {
            tenantId: a.tenantId,
            toPlanKey: a.targetPlanKey,
            toPlanName: a.targetPlanName,
            addonSkus: a.addonSkus,
            ctx,
            ...o,
          })
        : Promise.resolve([]);
  if (!a.stripeSubId || !deps.stripe) {
    return {
      ctx: NO_STRIPE_PUSH,
      retireAddons: retireWith(NO_STRIPE_PUSH),
      settle: (write) => write,
    };
  }
  const stripe = deps.stripe;

  const rows = (await prisma.tenantAddon.findMany({
    where: { tenantId: a.tenantId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })) as unknown as AddonRowLike[];
  const knownAddonItemIds = new Set(
    rows.map((r) => r.stripeItemId).filter((id): id is string => !!id),
  );
  const deleteItems: DeletableAddonItem[] = a.retireAddons
    ? addonsIncludedAtPlan(rows, a.addonSkus, a.targetPlanKey)
        .filter((r) => !r.isComp && r.stripeItemId) // a comp row owns no billed item: no Stripe call
        .map((r) => ({ itemId: r.stripeItemId as string, rowId: r.id }))
    : [];

  const push = await pushPlanChange(
    { stripe, logger },
    {
      tenantId: a.tenantId,
      stripeSubId: a.stripeSubId,
      targetPlanVersionId: a.targetPlanVersionId,
      planName: a.targetPlanName,
      price: a.price,
      proration: a.proration,
      knownAddonItemIds,
      deleteItems,
      localState: a.localState,
    },
  );

  const ctx: PlanChangeCtx = {
    pushed: push.pushed,
    settledItemIds: push.settledItemIds,
    idempotencyKey: push.key,
  };
  return {
    ctx,
    retireAddons: retireWith(ctx),
    settle: async (write) => {
      try {
        return await write;
      } catch (err) {
        if (push.pushed) await compensate({ prisma, stripe, logger }, push, a, err);
        throw err;
      }
    },
  };
}

/** `begin` + the local write + `settle`, for a caller whose write is a closure over the context. */
export async function runStripeFirstPlanChange<T>(
  deps: PlanChangeFlowDeps,
  a: PlanChangeFlowArgs,
  commit: (ctx: PlanChangeCtx) => Promise<T>,
): Promise<T> {
  const flow = await beginStripeFirstPlanChange(deps, a);
  return flow.settle(commit(flow.ctx));
}

async function compensate(
  deps: PlanChangeFlowDeps & { stripe: PlanChangeDeps["stripe"] },
  push: PlanChangePush,
  a: PlanChangeFlowArgs,
  cause: unknown,
): Promise<void> {
  const { prisma, stripe, logger } = deps;
  const alert = (error: unknown) =>
    markNeedsReconcile(logger, {
      tenantId: a.tenantId,
      stripeSubId: push.stripeSubId,
      key: push.key,
      local: a.localState,
      stripe: {
        pushedPlanKey: a.targetPlanKey,
        pushedAmountCents: push.newAmountCents,
        proration: push.proration,
        priorItems: push.revert,
        localWriteError: cause instanceof Error ? cause.message : String(cause),
      },
      error,
    });
  let restored;
  try {
    restored = await revertPlanChange({ stripe, logger }, push);
  } catch (revertErr) {
    alert(revertErr);
    return;
  }
  logger.warn(
    `Plan change tenant ${a.tenantId}: the local write failed after Stripe applied it — Stripe restored (${push.key}:revert)`,
  );
  // A deleted add-on item came back under a new id: point its row at it, so a later disable removes the item.
  try {
    for (const r of restored) {
      if (!r.newItemId)
        throw new Error(`restored item for row ${r.rowId} not found in Stripe's reply`);
      await prisma.tenantAddon.updateMany({
        where: { id: r.rowId },
        data: { stripeItemId: r.newItemId },
      });
    }
  } catch (pointerErr) {
    alert(pointerErr);
  }
}

/**
 * The flow arguments for one plan write, from the rows both callers already hold. The price is the RESOLVED
 * one (the row's custom fee beats the plan price, via the same `resolvePlanPrice` checkout uses).
 */
export function planChangeArgs(p: {
  tenantId: string;
  sub: {
    stripeSubId?: string | null;
    priceOverrideMonthly?: unknown;
    priceOverrideAnnual?: unknown;
    planKey?: string | null;
    basePriceSnapshot?: unknown;
  } | null;
  version: { id: string; addonSkus: readonly AddonSkuDef[] };
  def: { planKey: string; name: string; monthlyPrice?: unknown; annualPrice?: unknown };
  proration: PlanChangeProration;
  retireAddons: boolean;
}): PlanChangeFlowArgs {
  const price = resolvePlanPrice(p.def, {
    monthly: p.sub?.priceOverrideMonthly,
    annual: p.sub?.priceOverrideAnnual,
  });
  return {
    tenantId: p.tenantId,
    stripeSubId: p.sub?.stripeSubId,
    targetPlanKey: p.def.planKey,
    targetPlanVersionId: p.version.id,
    targetPlanName: p.def.name,
    price: price.ok ? { monthly: price.monthly, annual: price.annual } : null,
    proration: p.proration,
    retireAddons: p.retireAddons,
    addonSkus: p.version.addonSkus ?? [],
    localState: {
      fromPlanKey: p.sub?.planKey ?? null,
      toPlanKey: p.def.planKey,
      basePriceSnapshot: p.sub?.basePriceSnapshot != null ? Number(p.sub.basePriceSnapshot) : null,
    },
  };
}
