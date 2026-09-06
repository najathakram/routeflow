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
