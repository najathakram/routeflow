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
 * An ISSUED invoice that can still be owed (SA-770): the buyer receivables readers fetch these and the
 * classifier decides who actually owes (an overpaid or exactly-paid one reads as paid in substance).
 */
export const OPEN_INVOICE_STATUSES: InvoiceStatus[] = [
  InvoiceStatus.SENT,
  InvoiceStatus.VIEWED,
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
 * "Not an ISSUED invoice": the settled/dead/forgiven statuses AND DRAFT. Used by the shared
 * credit-exposure core (`credit-exposure.ts`) to split ISSUED invoices from drafts — it is NOT
 * itself the credit-exposure read filter. D6 / B462 owner ruling (option B): a DRAFT counts
 * toward credit exposure only when an OPEN or DELIVERED order backs it (`isUnbackedDraft`);
 * only an unbacked draft is excluded and surfaced as "pending exposure". The DB read, the
 * customers list Receivables and the CSV export therefore filter `CREDIT_NOT_APPLICABLE`
 * (drafts included) and drop unbacked drafts in JS. Same members as KPI_SUMMARY_EXCLUDED on
 * purpose (one meaning of "an issued receivable"), but a separate name so the credit basis is
 * greppable and a future divergence is a deliberate edit, not an accident.
 */
export const CREDIT_EXPOSURE_EXCLUDED: InvoiceStatus[] = [
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

/**
 * #2558 / SA-510: invoices a customer delete must never destroy: EVERY status except DRAFT (issued
 * and still owed, paid, written off, or VOID). Defined by EXCLUSION from the Prisma enum, so a
 * status added later blocks by default. #2628 / SA-530 (owner policy 4b): a VOID invoice is an
 * issued document with a number and a history, so it blocks a hard delete too; only a DRAFT (never
 * issued) may be destroyed with its customer. The pre-flights of `CustomersService.batchDelete` and
 * `deleteAllCustomers` block on this set. They used to block on PAID/SENT only, so a customer whose
 * invoices had been viewed, part-paid, marked OVERDUE or written off could be wiped with them.
 */
export const CUSTOMER_DELETE_NON_BLOCKING: readonly InvoiceStatus[] = [InvoiceStatus.DRAFT];
export const CUSTOMER_DELETE_BLOCKING: InvoiceStatus[] = (
  Object.values(InvoiceStatus) as InvoiceStatus[]
).filter((s) => !CUSTOMER_DELETE_NON_BLOCKING.includes(s));
