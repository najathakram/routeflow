import { Prisma } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { BILLING_EVENTS, normalizePlanKey, planKeyToEnum } from "./plan-catalog.constants";
import { isPayingRow } from "./mrr.service";
import { paymentReinstatableWhere } from "./dunning-config";
import { isNeverActivated } from "./self-serve-plan-gate";
import {
  STRIPE_CHECKOUT_LINK_ENTITY,
  STRIPE_CHECKOUT_LINKED_ACTION,
} from "./config-snapshot-audit.constants";
import { pinPlanVersionTx } from "./plan-version-pin";
import { transitionToActiveTx, type PauseExit } from "./transition-to-active";
import type { BillingEventService } from "./billing-event.service";

/**
 * SA-774r7 (1): the card-first ACTIVATION, by `subscribe()`'s booking rule. A settled card-first checkout activates the
 * tenant and books MRR exactly once, inside the checkout's apply transaction: it never takes the resume CAS
 * (`transitionAndEmit(SUBSCRIPTION_RESUMED)`), which would book the same contribution a second time.
 */

/** The tenant and subscription rows as they were BEFORE the plan is written (read under the tenant lock). */
export interface ActivationBase {
  tenant: {
    status: string;
    readOnlyReason: string | null;
    deletedAt: Date | null;
    class: string;
  } | null;
  sub: {
    planKey: string | null;
    basePriceSnapshot: Prisma.Decimal | null;
    couponFull: boolean;
  } | null;
}

/** What an activation did: `locked` = a lock a payment may not lift (nothing was written or booked). */
export interface CardFirstActivation {
  locked: boolean;
  exit: PauseExit | null;
  /** The activation had no catalog version to pin (the caller logs `checkout.unpinned` after the commit). */
  unpinned: boolean;
}

/** Where the version the buyer saw comes from: the Stripe subscription whose LINKED marker holds it, and the session itself. */
export interface ActivationPin {
  subscriptionId: string;
  sessionVersionId: string | null;
}

export async function readActivationBaseTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<ActivationBase> {
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { status: true, readOnlyReason: true, deletedAt: true, class: true },
  });
  const sub = await tx.tenantSubscription.findUnique({
    where: { tenantId },
    select: { planKey: true, basePriceSnapshot: true, couponFull: true },
  });
  return { tenant, sub };
}

/**
 * `transitionToActiveTx` (emits nothing), then ONE PLAN_CHANGED of `(isPaying ? newBase : 0) - oldPlanMonthly`
 * (`oldPlanMonthly` = the stored snapshot only if the tenant was paying), and TRIAL_CONVERTED (no delta) when the tenant
 * had never been activated (the one trial predicate, `isNeverActivated`). A tenant under a lock a payment may not lift
 * (an administrator's) stays locked: `locked` is true, nothing is booked, and the caller raises the paid-while-locked
 * notice. `row` is the subscription the apply wrote: its snapshot is the new base.
 */
export async function bookCardFirstActivationTx(
  tx: Prisma.TransactionClient,
  events: Pick<BillingEventService, "emit">,
  tenantId: string,
  before: ActivationBase,
  planKey: string,
  row: { basePriceSnapshot?: unknown },
  pin: ActivationPin,
): Promise<CardFirstActivation> {
  const { tenant, sub } = before;
  if (!tenant) return { locked: true, exit: null, unpinned: false };
  const couponFull = sub?.couponFull ?? false;
  const wasPaying = isPayingRow(tenant, sub?.planKey ?? null, couponFull);
  const oldPlanMonthly = wasPaying ? Number(sub?.basePriceSnapshot ?? 0) : 0;
  const neverActivated = isNeverActivated(tenant as never, false);
  const canonical = normalizePlanKey(planKey) ?? planKey;
  const toActive = await transitionToActiveTx(tx, tenantId, {
    data: { plan: planKeyToEnum(canonical) },
    ...(tenant.status === "ACTIVE"
      ? {}
      : { where: { status: { not: "ACTIVE" }, ...paymentReinstatableWhere() } }),
  });
  if (toActive.count !== 1) return { locked: true, exit: null, unpinned: false };
  if (neverActivated) {
    await tx.tenantSubscription.update({
      where: { tenantId },
      data: { trialConvertedAt: new Date() },
    });
    await events.emit(tenantId, BILLING_EVENTS.TRIAL_CONVERTED, { planKey: canonical }, { tx });
  }
  const isPaying = isPayingRow({ ...tenant, status: "ACTIVE" }, canonical, couponFull);
  await events.emit(
    tenantId,
    BILLING_EVENTS.PLAN_CHANGED,
    {
      fromPlan: sub?.planKey ?? null,
      toPlan: canonical,
      source: "stripe",
      reason: "checkout_completed",
    },
    {
      amountDelta: roundMoney((isPaying ? Number(row.basePriceSnapshot ?? 0) : 0) - oldPlanMonthly),
      tx,
    },
  );
  const versionId = await readLinkedVersionIdTx(tx, tenantId, pin);
  if (versionId) {
    await pinPlanVersionTx(tx, tenantId, versionId, {
      kind: "SYSTEM",
      id: null,
      source: "checkout.card_first",
    });
  }
  return { locked: false, exit: toActive.exit, unpinned: !versionId };
}

/**
 * SA-774r7 (R7-3): the catalog version the buyer saw. It is the LINKED marker's `publishedVersionId` (written at the link
 * from the session metadata); a session settled at once was never linked, so its own metadata is the same value. Null =
 * a session no builder made: the caller activates it unpinned. It never pins a version the buyer did not see.
 */
async function readLinkedVersionIdTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  pin: ActivationPin,
): Promise<string | null> {
  const marker = await tx.auditLog.findFirst({
    where: {
      tenantId,
      entityType: STRIPE_CHECKOUT_LINK_ENTITY,
      entityId: pin.subscriptionId,
      action: STRIPE_CHECKOUT_LINKED_ACTION,
    },
    orderBy: { createdAt: "desc" },
    select: { meta: true },
  });
  const fromMarker = (marker?.meta as { publishedVersionId?: unknown } | null)?.publishedVersionId;
  const id = typeof fromMarker === "string" && fromMarker ? fromMarker : pin.sessionVersionId;
  return typeof id === "string" && id ? id : null;
}
