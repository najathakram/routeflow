import { lockTenantForLedger } from "./addon-ledger";
import { PAYMENT_OVERDUE_REASON, READ_ONLY_STATUS } from "./dunning-config";
import { type DunningDeps, type DunningRow, isStripeMissing } from "./dunning-core";
import { BILLING_EVENTS } from "./plan-catalog.constants";
import type { PauseExit } from "./transition-to-active";

/** Thrown inside the pause transaction to roll back the subscription CAS when the status CAS lost. */
class PauseRollback extends Error {}

/** Interactive-transaction budget for a transaction that makes one Stripe call while holding the lock. */
const STRIPE_IN_TX_TIMEOUT_MS = 15_000;

/**
 * SA-733r7 PR-B3 (D4): the pause. ONE transaction, Tenant row lock first, then the subscription:
 *
 *   1. the tenant must still be ACTIVE;
 *   2. CAS on the subscription: `updateMany(pausedAt null, pastDueInvoiceId = X, no catch-up claim)` - count 0 means
 *      another sweep paused it, or `invoice.paid` resumed it first: NO pause;
 *   3. ACTIVE -> READ_ONLY(`payment_overdue`) through `transitionAndEmit` (the −MRR delta, booked once), joined to
 *      this transaction. If that CAS loses after the subscription CAS won, everything rolls back.
 *
 * Returns true when THIS call paused the tenant. The Stripe `pause_collection` call is the caller's job, AFTER commit.
 */
export async function pauseTenantTx(
  deps: DunningDeps,
  row: Pick<DunningRow, "tenantId">,
  invoiceId: string,
  now: Date,
): Promise<boolean> {
  const { tenantId } = row;
  try {
    return await deps.prisma.$transaction(async (tx) => {
      await lockTenantForLedger(tx, tenantId);
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { status: true },
      });
      if (tenant?.status !== "ACTIVE") return false;
      const cas = await tx.tenantSubscription.updateMany({
        where: { tenantId, pausedAt: null, pastDueInvoiceId: invoiceId, catchupState: null },
        data: { pausedAt: now },
      });
      if (cas.count === 0) return false;
      const moved = await deps.transition(
        tenantId,
        { status: "ACTIVE" },
        READ_ONLY_STATUS,
        -1,
        BILLING_EVENTS.SUBSCRIPTION_SUSPENDED,
        { source: "dunning", reason: PAYMENT_OVERDUE_REASON, invoiceId },
        { tx, data: { readOnlyReason: PAYMENT_OVERDUE_REASON } },
      );
      if (!moved) throw new PauseRollback();
      return true;
    });
  } catch (err) {
    if (err instanceof PauseRollback) return false;
    throw err;
  }
}

/**
 * After the pause commits: tell Stripe to void the invoices it creates while the tenant is paused (SA-733r2 R17-1).
 * Key (tenant, "pause", pausedAt ISO). A failure never undoes the local pause - the hourly reconciler corrects it.
 */
export async function setPauseCollection(
  deps: DunningDeps,
  target: { tenantId: string; stripeSubId: string },
  pausedAt: Date,
): Promise<boolean> {
  try {
    await deps.stripe.updateSubscription(
      target.stripeSubId,
      { pause_collection: { behavior: "void" } },
      { idempotencyKey: `${target.tenantId}:pause:${pausedAt.toISOString()}` },
    );
    return true;
  } catch (err) {
    deps.logger.error(
      `billing.dunning.pause_collection_failed tenant=${target.tenantId}: ${(err as Error)?.message} - the reconciler will correct Stripe`,
    );
    return false;
  }
}

/**
 * After ANY exit from `payment_overdue` commits (resume, admin activation, extendTrial): clear `pause_collection`.
 * Key (tenant, "unpause", exitAt ISO). `throwOnError` is for a webhook, whose redelivery retries it (SA-733r4 F4 #6).
 */
export async function clearPauseCollection(
  deps: DunningDeps,
  exit: PauseExit,
  opts: { throwOnError?: boolean } = {},
): Promise<boolean> {
  try {
    await deps.stripe.updateSubscription(
      exit.stripeSubId,
      { pause_collection: "" },
      { idempotencyKey: `${exit.tenantId}:unpause:${exit.exitAt.toISOString()}` },
    );
    return true;
  } catch (err) {
    if (isStripeMissing(err)) return true; // the subscription is gone: nothing to unpause
    deps.logger.error(
      `billing.dunning.unpause_failed tenant=${exit.tenantId}: ${(err as Error)?.message} - the reconciler will correct Stripe`,
    );
    if (opts.throwOnError) throw err;
    return false;
  }
}

export interface ReconcileOutcome {
  checked: number;
  corrected: number;
  failed: number;
}

/**
 * SA-733r3 F4 / r4 #5: `pausedAt` set <=> Stripe `pause_collection` set. Per Stripe-billed tenant: read Stripe FIRST,
 * then read local under the Tenant `FOR UPDATE`, and make the corrective call while holding that lock. Scope:
 * `stripeSubId` set and Stripe status not `canceled`. Key (tenant, "reconcile", runAt ISO). Local is the truth.
 */
export async function reconcilePauseCollection(
  deps: DunningDeps,
  runAt: Date,
  maxRows = 1000,
): Promise<ReconcileOutcome> {
  const out: ReconcileOutcome = { checked: 0, corrected: 0, failed: 0 };
  const rows = await deps.prisma.tenantSubscription.findMany({
    where: { stripeSubId: { not: null }, externalPayment: false, tenant: { deletedAt: null } },
    select: { tenantId: true, stripeSubId: true },
    orderBy: { tenantId: "asc" },
    take: maxRows,
  });
  for (const r of rows) {
    const subId = r.stripeSubId as string;
    try {
      const stripeSub = await deps.stripe.getSubscription(subId);
      if (stripeSub?.status === "canceled") continue;
      const stripePaused = !!stripeSub?.pause_collection;
      out.checked++;
      const fixed = await deps.prisma.$transaction(
        async (tx) => {
          await lockTenantForLedger(tx, r.tenantId);
          const local = await tx.tenantSubscription.findUnique({
            where: { tenantId: r.tenantId },
            select: { pausedAt: true, stripeSubId: true },
          });
          if (!local || local.stripeSubId !== subId) return false;
          const wantPaused = !!local.pausedAt;
          if (wantPaused === stripePaused) return false;
          await deps.stripe.updateSubscription(
            subId,
            { pause_collection: wantPaused ? { behavior: "void" } : "" },
            { idempotencyKey: `${r.tenantId}:reconcile:${runAt.toISOString()}` },
          );
          deps.logger.error(
            `billing.dunning.pause_collection_reconciled tenant=${r.tenantId} local_paused=${wantPaused} stripe_paused=${stripePaused}`,
          );
          return true;
        },
        { timeout: STRIPE_IN_TX_TIMEOUT_MS },
      );
      if (fixed) out.corrected++;
    } catch (err) {
      if (isStripeMissing(err)) continue;
      out.failed++;
      deps.logger.warn(
        `billing.dunning.reconcile_failed tenant=${r.tenantId}: ${(err as Error)?.message}`,
      );
    }
  }
  return out;
}
