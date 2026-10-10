import { lockTenantForLedger } from "./addon-ledger";
import { PAYMENT_OVERDUE_REASON, READ_ONLY_STATUS } from "./dunning-config";
import { logClockStarted } from "./dunning-clock";
import {
  type DunningDeps,
  type DunningRow,
  invoiceOwedSince,
  isAgedOwedInvoice,
} from "./dunning-core";
import { clearPauseCollection } from "./dunning-pause";
import { BILLING_EVENTS } from "./plan-catalog.constants";
import { DUNNING_CLEAR, type PauseExit } from "./transition-to-active";

export { invoiceOwedSince };

export type ResolveOutcome =
  | "resumed" // paused (payment_overdue) -> ACTIVE, +MRR once
  | "cleared" // the clock cleared without a status change (dark, already resumed, or a cancelled tenant)
  | "moved" // another invoice is still open: the clock moved to the oldest one
  | "unchanged";

/**
 * SA-733r M2 / r7 PR-B3 (brief item 4): the clock invoice stopped being owed (`invoice.paid`, or the sweep found it
 * paid / void). Everything Stripe-side is read FIRST, so an unreadable Stripe throws before any local write and the
 * webhook is redelivered.
 *
 *   - another invoice on the subscription is still open with money remaining -> the clock MOVES to the oldest one
 *     and the tenant stays as it is (paused stays paused);
 *   - nothing else is open -> RESUME: the CAS ACTIVE transition clears the clock and the pause in the same
 *     transaction and books +MRR once (the ONLY place that books it); `pause_collection` is cleared after commit.
 *     Free until the next 1st (SA-733r3 R17-5): no stub invoice.
 *   - a cancelled tenant (READ_ONLY `subscription_cancelled`) or a `dark` ACTIVE one only has its marker cleared:
 *     paying never revives a cancelled tenant for free (SA-733r3 N1).
 */
export async function resolveClockInvoice(
  deps: DunningDeps,
  row: DunningRow,
  paidInvoiceId: string,
  subIdHint: string | null,
  now: Date,
): Promise<ResolveOutcome> {
  const clockId = row.pastDueInvoiceId;
  if (!clockId) return "unchanged";
  const subId = subIdHint ?? row.stripeSubId;

  const open: any[] = subId ? await deps.stripe.listOpenSubscriptionInvoices(subId) : [];
  // OWED = status `open` with money remaining, nothing else (SA-733r M2, r7 r-note 2). RUNBOOK: void or mark
  // uncollectible to stop chasing; leave open to keep chasing. An uncollectible invoice is the owner's write-off and
  // never counts here, so paying the newer invoice resumes the tenant.
  const others = open.filter((i) => isAgedOwedInvoice(i, now) && i.id !== paidInvoiceId);
  if (others.length > 0) {
    const oldest = others[0];
    if (oldest.id === clockId) return "unchanged";
    // r-note 3: the stamp time, always - a clock moved onto a sibling is a NEW episode with a full runway
    const since = now;
    const moved = await deps.prisma.$transaction(async (tx) => {
      await lockTenantForLedger(tx, row.tenantId);
      const r = await tx.tenantSubscription.updateMany({
        where: { tenantId: row.tenantId, pastDueInvoiceId: clockId },
        data: { pastDueInvoiceId: oldest.id, pastDueSince: since },
      });
      return r.count === 1;
    });
    if (moved) {
      deps.logger.log(
        `billing.dunning.clock_moved tenant=${row.tenantId} from=${clockId} to=${oldest.id}`,
      );
      logClockStarted(deps, {
        tenantId: row.tenantId,
        invoiceId: oldest.id,
        via: "moved",
        stampAt: now,
        since,
        finalizedAt: oldest?.status_transitions?.finalized_at
          ? new Date(oldest.status_transitions.finalized_at * 1000)
          : null,
        attempts: oldest?.attempt_count,
      });
    }
    return moved ? "moved" : "unchanged";
  }

  // Nothing else is owed: resume - decided UNDER the Tenant lock, in ONE transaction (Opus BLOCKER 1). The row this
  // function was handed was read BEFORE the lock; a sweep may have paused the tenant since. So the decision (paused
  // or not, still our clock or not) is re-read here, and the resume rides the same transaction.
  const box: { exit: PauseExit | null } = { exit: null };
  const outcome = await deps.prisma.$transaction(async (tx) => {
    await lockTenantForLedger(tx, row.tenantId);
    const [tenant, sub] = await Promise.all([
      tx.tenant.findUnique({
        where: { id: row.tenantId },
        select: { status: true, readOnlyReason: true },
      }),
      tx.tenantSubscription.findUnique({
        where: { tenantId: row.tenantId },
        select: { pastDueInvoiceId: true },
      }),
    ]);
    if (sub?.pastDueInvoiceId !== clockId) return "unchanged" as const; // the clock moved or cleared meanwhile

    if (tenant?.status === READ_ONLY_STATUS && tenant.readOnlyReason === PAYMENT_OVERDUE_REASON) {
      // paused (now): +MRR once, the status CAS also clears the clock + pause; leaving payment_overdue
      const ok = await deps.transition(
        row.tenantId,
        { status: READ_ONLY_STATUS, readOnlyReason: PAYMENT_OVERDUE_REASON },
        "ACTIVE",
        1,
        BILLING_EVENTS.SUBSCRIPTION_RESUMED,
        { source: "stripe", reason: "invoice_paid", invoiceId: paidInvoiceId },
        { tx, onExit: (e) => (box.exit = e) },
      );
      if (ok) return "resumed" as const;
    }

    // ACTIVE (dark, or nobody paused it) or a cancelled tenant: only the marker clears, no status change.
    const r = await tx.tenantSubscription.updateMany({
      where: { tenantId: row.tenantId, pastDueInvoiceId: clockId },
      data: { ...DUNNING_CLEAR },
    });
    return r.count === 1 ? ("cleared" as const) : ("unchanged" as const);
  });

  // After commit; a Stripe error throws so the webhook is redelivered (r4 F4 #6).
  if (outcome === "resumed" && box.exit) {
    await clearPauseCollection(deps, box.exit, { throwOnError: true });
  }
  return outcome;
}
