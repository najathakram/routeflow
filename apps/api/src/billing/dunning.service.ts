import { Injectable, Logger } from "@nestjs/common";
import { CronExpression } from "@nestjs/schedule";
import { LeaderCron } from "../common/cron-lock";
import { PrismaService } from "../prisma/prisma.service";
import { TenantStatusGuard } from "../tenant/tenant-status.guard";
import { lockTenantForLedger } from "./addon-ledger";
import { BillingNotificationService } from "./billing-notification.service";
import {
  billingPauseMode,
  DUNNING_FINAL_LEAD_HOURS,
  DUNNING_MILESTONES,
  DUNNING_PAUSE_HOURS,
  HOUR_MS,
  PAYMENT_OVERDUE_REASON,
  READ_ONLY_STATUS,
  SUBSCRIPTION_CANCELLED_REASON,
} from "./dunning-config";
import {
  DUNNING_ROW_SELECT,
  type DunningDeps,
  type DunningRow,
  dunningEligible,
  isOwed,
  type StatusTransition,
} from "./dunning-core";
import { runMilestones } from "./dunning-milestones";
import {
  clearPauseCollection,
  pauseTenantTx,
  type ReconcileOutcome,
  reconcilePauseCollection,
  setPauseCollection,
} from "./dunning-pause";
import { resolveClockInvoice, type ResolveOutcome } from "./dunning-resolve";
import { hoursSince, pauseHourReached } from "./dunning-time";
import { dunningZone } from "./dunning-zone";
import { stripeInvoiceSubscriptionId } from "./stripe-period";
import { StripeService } from "./stripe.service";
import type { PauseExit } from "./transition-to-active";

export type StampOutcome = "stamped" | "unchanged" | "off" | "ignored" | "skipped" | "not_owed";
export type SweepOutcome = {
  swept: number;
  paused: number;
  resolved: number;
  wouldPause: number;
  failed: number;
};

type ClockedRow = DunningRow & { pastDueInvoiceId: string };

/**
 * SA-733r7 PR-B3: dunning. The webhook entry points (`onPaymentFailed` stamps the clock once per invoice,
 * `onInvoicePaid` resumes or moves it), the hourly sweep (reminders + the pause), the `pause_collection`
 * reconciler, and the exits other modules call (`clearPauseAfterCommit`, `markCancelledWhilePaused`).
 *
 * `BILLING_PAUSE_MODE` (`dunning-config.ts`): `off` does nothing new, `dark` (default) stamps + mails + logs and
 * NEVER changes a status, `enforced` adds the final notice and the pause. Eligible rows (D10) are Stripe-billed
 * (`stripeSubId`), not manual-pay (`externalPayment = false`), and without a catch-up claim; there is no
 * `couponFull` exemption. The status change and its MRR delta go through `BillingService.transitionAndEmit`
 * (bound at construction by BillingService - `bindTransition` - so MRR has one writer and there is no DI cycle).
 */
@Injectable()
export class DunningService {
  private readonly logger = new Logger(DunningService.name);
  private transition: StatusTransition | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly notifications: BillingNotificationService,
    private readonly tenantStatusGuard: TenantStatusGuard,
  ) {}

  /** Called once by BillingService's constructor. */
  bindTransition(fn: StatusTransition): void {
    this.transition = fn;
  }

  private deps(): DunningDeps {
    return {
      prisma: this.prisma,
      stripe: this.stripe,
      notifications: this.notifications,
      logger: this.logger,
      transition:
        this.transition ??
        (async () => {
          throw new Error("DunningService: BillingService has not bound its status transition");
        }),
      mode: () => billingPauseMode(),
    };
  }

  // ─── invoice.payment_failed: stamp the clock once per invoice ─────────────

  async onPaymentFailed(invoice: any, now: Date = new Date()): Promise<StampOutcome> {
    if (billingPauseMode() === "off") return "off";
    const invoiceId: string | undefined = invoice?.id;
    const subId = stripeInvoiceSubscriptionId(invoice);
    if (!invoiceId || !subId) return "ignored";

    const row = await this.prisma.tenantSubscription.findFirst({
      where: { stripeSubId: subId },
      select: DUNNING_ROW_SELECT,
    });
    if (!row || row.stripeSubId !== subId || row.tenant.deletedAt) return "ignored";
    // D10: manual-pay tenants and tenants with a held catch-up claim are never stamped.
    if (!dunningEligible(row)) return "skipped";
    if (row.pastDueInvoiceId === invoiceId) return "unchanged"; // a later attempt of the same invoice

    // SA-733r M8 / N6: only an invoice Stripe still shows as owed, with no payment in flight, starts a clock.
    const facts = await this.stripe.getInvoiceFacts(invoiceId);
    if (!isOwed(facts) || facts.paymentProcessing) return "not_owed";

    const stamped = await this.prisma.$transaction(async (tx) => {
      await lockTenantForLedger(tx, row.tenantId);
      const r = await tx.tenantSubscription.updateMany({
        // The older clock wins: a second invoice failing while one is owed leaves it where it is.
        where: { tenantId: row.tenantId, pastDueInvoiceId: null, catchupState: null },
        data: { pastDueSince: now, pastDueInvoiceId: invoiceId },
      });
      return r.count === 1;
    });
    if (!stamped) return "unchanged";
    this.logger.warn(`billing.dunning.stamped tenant=${row.tenantId} invoice=${invoiceId}`);

    // The d0 notice goes out now (this replaces B410's direct email); a failure never fails the webhook.
    try {
      await runMilestones(
        this.deps(),
        { tenantId: row.tenantId, pastDueInvoiceId: invoiceId, pastDueSince: now },
        facts,
        now,
      );
    } catch (err) {
      this.logger.warn(
        `dunning d0 notice for tenant ${row.tenantId} failed: ${(err as Error)?.message}`,
      );
    }
    return "stamped";
  }

  // ─── invoice.paid: resume, or move the clock ──────────────────────────────

  async onInvoicePaid(invoice: any, now: Date = new Date()): Promise<ResolveOutcome | "ignored"> {
    const invoiceId: string | undefined = invoice?.id;
    if (!invoiceId) return "ignored";
    const subId = stripeInvoiceSubscriptionId(invoice);
    const row = await this.prisma.tenantSubscription.findFirst({
      // By subscription, or by the owed marker alone (a cancelled tenant's stripeSubId was cleared, SA-733r2 N1).
      where: { OR: [...(subId ? [{ stripeSubId: subId }] : []), { pastDueInvoiceId: invoiceId }] },
      select: DUNNING_ROW_SELECT,
    });
    if (!row) return "ignored";
    const viaSub = !!subId && row.stripeSubId === subId;
    if (!viaSub && row.pastDueInvoiceId !== invoiceId) return "ignored";

    let outcome: ResolveOutcome = "unchanged";
    if (row.pastDueInvoiceId) {
      outcome = await resolveClockInvoice(this.deps(), row, invoiceId, subId, now);
      if (outcome === "resumed") this.tenantStatusGuard.invalidate(row.tenantId);
    }
    // SA-733r4 F4 #6: EVERY delivery (a CAS loser too) clears a stale Stripe pause when local `pausedAt` is null.
    if (viaSub && billingPauseMode() !== "off") {
      await this.healPauseCollection(row.tenantId, subId as string, now);
    }
    return outcome;
  }

  private async healPauseCollection(
    tenantId: string,
    stripeSubId: string,
    now: Date,
  ): Promise<void> {
    const local = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: { pausedAt: true },
    });
    if (local?.pausedAt) return; // locally paused: Stripe is meant to be paused
    const stripeSub = await this.stripe.getSubscription(stripeSubId); // an error throws: redelivery
    if (!stripeSub?.pause_collection || stripeSub.status === "canceled") return;
    await clearPauseCollection(
      this.deps(),
      { tenantId, stripeSubId, exitAt: now },
      { throwOnError: true },
    );
  }

  // ─── the hourly sweep ─────────────────────────────────────────────────────

  @LeaderCron(CronExpression.EVERY_HOUR, "billing.dunningSweep")
  async dunningSweep(): Promise<void> {
    await this.sweep(new Date());
  }

  async sweep(now: Date): Promise<SweepOutcome> {
    const out: SweepOutcome = { swept: 0, paused: 0, resolved: 0, wouldPause: 0, failed: 0 };
    const mode = billingPauseMode();
    if (mode === "off" || !this.stripe.isConfigured) return out;

    const rows = (await this.prisma.tenantSubscription.findMany({
      where: {
        pastDueInvoiceId: { not: null },
        stripeSubId: { not: null },
        externalPayment: false,
        catchupState: null, // r3 N2(a): the sweep and the pause skip a held catch-up claim
        tenant: { deletedAt: null },
      },
      select: DUNNING_ROW_SELECT,
    })) as ClockedRow[];

    for (const row of rows) {
      out.swept++;
      try {
        const r = await this.sweepOne(row, now, mode);
        if (r === "paused") out.paused++;
        else if (r === "resolved") out.resolved++;
        else if (r === "would_pause") out.wouldPause++;
      } catch (err) {
        out.failed++;
        this.logger.error(
          `billing.dunning.sweep_failed tenant=${row.tenantId}: ${(err as Error)?.message}`,
        );
      }
    }
    return out;
  }

  private async sweepOne(
    row: ClockedRow,
    now: Date,
    mode: ReturnType<typeof billingPauseMode>,
  ): Promise<"paused" | "resolved" | "would_pause" | "noop"> {
    if (!dunningEligible(row)) return "noop";
    const deps = this.deps();
    const invoiceId = row.pastDueInvoiceId;

    // M8: re-read Stripe before any email or pause. Paid / void / unknown = the clock is stale: resolve it.
    const facts = await this.stripe.getInvoiceFacts(invoiceId);
    if (!isOwed(facts)) {
      const r = await resolveClockInvoice(deps, row, invoiceId, row.stripeSubId, now);
      if (r === "resumed") this.tenantStatusGuard.invalidate(row.tenantId);
      return "resolved";
    }
    if (facts.paymentProcessing) return "noop"; // N6: a bank debit in flight is not a failure

    const since = row.pastDueSince ?? now;
    const finalSentAt = await runMilestones(
      deps,
      { tenantId: row.tenantId, pastDueInvoiceId: invoiceId, pastDueSince: since },
      facts,
      now,
    );

    if (row.tenant.status !== "ACTIVE" || row.pausedAt) return "noop";
    if (hoursSince(since, now) < DUNNING_PAUSE_HOURS) return "noop";
    const zone = await dunningZone(this.prisma, row.tenantId);
    if (!pauseHourReached(now, zone)) return "noop";

    if (mode === "dark") {
      this.logger.log(
        `billing.dunning.would_pause tenant=${row.tenantId} invoice=${invoiceId} (BILLING_PAUSE_MODE=dark: no status change)`,
      );
      return "would_pause";
    }
    // enforced: the final notice must be >= 24 h old (a flip pauses nobody in hour one).
    if (
      !finalSentAt ||
      now.getTime() - finalSentAt.getTime() < DUNNING_FINAL_LEAD_HOURS * HOUR_MS
    ) {
      return "noop";
    }

    const paused = await pauseTenantTx(deps, row, invoiceId, now);
    if (!paused) return "noop"; // CAS loser: another sweep paused it, or invoice.paid resumed it first
    this.tenantStatusGuard.invalidate(row.tenantId);
    this.logger.warn(`billing.dunning.paused tenant=${row.tenantId} invoice=${invoiceId}`);

    await setPauseCollection(
      deps,
      { tenantId: row.tenantId, stripeSubId: row.stripeSubId as string },
      now,
    );
    try {
      await this.notifications.notifyDunning(
        row.tenantId,
        DUNNING_MILESTONES.PAUSED,
        invoiceId,
        "paused",
        { payUrl: facts.hostedInvoiceUrl ?? null },
      );
    } catch (err) {
      this.logger.warn(
        `paused notice for tenant ${row.tenantId} failed: ${(err as Error)?.message}`,
      );
    }
    return "paused";
  }

  // ─── pause_collection reconciler ──────────────────────────────────────────

  @LeaderCron(CronExpression.EVERY_HOUR, "billing.pauseReconcile")
  async pauseReconcile(): Promise<void> {
    await this.reconcile(new Date());
  }

  /**
   * SA-733r4 F4 #6: the reconciler also runs at 11:00Z on the 1st (the renewal that a stale pause would void).
   * Like every other cron here the schedule is in the process zone, which is UTC in production.
   */
  @LeaderCron("0 11 1 * *", "billing.pauseReconcileFirst")
  async pauseReconcileFirst(): Promise<void> {
    await this.reconcile(new Date());
  }

  reconcile(runAt: Date): Promise<ReconcileOutcome> {
    if (!this.stripe.isConfigured) return Promise.resolve({ checked: 0, corrected: 0, failed: 0 });
    return reconcilePauseCollection(this.deps(), runAt);
  }

  // ─── exits ────────────────────────────────────────────────────────────────

  /**
   * Every exit from `payment_overdue` (resume, admin activation, extendTrial) calls this AFTER its transaction
   * commits. A failure is logged and left to the reconciler unless `throwOnError` (webhooks).
   */
  async clearPauseAfterCommit(
    exit: PauseExit | null,
    opts: { throwOnError?: boolean } = {},
  ): Promise<void> {
    if (!exit) return;
    await clearPauseCollection(this.deps(), exit, opts);
  }

  /**
   * SA-733r2 N1 / brief item 8: a paused tenant that cancels lands on READ_ONLY(`subscription_cancelled`), never
   * CANCELLED. The overdue invoice stays owed (`pastDueInvoiceId` is KEPT as the owed marker), local `pausedAt` is
   * cleared and no MRR is booked (the pause already removed it). The immediate Stripe cancel supersedes the pause.
   */
  async markCancelledWhilePaused(tenantId: string): Promise<boolean> {
    const done = await this.prisma.$transaction(async (tx) => {
      await lockTenantForLedger(tx, tenantId);
      const r = await tx.tenant.updateMany({
        where: { id: tenantId, status: READ_ONLY_STATUS, readOnlyReason: PAYMENT_OVERDUE_REASON },
        data: { readOnlyReason: SUBSCRIPTION_CANCELLED_REASON },
      });
      if (r.count !== 1) return false;
      await tx.tenantSubscription.updateMany({ where: { tenantId }, data: { pausedAt: null } });
      return true;
    });
    if (done) this.tenantStatusGuard.invalidate(tenantId);
    return done;
  }
}
