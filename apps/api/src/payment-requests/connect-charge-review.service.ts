import { Injectable, Logger } from "@nestjs/common";
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
      const payments: Array<{
        id: string;
        invoice: { id: string; invoiceNumber: string; internalNotes: string | null };
      }> = await this.prisma.forTenant().invoicePayment.findMany({
        where: { reference: paymentIntentId, status: { not: "VOID" } },
        select: {
          id: true,
          invoice: { select: { id: true, invoiceNumber: true, internalNotes: true } },
        },
      });
      if (payments.length === 0) {
        this.logger.warn(
          `Connect ${kind} ${eventId}: no InvoicePayment for PaymentIntent ${paymentIntentId} in tenant ${tenantId} — nothing to flag`,
        );
        return "no_matching_payment";
      }

      const invoices = new Map<string, (typeof payments)[number]["invoice"]>();
      for (const p of payments) invoices.set(p.invoice.id, p.invoice);

      const noun = kind === "refund" ? "refund" : "dispute (chargeback)";
      let newlyFlagged = 0;
      for (const inv of invoices.values()) {
        if (inv.internalNotes?.includes(eventId)) continue;
        const line = `[REVIEW] Stripe reported a ${noun} on a card payment for this invoice (${eventId}). The invoice is still marked paid; confirm the amount in Stripe and adjust if needed.`;
        const { count } = await this.prisma.forTenant().invoice.updateMany({
          where: { id: inv.id, internalNotes: inv.internalNotes },
          data: { internalNotes: inv.internalNotes ? `${inv.internalNotes}\n${line}` : line },
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
      if (newlyFlagged === 0) return "already_flagged";

      await this.notifyOperators(
        tenantId,
        kind,
        [...invoices.values()].map((i) => i.invoiceNumber),
      );
      return "flagged";
    });
  }

  private async notifyOperators(
    tenantId: string,
    kind: ChargeReviewKind,
    invoiceNumbers: string[],
  ): Promise<void> {
    const which = invoiceNumbers.length === 1 ? "invoice" : "invoices";
    const title = kind === "refund" ? "Card refund needs review" : "Card dispute needs review";
    const body =
      `Stripe reported a ${kind === "refund" ? "refund" : "dispute"} on a card payment for ` +
      `${which} ${invoiceNumbers.join(", ")}. It is still marked paid; review it and adjust ` +
      `the books if needed.`;
    try {
      const operators = await this.prisma.user.findMany({
        where: { tenantId, role: { in: ["OPERATOR", "TENANT_ADMIN"] }, status: "ACTIVE" },
        select: { id: true },
      });
      for (const op of operators) {
        await this.notifications.sendToUser(op.id, { title, body }).catch(() => {});
      }
    } catch (err: any) {
      // The flag above is the durable record; a notification failure must not fail the webhook.
      this.logger.warn(`Connect ${kind} review notification failed: ${err?.message}`);
    }
  }
}
