import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { LeaderCron } from "../../common/cron-lock";
import { uniqueViolationOn } from "../../common/prisma-unique";
import { ADMIN_AUDIT_ENTITY } from "../../platform-admin/audit-actions.constant";
import { PrismaService } from "../../prisma/prisma.service";
import { writeAdminNotice } from "../manual-invoice-notice";
import {
  effectiveCycle,
  nextBillingWindow,
  sameSnapped,
  snapToBoundary,
  windowParts,
} from "./calendar-windows";
import { RfInvoiceBuilder } from "./rf-invoice-builder";
import { RfInvoiceMailerService } from "./rf-invoice-mailer.service";
import {
  RF_INVOICE_AUDIT_ACTIONS,
  RF_INVOICE_LEAD_DAYS,
  RF_INVOICE_STALE_DAYS,
  RF_INVOICE_PERIOD_INDEX,
  rfInvoicingMode,
  type RfInvoicingMode,
} from "./rf-invoice.constants";
import {
  mintRfInvoiceNumber,
  withRfInvoiceNumber,
  withRfInvoiceNumberLock,
} from "./rf-invoice-number";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The subscriptions the issuer considers (also read by the platform-admin summary, so the two never disagree). */
export const RF_INVOICE_CANDIDATE_WHERE = {
  externalPayment: true,
  stripeSubId: null,
  planKey: { not: null },
  cancelAtPeriodEnd: false,
  periodStart: { not: null },
  periodEnd: { not: null },
  // SA-733r3 N2: a held October catch-up claim freezes RouteFlow invoicing for the tenant (the issuer skips it).
  catchupState: null,
  tenant: { class: "PRODUCTION", deletedAt: null, status: "ACTIVE" },
} as const;

export interface IssueWindow {
  periodStart: Date;
  periodEnd: Date;
  /**
   * SA-744r2 (review): an ANNUAL window whose start was CLIPPED by an old-shape invoice issued ahead is not a
   * shape the helper prices (fewer than 12 months from an unaligned start). It is NEVER issued or emailed at a
   * full annual price for fewer days: `issuePeriod` raises the review notice instead and writes nothing.
   */
  needsRuling?: boolean;
}

/** The subscription fields the issuer reads (the cron's `select`, and what DB-3 / PR2 pass in). */
export interface IssuerSubscription {
  tenantId: string;
  cycle: "MONTHLY" | "ANNUAL";
  planKey?: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  externalPayment?: boolean;
  stripeSubId?: string | null;
  cancelAtPeriodEnd?: boolean;
  tenant?: { status: string; class: string; deletedAt: Date | null };
}

export type IssueResult =
  | { status: "issued"; invoice: { id: string; number: string } }
  | { status: "exists" }
  | { status: "no_price" }
  | { status: "needs_ruling" };

export interface IssueDueSummary {
  mode: RfInvoicingMode;
  considered: number;
  issued: number;
  existing: number;
  failed: number;
  /** Tenants a period was due for but whose price cannot be resolved. */
  unpriced: string[];
  /** Tenants whose due ANNUAL window was clipped by an old-shape invoice: not issued, a notice raised. */
  needsRuling: string[];
  /** Tenants skipped because their period ended long ago (rollCycles lagging); no invoice was issued. */
  stale: string[];
}

/**
 * Issues RouteFlow's own invoices to manual-pay tenants. DARK: `RF_INVOICING_MODE` defaults to `off`,
 * and then the cron reads and writes nothing. It never touches the subscription, a BillingEvent or the
 * tenant's status - an invoice is a record, not a consequence.
 *
 * Candidates: external-payment subscriptions with no Stripe subscription, a plan, a period, not set to
 * cancel, on an ACTIVE, undeleted PRODUCTION tenant. It issues (a) the NEXT period when its start is within
 * seven days, and (b) the CURRENT period when the period before it was invoiced but this one was missed.
 * An activation period (nothing invoiced before it) is never invoiced.
 */
@Injectable()
export class RfInvoiceIssuerService {
  private readonly logger = new Logger(RfInvoiceIssuerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly builder: RfInvoiceBuilder,
    private readonly mailer: RfInvoiceMailerService,
  ) {}

  @LeaderCron("20 0 * * *", "billing-invoice.issueDue")
  async issueDue(): Promise<IssueDueSummary> {
    return this.runIssueDue(new Date());
  }

  async runIssueDue(now: Date): Promise<IssueDueSummary> {
    const mode = rfInvoicingMode();
    const summary: IssueDueSummary = {
      mode,
      considered: 0,
      issued: 0,
      existing: 0,
      failed: 0,
      unpriced: [],
      needsRuling: [],
      stale: [],
    };
    if (mode === "off") return summary;

    const subs = (await this.prisma.tenantSubscription.findMany({
      where: RF_INVOICE_CANDIDATE_WHERE,
      select: {
        tenantId: true,
        cycle: true,
        planKey: true,
        periodStart: true,
        periodEnd: true,
        externalPayment: true,
        stripeSubId: true,
        cancelAtPeriodEnd: true,
        tenant: { select: { status: true, class: true, deletedAt: true } },
      },
    })) as IssuerSubscription[];

    for (const sub of subs) {
      if (!isCandidate(sub)) continue; // the query's predicate, re-checked on the row actually read
      summary.considered++;
      if (isStale(sub, now)) {
        // rollCycles is lagging: issuing "the next period" would invoice the past. One notice per period.
        if (!summary.stale.includes(sub.tenantId)) summary.stale.push(sub.tenantId);
        await this.raiseOnce(
          sub.tenantId,
          RF_INVOICE_AUDIT_ACTIONS.STALE_PERIOD,
          (sub.periodEnd as Date).toISOString(),
          `No RouteFlow invoice was issued: the subscription period ended ${(sub.periodEnd as Date).toISOString().slice(0, 10)} and has not been rolled forward.`,
        );
        continue;
      }
      try {
        for (const window of await this.windowsFor(sub, now)) {
          const r = await this.issuePeriod(sub, window, now);
          if (r.status === "issued") summary.issued++;
          else if (r.status === "exists") summary.existing++;
          else if (r.status === "needs_ruling") {
            if (!summary.needsRuling.includes(sub.tenantId)) summary.needsRuling.push(sub.tenantId);
          } else if (!summary.unpriced.includes(sub.tenantId)) summary.unpriced.push(sub.tenantId);
        }
      } catch (e) {
        summary.failed++;
        this.logger.error(
          `rf invoice issue failed for tenant ${sub.tenantId}: ${(e as Error).message}`,
        );
      }
    }
    if (summary.issued || summary.failed || summary.unpriced.length || summary.stale.length) {
      this.logger.log(
        `rf invoices (${mode}): issued ${summary.issued}, existing ${summary.existing}, ` +
          `unpriced ${summary.unpriced.length}, stale ${summary.stale.length}, failed ${summary.failed}`,
      );
    }
    return summary;
  }

  /**
   * The periods due now for one subscription, earliest first (SA-744r2). The cron uses the 7-day lead; the
   * platform-admin issue-now passes `Infinity` to issue the next uninvoiced period immediately.
   *   (b) catch-up: the CURRENT period, when the period before it was invoiced (matched under the inclusive
   *       24 h snap) and this one never was.
   *   (a) the NEXT window, `nextBillingWindow(sub.periodEnd)` - the same helper `rollCycles` uses, so the two
   *       can never disagree. The lead check and the window's end come from it; the greatest non-VOID
   *       invoiced `periodEnd` only CLIPS its start (an old-shape invoice issued ahead is never billed
   *       twice) and the window is skipped when fully covered. An alignment window that ends within the
   *       lead pulls the following full month in the same run (the look-past uses RF_INVOICE_LEAD_DAYS
   *       even under issue-now), so a December invoice is never due ~36 h after it is created.
   */
  async windowsFor(
    sub: IssuerSubscription,
    now: Date,
    leadDays: number = RF_INVOICE_LEAD_DAYS,
  ): Promise<IssueWindow[]> {
    const start = sub.periodStart as Date;
    const end = sub.periodEnd as Date;
    const length = end.getTime() - start.getTime();
    if (!(length > 0)) return [];
    const cycle = effectiveCycle(sub.cycle, start, end);
    const windows: IssueWindow[] = [];

    // (b) catch-up: the period before this one was invoiced (and not voided), this one never was.
    if (await this.hasPriorInvoiceEndingAt(sub.tenantId, start)) {
      windows.push({ periodStart: start, periodEnd: end });
    }

    // (a) the next window, once it starts within the lead time.
    const next = nextBillingWindow(end, cycle);
    if (next.periodStart.getTime() - now.getTime() > leadDays * DAY_MS) return windows;
    const clipped = await this.clipToUninvoiced(sub.tenantId, next);
    if (!clipped) return windows;
    const parts = windowParts(clipped.periodStart, clipped.periodEnd, cycle);
    // A clipped ANNUAL window (start moved by an old-shape invoice, parts no longer 12 months) is not priced.
    const clippedAnnual =
      cycle === "ANNUAL" &&
      clipped.periodStart.getTime() !== next.periodStart.getTime() &&
      parts === null;
    windows.push(clippedAnnual ? { ...clipped, needsRuling: true } : clipped);
    const alignmentOnly = parts?.length === 1 && parts[0].kind === "ALIGN";
    if (
      alignmentOnly &&
      clipped.periodEnd.getTime() - now.getTime() <= RF_INVOICE_LEAD_DAYS * DAY_MS
    ) {
      windows.push(nextBillingWindow(clipped.periodEnd, cycle));
    }
    return windows;
  }

  /** M1: a non-VOID invoice whose `periodEnd` snaps to the same instant as `start` (not exact equality). */
  private async hasPriorInvoiceEndingAt(tenantId: string, start: Date): Promise<boolean> {
    const rows = await this.prisma.rfInvoice.findMany({
      where: {
        tenantId,
        status: { not: "VOID" },
        periodEnd: {
          gte: new Date(start.getTime() - 2 * DAY_MS),
          lte: new Date(start.getTime() + 2 * DAY_MS),
        },
      },
      select: { periodEnd: true },
    });
    return rows.some((r) => r.periodEnd instanceof Date && sameSnapped(r.periodEnd, start));
  }

  /** M2: clip the window's start to the greatest non-VOID invoiced end; null when it is fully covered. */
  private async clipToUninvoiced(
    tenantId: string,
    window: IssueWindow,
  ): Promise<IssueWindow | null> {
    const latest = await this.prisma.rfInvoice.findFirst({
      where: { tenantId, status: { not: "VOID" } },
      orderBy: { periodEnd: "desc" },
      select: { periodEnd: true },
    });
    if (!latest?.periodEnd) return window;
    const covered = snapToBoundary(latest.periodEnd);
    if (covered.getTime() >= window.periodEnd.getTime()) return null;
    if (covered.getTime() > window.periodStart.getTime()) {
      return { periodStart: covered, periodEnd: window.periodEnd };
    }
    return window;
  }

  /**
   * Issue one period for one subscription; idempotent on (tenant, period). The row and its
   * RF_INVOICE_ISSUED notice are one transaction. A race loser (the period's unique index) reports
   * "exists"; any other unique violation propagates.
   */
  async issuePeriod(
    sub: IssuerSubscription,
    window: IssueWindow,
    now: Date,
    actorId: string | null = null,
  ): Promise<IssueResult> {
    // M1: the key is the SNAPPED window start, so a legacy 00:00Z start and its 12:00Z twin are one period.
    const periodKey = snapToBoundary(window.periodStart).toISOString();
    const already = await this.prisma.rfInvoice.findFirst({
      where: { tenantId: sub.tenantId, periodKey },
      select: { id: true },
    });
    if (already || (await this.hasInvoiceStartingAt(sub.tenantId, window.periodStart))) {
      return { status: "exists" };
    }

    // M4 (B863): a last window of 360+ days is ANNUAL whatever the label says; the label is not rewritten.
    const cycle = effectiveCycle(sub.cycle, sub.periodStart, sub.periodEnd);
    if (window.needsRuling) {
      await this.raiseOnce(
        sub.tenantId,
        RF_INVOICE_AUDIT_ACTIONS.IRREGULAR_PERIOD,
        periodKey,
        `No RouteFlow invoice was issued for the ANNUAL window ${window.periodStart.toISOString().slice(0, 10)} to ${new Date(window.periodEnd.getTime() - DAY_MS).toISOString().slice(0, 10)} (inclusive): an invoice issued in the old shape already covers its first days, so a full annual price would bill fewer days. It needs a ruling.`,
      );
      return { status: "needs_ruling" };
    }
    const draft = await this.builder.build(sub.tenantId, cycle, window);
    if (!draft.ok) {
      await this.raiseOnce(
        sub.tenantId,
        RF_INVOICE_AUDIT_ACTIONS.NEEDS_PRICE,
        periodKey,
        `No RouteFlow invoice was issued for the period starting ${periodKey.slice(0, 10)}: the tenant's price cannot be resolved. ${draft.message}`,
      );
      return { status: "no_price" };
    }

    try {
      const invoice = await withRfInvoiceNumberLock(() =>
        withRfInvoiceNumber(() =>
          this.prisma.$transaction(async (tx) => {
            const number = await mintRfInvoiceNumber(tx, now);
            const row = await tx.rfInvoice.create({
              data: {
                tenantId: sub.tenantId,
                number,
                amount: draft.total,
                status: "OPEN",
                cycle,
                issuedAt: now,
                periodStart: window.periodStart,
                periodEnd: window.periodEnd,
                periodKey,
                dueDate: window.periodStart,
                currency: draft.currency,
                lines: draft.lines as unknown as Prisma.InputJsonValue,
                issuedById: actorId,
                needsReview: draft.needsReview,
              },
              select: { id: true, number: true },
            });
            await writeAdminNotice(tx, {
              tenantId: sub.tenantId,
              actorId,
              action: RF_INVOICE_AUDIT_ACTIONS.ISSUED,
              message: `RouteFlow invoice ${number} issued for ${draft.total.toFixed(2)} ${draft.currency}, due ${periodKey.slice(0, 10)}.`,
              meta: {
                invoiceId: row.id,
                number,
                amount: draft.total,
                periodKey,
                needsReview: draft.needsReview,
              },
            });
            return row;
          }),
        ),
      );
      // Only after the row is committed: a failed create must never leave a notice saying "was issued".
      // BEST EFFORT: raiseOnce swallows and logs its own failure, and nothing re-raises it - if this notice
      // fails once, the invoice stays issued and the notice is never written again (the row's needsReview flag
      // is the durable signal).
      if (draft.irregularPeriod) {
        await this.raiseOnce(
          sub.tenantId,
          RF_INVOICE_AUDIT_ACTIONS.IRREGULAR_PERIOD,
          periodKey,
          `The RouteFlow invoice for the period starting ${periodKey.slice(0, 10)} was issued, but its window (${window.periodStart.toISOString().slice(0, 10)} to ${new Date(window.periodEnd.getTime() - DAY_MS).toISOString().slice(0, 10)}, inclusive) is not a regular billing period. Check the amount.`,
        );
      }
      await this.emailIssued(invoice.id, now);
      return { status: "issued", invoice };
    } catch (e) {
      if (uniqueViolationOn(e, RF_INVOICE_PERIOD_INDEX, { exact: true }))
        return { status: "exists" };
      throw e;
    }
  }

  /** A non-VOID invoice that starts at `start` under the snap: never bill a period twice under two spellings. */
  private async hasInvoiceStartingAt(tenantId: string, start: Date): Promise<boolean> {
    const rows = await this.prisma.rfInvoice.findMany({
      where: {
        tenantId,
        status: { not: "VOID" },
        periodStart: {
          gte: new Date(start.getTime() - 2 * DAY_MS),
          lte: new Date(start.getTime() + 2 * DAY_MS),
        },
      },
      select: { periodStart: true },
    });
    return rows.some((r) => r.periodStart instanceof Date && sameSnapped(r.periodStart, start));
  }

  /** Live mode only: email the invoice just issued. A mail problem never undoes or fails the issue. */
  private async emailIssued(invoiceId: string, now: Date): Promise<void> {
    if (rfInvoicingMode() !== "live") return;
    try {
      await this.mailer.sendAuto(invoiceId, "issue", now);
    } catch (e) {
      this.logger.error(`issue email for ${invoiceId} failed: ${(e as Error).message}`);
    }
  }

  /**
   * One notice per (action, tenant, period key), claimed under a transaction advisory lock so two
   * replicas or a rerun see the first one's row. Best effort: a failure here never stops the sweep.
   */
  private async raiseOnce(
    tenantId: string,
    action: string,
    periodKey: string,
    message: string,
  ): Promise<void> {
    const dedupeKey = `${action}:${tenantId}:${periodKey}`;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"admin-alert"}), hashtext(${dedupeKey}))`;
        const seen = await tx.auditLog.findFirst({
          where: {
            tenantId,
            entityType: ADMIN_AUDIT_ENTITY,
            action,
            meta: { path: ["dedupeKey"], equals: dedupeKey },
          },
          select: { id: true },
        });
        if (seen) return;
        await writeAdminNotice(tx, { tenantId, action, message, meta: { periodKey, dedupeKey } });
      });
    } catch (e) {
      this.logger.error(
        `tenant ${tenantId}: the "${action}" notice could not be written: ${(e as Error).message}`,
      );
    }
  }
}

/** The subscription's period ended more than a day ago: rollCycles has not caught up. */
export function isStale(sub: IssuerSubscription, now: Date): boolean {
  return (sub.periodEnd as Date).getTime() < now.getTime() - RF_INVOICE_STALE_DAYS * DAY_MS;
}

/** The cron query's predicate, applied again to each row read. */
export function isCandidate(sub: IssuerSubscription): boolean {
  return (
    sub.externalPayment === true &&
    !sub.stripeSubId &&
    !!sub.planKey &&
    sub.cancelAtPeriodEnd === false &&
    !!sub.periodStart &&
    !!sub.periodEnd &&
    !!sub.tenant &&
    sub.tenant.class === "PRODUCTION" &&
    sub.tenant.deletedAt == null &&
    sub.tenant.status === "ACTIVE"
  );
}
