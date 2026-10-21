/**
 * `InvoicesService.sendEmail`'s email payload, moved verbatim out of the service (behaviour-neutral extraction; the
 * invoices.service.ts size ratchet). Display data only: the PDF link, attachment, paid/balance split, the item table
 * (promo scalars and unit fields included) and the deposit schedule. Nothing here writes.
 */
import { isPaidAtSale } from "@routeflow/pricing";
import { formatDate } from "../messaging/messaging.helpers";
import { computeDepositFields } from "./deposit-fields";
import type { InvoiceEmailAttachment } from "./invoice-attachment";
import { invoiceItemQtyFields } from "./invoice-pdf-item";

export interface EmailPayloadParts {
  recipientEmail: string;
  totalPaid: number;
  creditApplied: number;
  advanceApplied: number;
  creditNoteNumbers: string[];
  balanceDue: number;
  pdfUrl: string | undefined;
  attachment: InvoiceEmailAttachment | undefined;
  hideOriginalPrice: boolean;
}

export function buildInvoiceEmailPayload(inv: any, x: EmailPayloadParts) {
  const {
    recipientEmail,
    totalPaid,
    creditApplied,
    advanceApplied,
    creditNoteNumbers,
    balanceDue,
  } = x;
  const { pdfUrl, attachment, hideOriginalPrice } = x;
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
    pdfUrl,
    attachment,
    isReminder: false,
    hideTerms: isPaidAtSale(inv),
    hideOriginalPrice,
    // Deposit schedule (display-only): derive with the same read-time math the
    // detail endpoint uses; null when the invoice carries no deposit.
    depositAmount: computeDepositFields(inv as any, 0, new Date().toISOString().slice(0, 10))
      .depositAmount,
    depositDueDate: inv.depositDueDate ? formatDate(inv.depositDueDate) : null,
  };
}

/** `InvoicesService.sendReminder`'s payload (the same item table, without the sendEmail-only terms / deposit fields). */
export function buildReminderEmailPayload(inv: any, x: EmailPayloadParts) {
  const {
    recipientEmail,
    totalPaid,
    creditApplied,
    advanceApplied,
    creditNoteNumbers,
    balanceDue,
  } = x;
  const { pdfUrl, attachment, hideOriginalPrice } = x;
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
    items: inv.items.map((it: any) => ({
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
    })),
    pdfUrl,
    attachment,
    isReminder: true,
    hideOriginalPrice,
  };
}
