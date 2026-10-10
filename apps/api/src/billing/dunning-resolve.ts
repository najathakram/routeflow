import { lockTenantForLedger } from "./addon-ledger";
import { PAYMENT_OVERDUE_REASON, READ_ONLY_STATUS } from "./dunning-config";
import type { DunningDeps, DunningRow } from "./dunning-core";
import { clearPauseCollection } from "./dunning-pause";
import { BILLING_EVENTS } from "./plan-catalog.constants";
import { DUNNING_CLEAR, type PauseExit } from "./transition-to-active";

/** When an open invoice started to be owed: its finalization time, else its creation, else `fallback`. */
export function invoiceOwedSince(inv: any, fallback: Date): Date {
  const sec = inv?.status_transitions?.finalized_at ?? inv?.created;
  return typeof sec === "number" && sec > 0 ? new Date(sec * 1000) : fallback;
}

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
  const others = open.filter(
    (i) => i?.id && i.id !== paidInvoiceId && (i.amount_remaining ?? 0) > 0,
  );
  if (others.length > 0) {
    const oldest = others[0];
    if (oldest.id === clockId) return "unchanged";
    const moved = await deps.prisma.$transaction(async (tx) => {
      await lockTenantForLedger(tx, row.tenantId);
      const r = await tx.tenantSubscription.updateMany({
        where: { tenantId: row.tenantId, pastDueInvoiceId: clockId },
        data: { pastDueInvoiceId: oldest.id, pastDueSince: invoiceOwedSince(oldest, now) },
      });
      return r.count === 1;
    });
    if (moved) {
      deps.logger.log(
        `billing.dunning.clock_moved tenant=${row.tenantId} from=${clockId} to=${oldest.id}`,
      );
    }
    return moved ? "moved" : "unchanged";
  }

  // Nothing else is owed: resume.
  const box: { exit: PauseExit | null } = { exit: null };
  const resumed = await deps.transition(
    row.tenantId,
    {
      status: READ_ONLY_STATUS,
      readOnlyReason: PAYMENT_OVERDUE_REASON,
      subscription: { is: { pastDueInvoiceId: clockId } },
    },
    "ACTIVE",
    1,
    BILLING_EVENTS.SUBSCRIPTION_RESUMED,
    { source: "stripe", reason: "invoice_paid", invoiceId: paidInvoiceId },
    { onExit: (e) => (box.exit = e) },
  );
  if (resumed) {
    // After commit; a Stripe error throws so the webhook is redelivered (r4 F4 #6).
    if (box.exit) await clearPauseCollection(deps, box.exit, { throwOnError: true });
    return "resumed";
  }

  // The CAS lost: dark / ACTIVE, already resumed by a racing delivery, or a cancelled tenant. Clear the marker.
  const cleared = await deps.prisma.$transaction(async (tx) => {
    await lockTenantForLedger(tx, row.tenantId);
    const r = await tx.tenantSubscription.updateMany({
      where: { tenantId: row.tenantId, pastDueInvoiceId: clockId },
      data: { ...DUNNING_CLEAR },
    });
    return r.count === 1;
  });
  return cleared ? "cleared" : "unchanged";
}
