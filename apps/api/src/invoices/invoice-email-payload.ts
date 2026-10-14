import { isPaidAtSale } from "@routeflow/pricing";
import { formatDate } from "../messaging/messaging.helpers";
import { computeDepositFields } from "./deposit-fields";
import { confirmedBalance } from "./invoice-balance-classify";
import { invoiceItemQtyFields } from "./invoice-pdf-item";
import { CREDIT_NOTE_METHOD, splitConfirmed } from "./payment-predicates";
import type { InvoiceEmailAttachment } from "./invoice-attachment";

/**
 * The email body's inputs for `InvoicesService.deliverEmail`, moved out of the service verbatim (the service is on the
 * size ratchet; #2088). Pure: it reads the loaded invoice and what the caller resolved (recipient, PDF link /
 * attachment, the tenant's hide-original-price setting).
 *
 * F03/R8/T-B102: CONFIRMED (PAID) basis - mirrors the PDF and the invoice detail's own paidAmount/balanceDue math. A
 * DRAFT (unconfirmed) payment must not inflate what the email tells the customer they've already paid. B421:
 * totalPaid is cash-only - a CREDIT_NOTE or ADVANCE application must never render as "Amount Paid"; balanceDue stays on
 * the full confirmed total. F03/R9: the item table honours the hide-original-price preference like the PDF does.
 */
export function buildInvoiceEmailPayload(
  inv: any,
  ctx: {
    recipientEmail: string;
    pdfUrl: string | undefined;
    attachment: InvoiceEmailAttachment | undefined;
    hideOriginalPrice: boolean;
  },
) {
  const { cash: totalPaid, creditApplied, advanceApplied } = splitConfirmed(inv.payments);
  const balanceDue = confirmedBalance(inv.total, inv.payments);
  const creditNoteNumbers: string[] = Array.from(
    new Set<string>(
      (inv.payments ?? [])
        .filter((p: any) => p.method === CREDIT_NOTE_METHOD)
        .map((p: any) => p.creditNote?.creditNoteNumber)
        .filter((n: unknown): n is string => !!n),
    ),
  );
  return {
    to: ctx.recipientEmail,
    customerName: inv.customer?.businessName ?? "Customer",
    invoiceNumber: inv.invoiceNumber,
    invoiceId: inv.id,
    issueDate: formatDate(inv.issueDate),
    dueDate: formatDate(inv.dueDate),
    paymentTermsLabel: inv.paymentTermsLabel ?? undefined,
    total: Number(inv.total),
    totalPaid,
    creditApplied,
    advanceApplied,
    creditNoteNumbers,
    balanceDue,
    items: inv.items.map((it: any) => ({
      description: it.description,
      qty: Number(it.qty),
      unitPrice: Number(it.unitPrice),
      subtotal: Number(it.subtotal),
      msrp: it.msrp != null ? Number(it.msrp) : null,
      // F03/R9: without these, buildInvoiceEmail's strike/"N free" note and a BOGO line's reduced subtotal read as a pricing error.
      originalPrice: it.originalPrice != null ? Number(it.originalPrice) : null,
      priceType: it.priceType ?? null,
      promoFreeUnits: it.promoFreeUnits != null ? Number(it.promoFreeUnits) : null,
      ...invoiceItemQtyFields(it),
    })),
    pdfUrl: ctx.pdfUrl,
    attachment: ctx.attachment,
    isReminder: false,
    hideTerms: isPaidAtSale(inv),
    hideOriginalPrice: ctx.hideOriginalPrice,
    // Deposit schedule (display-only): derive with the same read-time math the detail endpoint uses; null when the
    // invoice carries no deposit.
    depositAmount: computeDepositFields(inv, 0, new Date().toISOString().slice(0, 10))
      .depositAmount,
    depositDueDate: inv.depositDueDate ? formatDate(inv.depositDueDate) : null,
  };
}
