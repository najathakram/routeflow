import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { RfInvoiceBulkSendResponse, RfInvoiceSendResult } from "@routeflow/types";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { LeaderCron } from "../../common/cron-lock";
import { PrismaService } from "../../prisma/prisma.service";
import { writeAdminNotice } from "../manual-invoice-notice";
import { BillingNotificationService } from "../billing-notification.service";
import {
  RF_INVOICE_AUDIT_ACTIONS,
  RF_INVOICE_REMINDER_CATCHUP_DAYS,
  RF_INVOICE_REMINDER_STAGES,
  RF_INVOICE_SEND_COOLDOWN_MS,
  RF_INVOICE_SEND_MAX_IDS,
  rfInvoiceTenantScope,
  rfInvoiceTestTenantSlugs,
  rfInvoicingMode,
  type RfInvoiceSendTrigger,
} from "./rf-invoice.constants";

const DAY_MS = 24 * 60 * 60 * 1000;
const dayStart = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Everything the email and the send bookkeeping read; no admin-only column. */
const SEND_SELECT = {
  id: true,
  tenantId: true,
  number: true,
  amount: true,
  currency: true,
  status: true,
  periodStart: true,
  periodEnd: true,
  dueDate: true,
  issuedAt: true,
  lines: true,
  lastSentAt: true,
  tenant: { select: { subscription: { select: { stripeSubId: true } } } },
} as const;

/** A tenant that has since moved to a card subscription is no longer chased by the automatic emails. */
const paysByCard = (row: any): boolean => !!row?.tenant?.subscription?.stripeSubId;

export interface RemindSummary {
  mode: ReturnType<typeof rfInvoicingMode>;
  considered: number;
  sent: number;
}

/**
 * Emails RouteFlow's own invoices to manual-pay tenants: the super-admin resend (single and bulk), the
 * issue email, and the d0/d7/d14 reminders. An email is a notification, never a consequence: nothing here
 * writes a tenant, its subscription or the billing event ledger. `RF_INVOICING_MODE`: off sends nothing at all;
 * silent allows only the manual resend; live adds the issue email and the reminders.
 */
@Injectable()
export class RfInvoiceMailerService {
  private readonly logger = new Logger(RfInvoiceMailerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: BillingNotificationService,
  ) {}

  // ─── Manual resend ────────────────────────────────────────────────────────

  /** POST rf-invoices/:id/send. Refuses outright while invoicing is off; an unknown id is a 404. */
  async sendManual(
    id: string,
    actorId: string,
    now: Date = new Date(),
  ): Promise<RfInvoiceSendResult> {
    this.requireInvoicingOn();
    const r = await this.attemptManual(id, actorId, now);
    if (r.outcome === "not_found") throw new NotFoundException("Invoice not found");
    return r;
  }

  /** POST rf-invoices/send: 1..50 ids, one at a time, one result per id in request order. */
  async sendMany(
    ids: string[],
    actorId: string,
    now: Date = new Date(),
  ): Promise<RfInvoiceBulkSendResponse> {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > RF_INVOICE_SEND_MAX_IDS) {
      throw new BadRequestException(
        `Send between 1 and ${RF_INVOICE_SEND_MAX_IDS} invoices at a time.`,
      );
    }
    this.requireInvoicingOn();
    const results: RfInvoiceSendResult[] = [];
    for (const id of [...new Set(ids)]) results.push(await this.attemptManual(id, actorId, now));
    return { results };
  }

  private requireInvoicingOn(): void {
    if (rfInvoicingMode() === "off") {
      throw new ConflictException({
        code: API_ERROR_CODES.RF_INVOICING_OFF,
        message: "Invoicing is switched off (RF_INVOICING_MODE).",
      });
    }
  }

  /**
   * One resend. The claim is a compare-and-set on `lastSentAt` (only an OPEN invoice not sent in the last
   * 10 minutes), so two admins racing produce one email. A send that reaches nobody gives the claim back.
   */
  private async attemptManual(
    id: string,
    actorId: string,
    now: Date,
  ): Promise<RfInvoiceSendResult> {
    const row = await this.prisma.rfInvoice.findFirst({
      where: { id, tenant: rfInvoiceTenantScope(rfInvoiceTestTenantSlugs()) },
      select: SEND_SELECT,
    });
    if (!row) return { id, outcome: "not_found" };
    if (row.status !== "OPEN") return { id, number: row.number, outcome: "not_open" };

    const cutoff = new Date(now.getTime() - RF_INVOICE_SEND_COOLDOWN_MS);
    const { count } = await this.prisma.rfInvoice.updateMany({
      where: { id, status: "OPEN", OR: [{ lastSentAt: null }, { lastSentAt: { lt: cutoff } }] },
      data: { lastSentAt: now },
    });
    if (count === 0) {
      const fresh = await this.prisma.rfInvoice.findFirst({
        where: { id },
        select: { number: true, status: true, lastSentAt: true },
      });
      if (!fresh) return { id, outcome: "not_found" };
      if (fresh.status !== "OPEN") return { id, number: fresh.number, outcome: "not_open" };
      const last = fresh.lastSentAt ?? now;
      return {
        id,
        number: fresh.number,
        outcome: "cooldown",
        nextAllowedAt: new Date(last.getTime() + RF_INVOICE_SEND_COOLDOWN_MS).toISOString(),
      };
    }

    const sent = await this.notifier.sendRfInvoice(this.forEmail(row, now), "manual");
    if (sent.status === "sent") {
      await this.record(row, "manual", sent.recipients, actorId, now);
      return { id, number: row.number, outcome: "sent", recipients: sent.recipients };
    }
    // Nobody got it: put the previous lastSentAt back (only if it is still our stamp), so a retry is allowed.
    await this.prisma.rfInvoice.updateMany({
      where: { id, lastSentAt: now },
      data: { lastSentAt: row.lastSentAt },
    });
    return {
      id,
      number: row.number,
      outcome: sent.status === "no_recipients" ? "no_recipients" : "failed",
    };
  }

  // ─── Issue email and reminders (live mode only) ───────────────────────────

  /**
   * The issue email (kind `issue`) or one reminder stage for one invoice. Live mode only; an invoice that is
   * no longer OPEN is skipped. Never throws: a mail problem must not undo an issue or stop a sweep.
   */
  async sendAuto(
    invoiceId: string,
    kind: Exclude<RfInvoiceSendTrigger, "manual">,
    now: Date = new Date(),
  ): Promise<void> {
    if (rfInvoicingMode() !== "live") return;
    try {
      const row = await this.prisma.rfInvoice.findFirst({
        where: { id: invoiceId, tenant: rfInvoiceTenantScope(rfInvoiceTestTenantSlugs()) },
        select: SEND_SELECT,
      });
      if (!row || row.status !== "OPEN" || paysByCard(row)) return;
      await this.sendAutoRow(row, kind, now);
    } catch (e) {
      this.logger.error(
        `rf invoice ${kind} email failed for ${invoiceId}: ${(e as Error).message}`,
      );
    }
  }

  private async sendAutoRow(
    row: any,
    kind: Exclude<RfInvoiceSendTrigger, "manual">,
    now: Date,
  ): Promise<boolean> {
    const r = await this.notifier.sendRfInvoice(this.forEmail(row, now), kind);
    if (r.status !== "sent") return false;
    await this.record(row, kind, r.recipients, null, now);
    return true;
  }

  @LeaderCron("0 14 * * *", "billing-invoice.remind")
  async remind(): Promise<RemindSummary> {
    return this.runRemind(new Date());
  }

  /**
   * d0 / d7 / d14 reminders for OPEN invoices of PRODUCTION tenants (plus the test allowlist), at the highest stage reached
   * (UTC days after the due date). Claim-keyed "<number>:<stage>", so a rerun sends nothing, and nothing
   * more follows d14. Tenants now paying by card are skipped. Flag only: no consequence follows a reminder.
   */
  async runRemind(now: Date): Promise<RemindSummary> {
    const mode = rfInvoicingMode();
    const summary: RemindSummary = { mode, considered: 0, sent: 0 };
    if (mode !== "live") return summary;

    const today = dayStart(now);
    const lastStage = RF_INVOICE_REMINDER_STAGES[RF_INVOICE_REMINDER_STAGES.length - 1];
    const rows = await this.prisma.rfInvoice.findMany({
      where: {
        status: "OPEN",
        dueDate: {
          gte: new Date(
            today.getTime() - (lastStage.days + RF_INVOICE_REMINDER_CATCHUP_DAYS) * DAY_MS,
          ),
          lt: new Date(today.getTime() + DAY_MS),
        },
        tenant: rfInvoiceTenantScope(rfInvoiceTestTenantSlugs()),
      },
      select: SEND_SELECT,
      orderBy: { dueDate: "asc" },
    });
    for (const row of rows as any[]) {
      if (paysByCard(row)) continue;
      const daysAfter = Math.round((today.getTime() - dayStart(row.dueDate).getTime()) / DAY_MS);
      // Bounded catch-up: a stage is live from its stage day to CATCHUP_DAYS after it (a missed cron is
      // made up), then skipped for good. Only the highest live stage is tried and its claim key makes it once.
      const stage = [...RF_INVOICE_REMINDER_STAGES]
        .reverse()
        .find((s) => daysAfter >= s.days && daysAfter <= s.days + RF_INVOICE_REMINDER_CATCHUP_DAYS);
      if (!stage) continue;
      // The issue email already told the tenant where the invoice stands: a stage whose day was at or before
      // the day the invoice was issued is covered by it (a same-day d0 would double up), later stages still fire.
      if (
        row.issuedAt &&
        dayStart(row.issuedAt).getTime() >= dayStart(row.dueDate).getTime() + stage.days * DAY_MS
      )
        continue;
      summary.considered++;
      try {
        if (await this.sendAutoRow(row, stage.trigger, now)) summary.sent++;
      } catch (e) {
        this.logger.error(`rf invoice reminder failed for ${row.id}: ${(e as Error).message}`);
      }
    }
    if (summary.sent) this.logger.log(`rf invoice reminders: sent ${summary.sent}`);
    return summary;
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private forEmail(row: any, now: Date) {
    const overdueDays = row.dueDate
      ? Math.max(
          0,
          Math.round((dayStart(now).getTime() - dayStart(row.dueDate).getTime()) / DAY_MS),
        )
      : 0;
    return {
      id: row.id as string,
      tenantId: row.tenantId as string,
      number: row.number as string,
      amount: Number(row.amount),
      currency: row.currency as string,
      periodStart: row.periodStart as Date | null,
      periodEnd: row.periodEnd as Date | null,
      dueDate: row.dueDate as Date | null,
      lines: row.lines as unknown,
      overdueDays,
    };
  }

  /**
   * An email went out: count it and write the audit row, together. The audit meta carries the recipient
   * COUNT only, never an address (SEC-4). The email is already sent, so a failure here is logged, not thrown.
   */
  private async record(
    row: { id: string; tenantId: string; number: string },
    trigger: RfInvoiceSendTrigger,
    recipients: number,
    actorId: string | null,
    now: Date,
  ): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx: any) => {
        await tx.rfInvoice.update({
          where: { id: row.id },
          data: {
            sendCount: { increment: 1 },
            ...(trigger === "manual" ? {} : { lastSentAt: now }),
          },
        });
        await writeAdminNotice(tx, {
          tenantId: row.tenantId,
          actorId,
          action: RF_INVOICE_AUDIT_ACTIONS.SENT,
          message: `RouteFlow invoice ${row.number} emailed to ${recipients} ${recipients === 1 ? "recipient" : "recipients"} (${trigger}).`,
          meta: { invoiceId: row.id, number: row.number, trigger, recipients },
        });
      });
    } catch (e) {
      this.logger.error(`rf invoice ${row.number}: send was not recorded: ${(e as Error).message}`);
    }
  }
}
