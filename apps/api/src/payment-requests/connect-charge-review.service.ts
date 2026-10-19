import { Injectable, Logger } from "@nestjs/common";
import type { PaymentMethod } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";

export type ChargeReviewKind = "refund" | "dispute";
export type ChargeReviewResult = "flagged" | "already_flagged" | "no_matching_payment";

export interface ChargeReviewInput {
  tenantId: string;
  kind: ChargeReviewKind;
  /** Stripe event id — the idempotency key for the invoice breadcrumb. */
  eventId: string;
  paymentIntentId: string | null;
  chargeId: string;
}

/**
 * Row 616. A refund or chargeback raised on a tenant's connected Stripe account leaves the
 * RouteFlow InvoicePayment (and so the invoice) PAID. RouteFlow never issues refunds itself
 * (tenants refund in their own Stripe dashboard) and a refund may be partial, so this NEVER
 * changes an amount or a status. It FLAGS the paid invoice for human review instead:
 *
 *  - FLAG = a `[REVIEW]` breadcrumb line appended to `Invoice.internalNotes` (the staff-only
 *    audit-trail field the other system-written breadcrumbs already use) carrying the Stripe
 *    event id, plus an AuditLog row. No schema column exists for "needs review"; a dedicated
 *    `InvoicePayment.reviewFlag` / `reviewReason` (and a PaymentStatus REVIEW value) would
 *    need a migration and is deliberately out of scope here.
 *  - IDEMPOTENT: an invoice whose internalNotes already names the event id is skipped, and
 *    the operators are only notified when this call newly flagged something, so a Stripe
 *    redelivery never double-flags or double-notifies. The append is compare-and-set on the
 *    notes text it read, so a concurrent staff edit fails the write (-> 500 -> redelivery)
 *    instead of being overwritten.
 *  - A card settlement above the open balances is booked as an AdvancePayment (on-account
 *    credit) with the same reference, so that row gets the same breadcrumb in `notes`; a
 *    split payment flags both. Only CREDIT_CARD / ACH rows qualify.
 *  - Lookup is tenant-scoped (`forTenant()` inside `tenantContext.run`) by
 *    `reference = paymentIntentId`, the same key `PaymentRequestsService` writes.
 *
 * The flag write THROWS on failure (the controller answers 500 and Stripe redelivers). The
 * push notification is best-effort and sent only AFTER the flag is durable.
 */
@Injectable()
export class ConnectChargeReviewService {
  private readonly logger = new Logger(ConnectChargeReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  async flagForReview(input: ChargeReviewInput): Promise<ChargeReviewResult> {
    const { tenantId, kind, eventId, paymentIntentId, chargeId } = input;
    if (!paymentIntentId) {
      this.logger.warn(
        `Connect ${kind} ${eventId} (charge ${chargeId}) has no PaymentIntent — nothing to flag`,
      );
      return "no_matching_payment";
    }

    return this.tenantContext.run(tenantId, async () => {
      // Card settlement books the PaymentIntent as InvoicePayment row(s) and, for any amount
      // above the open balances, an AdvancePayment (on-account credit) with the same reference.
      // Only the card/ACH methods the Connect webhook writes qualify: a hand-keyed cash payment
      // with a free-text "pi_..." reference must never be flagged.
      const methods: { in: PaymentMethod[] } = { in: ["CREDIT_CARD", "ACH"] };
      const payments: Array<{
        id: string;
        invoice: { id: string; invoiceNumber: string; internalNotes: string | null };
      }> = await this.prisma.forTenant().invoicePayment.findMany({
        where: { reference: paymentIntentId, status: { not: "VOID" }, method: methods },
        select: {
          id: true,
          invoice: { select: { id: true, invoiceNumber: true, internalNotes: true } },
        },
      });
      // AdvancePayment has no status column (nothing to exclude); `notes` is its free-text field.
      const advances: Array<{ id: string; notes: string | null }> = await this.prisma
        .forTenant()
        .advancePayment.findMany({
          where: { reference: paymentIntentId, method: methods },
          select: { id: true, notes: true },
        });
      if (payments.length === 0 && advances.length === 0) {
        this.logger.warn(
          `Connect ${kind} ${eventId}: no InvoicePayment or AdvancePayment for PaymentIntent ${paymentIntentId} in tenant ${tenantId} — nothing to flag`,
        );
        return "no_matching_payment";
      }

      const invoices = new Map<string, (typeof payments)[number]["invoice"]>();
      for (const p of payments) invoices.set(p.invoice.id, p.invoice);

      const noun = kind === "refund" ? "refund" : "dispute (chargeback)";
      const breadcrumb = (what: string) =>
        `[REVIEW] Stripe reported a ${noun} on a card payment for ${what} (${eventId}). It is still recorded as paid; confirm the amount in Stripe and adjust if needed.`;
      const append = (existing: string | null, line: string) =>
        existing ? `${existing}\n${line}` : line;

      let newlyFlagged = 0;
      for (const inv of invoices.values()) {
        if (inv.internalNotes?.includes(eventId)) continue;
        const { count } = await this.prisma.forTenant().invoice.updateMany({
          where: { id: inv.id, internalNotes: inv.internalNotes },
          data: { internalNotes: append(inv.internalNotes, breadcrumb("this invoice")) },
        });
        if (count !== 1) {
          throw new Error(`Invoice ${inv.invoiceNumber} changed while flagging — retry`);
        }
        newlyFlagged++;
        await this.audit.log({
          tenantId,
          userId: null,
          action: `stripe.charge.${kind}.flagged_for_review`,
          entityType: "Invoice",
          entityId: inv.id,
          meta: { eventId, paymentIntentId, chargeId },
        });
      }
      for (const adv of advances) {
        if (adv.notes?.includes(eventId)) continue;
        const { count } = await this.prisma.forTenant().advancePayment.updateMany({
          where: { id: adv.id, notes: adv.notes },
          data: { notes: append(adv.notes, breadcrumb("this on-account credit")) },
        });
        if (count !== 1) {
          throw new Error(`On-account credit ${adv.id} changed while flagging — retry`);
        }
        newlyFlagged++;
        await this.audit.log({
          tenantId,
          userId: null,
          action: `stripe.charge.${kind}.flagged_for_review`,
          entityType: "AdvancePayment",
          entityId: adv.id,
          meta: { eventId, paymentIntentId, chargeId },
        });
      }
      if (newlyFlagged === 0) return "already_flagged";

      await this.notifyOperators(
        tenantId,
        kind,
        [...invoices.values()].map((i) => i.invoiceNumber),
        advances.length > 0,
      );
      return "flagged";
    });
  }

  private async notifyOperators(
    tenantId: string,
    kind: ChargeReviewKind,
    invoiceNumbers: string[],
    hasOnAccountCredit: boolean,
  ): Promise<void> {
    const title = kind === "refund" ? "Card refund needs review" : "Card dispute needs review";
    const targets: string[] = [];
    if (invoiceNumbers.length > 0) {
      targets.push(
        `${invoiceNumbers.length === 1 ? "invoice" : "invoices"} ${invoiceNumbers.join(", ")}`,
      );
    }
    if (hasOnAccountCredit) targets.push("on-account credit");
    const body =
      `Stripe reported a ${kind === "refund" ? "refund" : "dispute"} on a card payment for ` +
      `${targets.join(" and ")}. It is still recorded as paid; review it and adjust the books ` +
      `if needed.`;
    try {
      const operators = await this.prisma.user.findMany({
        where: { tenantId, role: { in: ["OPERATOR", "TENANT_ADMIN"] }, status: "ACTIVE" },
        select: { id: true },
      });
      // In parallel and settled: one slow or failing push must not delay or cancel the rest.
      await Promise.allSettled(
        operators.map((op) => this.notifications.sendToUser(op.id, { title, body })),
      );
    } catch (err: any) {
      // The flag above is the durable record; a notification failure must not fail the webhook.
      this.logger.warn(`Connect ${kind} review notification failed: ${err?.message}`);
    }
  }
}
