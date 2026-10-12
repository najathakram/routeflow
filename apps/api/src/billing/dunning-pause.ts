import { lockTenantForLedger } from "./addon-ledger";
import { HOUR_MS, PAYMENT_OVERDUE_REASON, READ_ONLY_STATUS } from "./dunning-config";
import { type DunningDeps, type DunningRow, isStripeMissing } from "./dunning-core";
import { forEachRotated } from "./dunning-paging";
import { BILLING_EVENTS } from "./plan-catalog.constants";
import type { PauseExit } from "./transition-to-active";

/** Thrown inside the pause transaction to roll back the subscription CAS when the status CAS lost. */
class PauseRollback extends Error {}

/** Interactive-transaction budget for a transaction that makes one Stripe call while holding the lock. */
const STRIPE_IN_TX_TIMEOUT_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * SA-733r7 PR-B3 (D4): the pause. ONE transaction, Tenant row lock first, then the subscription:
 *
 *   1. the tenant must still be ACTIVE;
 *   2. CAS on the subscription: `updateMany(pausedAt null, pastDueInvoiceId = X, pastDueSince = the episode the
 *      sweep decided on, no catch-up claim)` - count 0 means another sweep paused it, `invoice.paid` resumed it first,
 *      or the invoice was re-stamped (a NEWER episode, whose own final notice has not gone out): NO pause;
 *   3. ACTIVE -> READ_ONLY(`payment_overdue`) through `transitionAndEmit` (the −MRR delta, booked once), joined to
 *      this transaction. If that CAS loses after the subscription CAS won, everything rolls back.
 *
 * Returns true when THIS call paused the tenant. The Stripe `pause_collection` call is the caller's job, AFTER commit.
 */
export async function pauseTenantTx(
  deps: DunningDeps,
  row: Pick<DunningRow, "tenantId">,
  invoiceId: string,
  since: Date,
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
        where: {
          tenantId,
          pausedAt: null,
          pastDueInvoiceId: invoiceId,
          pastDueSince: since,
          catchupState: null,
        },
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
 * Key (tenant, "pause", pausedAt ISO). Opus re-review: this runs UNLOCKED after the commit, so an `invoice.paid`
 * resume could commit and clear `pause_collection` first and this late set would land last (Stripe paused, local
 * ACTIVE). So the set is made inside a Tenant-lock transaction that re-reads `pausedAt` and SKIPS unless it is still
 * exactly the stamped value (like the reconciler). Returns true when Stripe was told. A failure never undoes the
 * local pause - the hourly reconciler corrects it.
 */
export async function setPauseCollection(
  deps: DunningDeps,
  target: { tenantId: string; stripeSubId: string },
  pausedAt: Date,
): Promise<boolean> {
  try {
    return await deps.prisma.$transaction(
      async (tx) => {
        await lockTenantForLedger(tx, target.tenantId);
        const sub = await tx.tenantSubscription.findUnique({
          where: { tenantId: target.tenantId },
          select: { pausedAt: true },
        });
        if (!sub?.pausedAt || sub.pausedAt.getTime() !== pausedAt.getTime()) {
          deps.logger.log(
            `billing.dunning.pause_collection_skipped tenant=${target.tenantId} (the pause was cleared or replaced before the set)`,
          );
          return false;
        }
        await deps.stripe.updateSubscription(
          target.stripeSubId,
          { pause_collection: { behavior: "void" } },
          { idempotencyKey: `${target.tenantId}:pause:${pausedAt.toISOString()}` },
        );
        return true;
      },
      { timeout: STRIPE_IN_TX_TIMEOUT_MS },
    );
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

export interface ReconcileOptions {
  /** Row budget for one run (default 2000). Over budget, the start rotates hourly so every row is reached. */
  maxRows?: number;
  /** Keyset page size (default 200). */
  batchSize?: number;
  /** Wall-clock budget for one run in ms (default 10 minutes). */
  timeBudgetMs?: number;
}

const RECONCILE_WHERE = {
  stripeSubId: { not: null },
  externalPayment: false,
  tenant: { deletedAt: null },
} as const;

/**
 * SA-733r3 F4 / r4 #5: `pausedAt` set <=> Stripe `pause_collection` set. Per Stripe-billed tenant: read Stripe FIRST,
 * then read local under the Tenant `FOR UPDATE`, and make the corrective call while holding that lock. Scope:
 * `stripeSubId` set and Stripe status not `canceled`. Key (tenant, "reconcile", runAt ISO). Local is the truth.
 *
 * MODES (Opus review): the SET direction (locally paused, Stripe not) is always safe. The UNPAUSE direction removes a
 * pause nobody here put there - on the first `dark` deploy that would erase hand-set dashboard pauses - so it writes
 * ONLY in `enforced`; in `off` / `dark` it LOGS `would_unpause` (the signal for the blast-radius report, which cannot
 * call Stripe).
 *
 * PAGING: a keyset cursor (`tenantId > last`) over the WHOLE population in bounded batches. When the population is
 * larger than the row budget the run starts at a start row that rotates with the hour (`hourIndex * budget mod
 * total`) and wraps around, so successive hourly runs cover every row without a persisted cursor.
 */
export async function reconcilePauseCollection(
  deps: DunningDeps,
  runAt: Date,
  opts: ReconcileOptions = {},
): Promise<ReconcileOutcome> {
  const mode = deps.mode();
  const out: ReconcileOutcome = { checked: 0, corrected: 0, failed: 0 };
  await forEachRotated(
    deps.prisma,
    RECONCILE_WHERE,
    runAt,
    {
      maxRows: opts.maxRows ?? 2000,
      batchSize: opts.batchSize ?? 200,
      timeBudgetMs: opts.timeBudgetMs ?? 10 * 60_000,
      unitMs: HOUR_MS,
      cursors: deps.cursors,
      cursorKey: "reconcile",
    },
    (r) => reconcileOne(deps, r, runAt, mode, out),
  );
  return out;
}

async function reconcileOne(
  deps: DunningDeps,
  r: { tenantId: string; stripeSubId: string | null },
  runAt: Date,
  mode: ReturnType<DunningDeps["mode"]>,
  out: ReconcileOutcome,
): Promise<void> {
  const subId = r.stripeSubId as string;
  try {
    const stripeSub = await deps.stripe.getSubscription(subId);
    if (stripeSub?.status === "canceled") return;
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
        if (!wantPaused && mode !== "enforced") {
          // once per tenant per day-window, not every hourly run
          if (!deps.once(`would_unpause:${r.tenantId}:${Math.floor(runAt.getTime() / DAY_MS)}`)) {
            return false;
          }
          deps.logger.warn(
            `billing.dunning.would_unpause tenant=${r.tenantId} sub=${subId} (BILLING_PAUSE_MODE=${mode}: Stripe pause_collection is set and local state does not know it; not removed)`,
          );
          return false;
        }
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
    if (isStripeMissing(err)) return;
    out.failed++;
    deps.logger.warn(
      `billing.dunning.reconcile_failed tenant=${r.tenantId}: ${(err as Error)?.message}`,
    );
  }
}
