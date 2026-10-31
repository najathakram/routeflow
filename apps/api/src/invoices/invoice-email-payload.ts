import { isPaidAtSale, perBaseUnitPrice } from "@routeflow/pricing";
import { formatDate } from "../messaging/messaging.helpers";
import { computeDepositFields } from "./deposit-fields";
import { confirmedBalance } from "./invoice-balance-classify";
import { sortInvoiceLines } from "./invoice-line-order";
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
/**
 * The ONE paid basis of every invoice email (W-680, SA-848 LOW 2): the invoice email and the reminder both read this.
 * F03/R8/T-B102: CONFIRMED (PAID) rows only, so a DRAFT payment never inflates what the customer is told they paid and a
 * reminder demands the true outstanding balance. B421: `totalPaid` is cash only; a CREDIT_NOTE or ADVANCE application never
 * reads as "Amount Paid", and the credit notes that were applied are listed once each.
 */
export function emailPaidBasis(inv: { total: unknown; payments?: any[] | null }) {
  const { cash: totalPaid, creditApplied, advanceApplied } = splitConfirmed(inv.payments);
  const balanceDue = confirmedBalance(inv.total as never, inv.payments as never);
  const creditNoteNumbers: string[] = Array.from(
    new Set<string>(
      (inv.payments ?? [])
        .filter((p: any) => p.method === CREDIT_NOTE_METHOD)
        .map((p: any) => p.creditNote?.creditNoteNumber)
        .filter((n: unknown): n is string => !!n),
    ),
  );
  return { totalPaid, creditApplied, advanceApplied, creditNoteNumbers, balanceDue };
}

/** SA-1029: the per-piece price beside a pack line (display only); the unit word is the frozen label, else the live product's. */
function itemPerBaseUnit(it: any) {
  return perBaseUnitPrice(
    { ...it, unitPrice: it.unitPrice != null ? Number(it.unitPrice) : null },
    it.baseLabel ?? it.product?.baseUnitLabel,
  );
}

export function buildInvoiceEmailPayload(
  inv: any,
  ctx: {
    recipientEmail: string;
    pdfUrl: string | undefined;
    attachment: InvoiceEmailAttachment | undefined;
    hideOriginalPrice: boolean;
  },
) {
  const { totalPaid, creditApplied, advanceApplied, creditNoteNumbers, balanceDue } =
    emailPaidBasis(inv);
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
    items: sortInvoiceLines(inv.items).map((it: any) => ({
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
      perBaseUnit: itemPerBaseUnit(it),
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

/** The delivery inputs `buildReminderEmailPayload` takes; the paid basis is derived from the invoice (`emailPaidBasis`). */
export interface EmailPayloadParts {
  recipientEmail: string;
  pdfUrl: string | undefined;
  attachment: InvoiceEmailAttachment | undefined;
  hideOriginalPrice: boolean;
}

/** `InvoicesService.sendReminder`'s payload (the same item table, without the sendEmail-only terms / deposit fields). */
export function buildReminderEmailPayload(inv: any, x: EmailPayloadParts) {
  const { recipientEmail, pdfUrl, attachment, hideOriginalPrice } = x;
  const { totalPaid, creditApplied, advanceApplied, creditNoteNumbers, balanceDue } =
    emailPaidBasis(inv);
  return {
    to: recipientEmail,
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
    items: sortInvoiceLines(inv.items).map((it: any) => ({
      description: it.description,
      qty: Number(it.qty),
      unitPrice: Number(it.unitPrice),
      subtotal: Number(it.subtotal),
      msrp: it.msrp != null ? Number(it.msrp) : null,
      // F03/R9: see sendEmail's matching comment — a reminder renders the same
      // item table, so it needs the same promo scalars.
      originalPrice: it.originalPrice != null ? Number(it.originalPrice) : null,
      priceType: it.priceType ?? null,
      promoFreeUnits: it.promoFreeUnits != null ? Number(it.promoFreeUnits) : null,
      ...invoiceItemQtyFields(it),
      perBaseUnit: itemPerBaseUnit(it),
    })),
    pdfUrl,
    attachment,
    isReminder: true,
    hideOriginalPrice,
  };
}
