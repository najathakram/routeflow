import { INVOICE_STATUS_VALUES, type InvoiceStatus } from "./api/enums";

/**
 * W-1470: the ONE invoice status table, shared by web and mobile. Pure data: no React, no clock. Every table is a
 * `Record<InvoiceStatus, ...>`, so a status added to `INVOICE_STATUS_VALUES` fails type-check here until it has a tone, a
 * staff word and a buyer word (L-072). Screens turn a tone into their own class or pill; the due-date and overdue wording
 * lives with the screen that has the tenant's day (`apps/web/lib/invoice-status-display.tsx`).
 */
export const INVOICE_STATUS_TONES = [
  "neutral",
  "info",
  "warning",
  "danger",
  "success",
  "muted",
  "stone",
] as const;
export type InvoiceStatusTone = (typeof INVOICE_STATUS_TONES)[number];

/**
 * The tone of an invoice by its stored status. A sent invoice that is not due is blue (info): amber means partly paid or
 * due today, red means overdue. Overdue and due-today shading is the screen's job (it needs the tenant's day).
 */
export const INVOICE_STATUS_TONE: Record<InvoiceStatus, InvoiceStatusTone> = {
  DRAFT: "neutral",
  SENT: "info",
  VIEWED: "info",
  PARTIAL: "warning",
  PAID: "success",
  OVERDUE: "danger",
  VOID: "muted",
  WRITTEN_OFF: "stone",
};

/** The word staff screens print for a stored status. */
export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  DRAFT: "Draft",
  SENT: "Sent",
  VIEWED: "Viewed",
  PARTIAL: "Partial",
  PAID: "Paid",
  OVERDUE: "Overdue",
  VOID: "Void",
  WRITTEN_OFF: "Written off",
};

/** The word the buyer portal's invoice list prints today (a separate table so buyer wording can differ from staff). */
export const INVOICE_STATUS_BUYER_LABEL: Record<InvoiceStatus, string> = {
  DRAFT: "Draft",
  SENT: "Sent",
  VIEWED: "Viewed",
  PARTIAL: "Partial",
  PAID: "Paid",
  OVERDUE: "Overdue",
  VOID: "Void",
  WRITTEN_OFF: "Written Off",
};

/**
 * The buyer screens' tone per status (B1122, unchanged by W-1470): a sent invoice is amber there (it is money owed), void
 * and written off are red. Shared so the mobile buyer screens (PR-2) read the same table.
 */
export const INVOICE_STATUS_BUYER_TONE: Record<InvoiceStatus, InvoiceStatusTone> = {
  DRAFT: "neutral",
  SENT: "warning",
  VIEWED: "info",
  PARTIAL: "warning",
  PAID: "success",
  OVERDUE: "danger",
  VOID: "danger",
  WRITTEN_OFF: "danger",
};

/** The tone for a status string; a status this build does not know yet is neutral. */
export function invoiceStatusTone(status: string): InvoiceStatusTone {
  return (
    (INVOICE_STATUS_TONE as Record<string, InvoiceStatusTone | undefined>)[status] ?? "neutral"
  );
}

/** One legend row per status, in enum order. */
export interface InvoiceStatusLegendRow {
  status: InvoiceStatus;
  label: string;
  tone: InvoiceStatusTone;
}
export const INVOICE_STATUS_LEGEND: readonly InvoiceStatusLegendRow[] = INVOICE_STATUS_VALUES.map(
  (status) => ({ status, label: INVOICE_STATUS_LABEL[status], tone: INVOICE_STATUS_TONE[status] }),
);
