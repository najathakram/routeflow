import { InvoiceStatus } from "@prisma/client";
/** Manual operator apply (`applyToInvoice`): refuses a settled, dead or forgiven target. */
export const CREDIT_NOT_APPLICABLE: InvoiceStatus[] = [
  InvoiceStatus.PAID,
  InvoiceStatus.VOID,
  InvoiceStatus.WRITTEN_OFF,
];
/**
 * Automatic apply (`applyCreditInTx`, reached by settleOrderCreditsInTx and autoApplyOldestCreditsInTx).
 * Deliberately NARROWER than CREDIT_NOT_APPLICABLE: PAID must stay applicable-but-zero-balance because
 * settle's SHRINK pass runs over the same invoice list and PAID is exactly where shrink has work.
 * This set gates the WRITE, not the query — the settle `where` keeps WRITTEN_OFF so shrink can restore excess.
 */
export const CREDIT_SETTLE_EXCLUDED: InvoiceStatus[] = [
  InvoiceStatus.VOID,
  InvoiceStatus.WRITTEN_OFF,
];
/** Minting (`CreditNotesService.create`): a dead or forgiven invoice justifies no new credit. DRAFT is allowed on purpose. */
export const CREDIT_SOURCE_EXCLUDED: InvoiceStatus[] = [
  InvoiceStatus.VOID,
  InvoiceStatus.WRITTEN_OFF,
];
/** Delivery payment targets (`recordDeliveryPaymentInTx`): an ALLOW-list. */
export const PAYABLE: InvoiceStatus[] = [
  InvoiceStatus.DRAFT,
  InvoiceStatus.SENT,
  InvoiceStatus.PARTIAL,
  InvoiceStatus.OVERDUE,
];
/**
 * "Open" invoices for an aggregate/summary read (KPI tiles, dashboards):
 * excludes settled/dead/forgiven (PAID/VOID/WRITTEN_OFF, same as
 * CREDIT_NOT_APPLICABLE) AND DRAFT — a not-yet-issued invoice has nothing due
 * and must never inflate a receivables/aging figure the way it must still
 * block a credit application (CREDIT_NOT_APPLICABLE keeps DRAFT applicable).
 * B12 (`getKpiSummary`): reproduces the page.tsx memo's own exclusion list.
 */
export const KPI_SUMMARY_EXCLUDED: InvoiceStatus[] = [
  InvoiceStatus.PAID,
  InvoiceStatus.VOID,
  InvoiceStatus.WRITTEN_OFF,
  InvoiceStatus.DRAFT,
];
/**
 * LIFETIME billed history (the customer statement's "Invoiced Amount" tile,
 * M1): every invoice the customer was actually billed, over the WHOLE history.
 * Deliberately WIDER than KPI_SUMMARY_EXCLUDED — PAID / OVERDUE / WRITTEN_OFF
 * are real past billings and belong in a lifetime figure even though they are
 * not open receivables — and narrower than "everything": DRAFT was never
 * issued and VOID was cancelled, so neither was ever billed.
 */
export const LIFETIME_INVOICED_EXCLUDED: InvoiceStatus[] = [
  InvoiceStatus.DRAFT,
  InvoiceStatus.VOID,
];
