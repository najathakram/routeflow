import { Injectable, Logger, Optional } from "@nestjs/common";
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
  dunningEmailsFor,
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
  isPausedRow,
  type StatusTransition,
} from "./dunning-core";
import {
  type DiscoveryOptions,
  type DiscoveryOutcome,
  discoverUnstamped,
} from "./dunning-discovery";
import { episodeKey, logClockStarted } from "./dunning-clock";
import { runMilestones } from "./dunning-milestones";
import {
  clearPauseCollection,
  pauseTenantTx,
  type ReconcileOptions,
  type ReconcileOutcome,
  reconcilePauseCollection,
  setPauseCollection,
} from "./dunning-pause";
import { resolveClockInvoice, type ResolveOutcome } from "./dunning-resolve";
import { hoursSince, pauseHourReached } from "./dunning-time";
import { stampClock } from "./dunning-stamp";
import { dunningZone } from "./dunning-zone";
import { stripeInvoiceSubscriptionId } from "./stripe-period";
import { StripeService } from "./stripe.service";
import { DUNNING_SWEEP_WHERE } from "./auto-lock-candidates";
import { AutoLockSwitchService } from "./auto-lock-switch.service";
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
  /** Keys already logged by this process (a repeating hourly condition logs once). Bounded. */
  private readonly seen = new Set<string>();
  /** Process-local rotation cursors for the periodic sweeps (an empty map after a restart is fine). */
  private readonly cursors = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly notifications: BillingNotificationService,
    private readonly tenantStatusGuard: TenantStatusGuard,
    // SA-775: the rollout pause on the dunning pause (a READ_ONLY lock).
    @Optional() private readonly autoLocks?: AutoLockSwitchService,
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
      once: (key) => this.once(key),
      cursors: this.cursors,
      autoLocks: this.autoLocks,
    };
  }

  private once(key: string): boolean {
    if (this.seen.has(key)) return false;
    if (this.seen.size >= 5000) this.seen.clear();
    this.seen.add(key);
    return true;
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

    // r-note 3: the clock starts at the STAMP time, always (a re-stamp after an exit is a new episode)
    const since = now;
    const stamped = await stampClock(this.deps(), row.tenantId, invoiceId, since);
    if (!stamped) return "unchanged";
    this.logger.warn(`billing.dunning.stamped tenant=${row.tenantId} invoice=${invoiceId}`);
    const finalizedSec = invoice?.status_transitions?.finalized_at;
    logClockStarted(this.deps(), {
      tenantId: row.tenantId,
      invoiceId,
      via: "payment_failed",
      stampAt: now,
      since,
      finalizedAt: typeof finalizedSec === "number" ? new Date(finalizedSec * 1000) : null,
      attempts:
        typeof invoice?.attempt_count === "number" ? invoice.attempt_count : facts.attemptCount,
      firstFailureAt: now,
    });

    // The d0 notice goes out now (this replaces B410's direct email); a failure never fails the webhook.
    try {
      await runMilestones(
        this.deps(),
        { tenantId: row.tenantId, pastDueInvoiceId: invoiceId, pastDueSince: since },
        facts,
        now,
        { paused: isPausedRow(row) },
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
    // SA-733r4 F4 #6: EVERY delivery (a CAS loser too) heals a stale Stripe pause when local `pausedAt` is null.
    // COST, deliberately accepted: this is one extra `subscriptions.retrieve` on EVERY subscription invoice.paid,
    // including a healthy tenant's routine renewal, and a Stripe error fails the webhook so it is redelivered.
    // `off` skips it; `dark` only LOGS the would-unpause (a hand-set dashboard pause must survive the first deploy).
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
    if (billingPauseMode() !== "enforced") {
      if (this.once(`would_unpause:${tenantId}:${Math.floor(now.getTime() / 86_400_000)}`)) {
        this.logger.warn(
          `billing.dunning.would_unpause tenant=${tenantId} sub=${stripeSubId} (BILLING_PAUSE_MODE=${billingPauseMode()}: Stripe pause_collection is set and local state does not know it; not removed)`,
        );
      }
      return;
    }
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
      where: DUNNING_SWEEP_WHERE, // the one shared predicate: the cron and the unpause preview cannot drift
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
    const since = row.pastDueSince;
    if (!since) {
      // A clock with no start can be neither mailed nor paused over (and `now` is never a stand-in: that would
      // restart the week every hour). Rows are only written through the stamp, so this is corruption: say so, once a day.
      if (
        this.once(`no_since:${row.tenantId}:${invoiceId}:${Math.floor(now.getTime() / 86_400_000)}`)
      ) {
        this.logger.warn(
          `billing.dunning.clock_without_since tenant=${row.tenantId} invoice=${invoiceId}`,
        );
      }
      return "noop";
    }

    // M8: re-read Stripe before any email or pause. Paid / void / unknown = the clock is stale: resolve it.
    const facts = await this.stripe.getInvoiceFacts(invoiceId);
    if (!isOwed(facts)) {
      if (facts.status === "paid") {
        // the invoice.paid path, self-healing a missed webhook
        const r = await resolveClockInvoice(deps, row, invoiceId, row.stripeSubId, now);
        if (r === "resumed") this.tenantStatusGuard.invalidate(row.tenantId);
        return "resolved";
      }
      // void / uncollectible (the owner's write-off) / gone: it never keeps a clock, but there is NO new resume path
      // here - an ACTIVE tenant's clock is cleared or moved by the daily discovery, a PAUSED tenant exits through
      // admin activation (or invoice.paid of the clocked invoice). A paused tenant whose invoice closed is the
      // operator's cue: one warn per tenant per day.
      if (
        isPausedRow(row) &&
        this.once(`paused_closed:${row.tenantId}:${Math.floor(now.getTime() / 86_400_000)}`)
      ) {
        this.logger.warn(
          `billing.dunning.paused_on_closed_invoice tenant=${row.tenantId} invoice=${invoiceId} status=${facts.status ?? "gone"}`,
        );
      }
      return "noop";
    }
    if (facts.paymentProcessing) return "noop"; // N6: a bank debit in flight is not a failure

    const finalSentAt = await runMilestones(
      deps,
      { tenantId: row.tenantId, pastDueInvoiceId: invoiceId, pastDueSince: since },
      facts,
      now,
      { paused: isPausedRow(row) },
    );

    if (row.tenant.status !== "ACTIVE" || row.pausedAt) return "noop";
    if (hoursSince(since, now) < DUNNING_PAUSE_HOURS) return "noop";
    const zone = await dunningZone(this.prisma, row.tenantId);
    if (!pauseHourReached(now, zone)) return "noop";

    if (mode === "dark") {
      // once per tenant and EPISODE (a re-stamped clock on the same invoice is a new one), not every hourly sweep
      if (this.once(`would_pause:${row.tenantId}:${episodeKey(invoiceId, since)}`)) {
        this.logger.log(
          `billing.dunning.would_pause tenant=${row.tenantId} invoice=${invoiceId} (BILLING_PAUSE_MODE=dark: no status change)`,
        );
      }
      return "would_pause";
    }
    // enforced: the final notice must be >= 24 h old (a flip pauses nobody in hour one).
    if (
      !finalSentAt ||
      now.getTime() - finalSentAt.getTime() < DUNNING_FINAL_LEAD_HOURS * HOUR_MS
    ) {
      return "noop";
    }

    const paused = await pauseTenantTx(deps, row, invoiceId, since, now);
    if (!paused) return "noop"; // CAS loser: another sweep paused it, or invoice.paid resumed it first
    this.tenantStatusGuard.invalidate(row.tenantId);
    this.logger.warn(`billing.dunning.paused tenant=${row.tenantId} invoice=${invoiceId}`);

    await setPauseCollection(
      deps,
      { tenantId: row.tenantId, stripeSubId: row.stripeSubId as string },
      now,
    );
    // the milestone series (this PAUSED notice included) is an `enforced` path only; a pause cannot land in dark,
    // but the switch is asked anyway so no sender can bypass it
    if (dunningEmailsFor(mode) !== "milestones") return "paused";
    try {
      await this.notifications.notifyDunning(
        row.tenantId,
        DUNNING_MILESTONES.PAUSED,
        episodeKey(invoiceId, since),
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

  // ─── the daily discovery sweep ────────────────────────────────────────────

  /** SA-733r M2: open invoices Stripe never attempted raise no payment_failed; stamp them once a day at 04:00. */
  @LeaderCron("0 4 * * *", "billing.dunningDiscovery")
  async dunningDiscovery(): Promise<void> {
    await this.discover(new Date());
  }

  discover(now: Date, opts: DiscoveryOptions = {}): Promise<DiscoveryOutcome> {
    if (!this.stripe.isConfigured)
      return Promise.resolve({
        tenants: 0,
        clocks: 0,
        stamped: 0,
        failed: 0,
        cleared: 0,
        moved: 0,
      });
    return discoverUnstamped(this.deps(), now, opts);
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

  reconcile(runAt: Date, opts: ReconcileOptions = {}): Promise<ReconcileOutcome> {
    if (!this.stripe.isConfigured) return Promise.resolve({ checked: 0, corrected: 0, failed: 0 });
    return reconcilePauseCollection(this.deps(), runAt, opts);
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
