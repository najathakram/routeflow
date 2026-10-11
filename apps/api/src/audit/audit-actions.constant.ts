/**
 * Tenant-level audit ACTION names written by the API's own services (platform-admin actions have their own
 * table in platform-admin/audit-actions.constant.ts). One named constant per action so a rename is one edit.
 *
 * The values are dotted lowercase, like the existing `counter-sale.price-edited`, and deliberately NOT the same
 * word as an API error code: api-error-codes-parity.spec.ts fails on a bare error-code literal anywhere else.
 */
export const AUDIT_ACTIONS = {
  /** SA-762r: a counter sale voided in one transaction; meta {orderId, reason, handBack, actor} feeds the replay. */
  COUNTER_SALE_VOIDED: "counter-sale.voided",
  /** SA-763r P-3: a non-DRAFT invoice restated by an order edit; meta {invoiceId, orderId, actor, totalBefore, totalAfter, linesChanged}. */
  INVOICE_REVISED: "invoice.revised",
  /** SA-763r P-3 (B1098): a restatement left the invoice paid past its new total; meta {invoiceId, paid, total, overpaidBy, actor}. */
  INVOICE_OVERPAID_AFTER_RESTATEMENT: "invoice.overpaid-after-restatement",
  /** SA-763r P-3 [L-O2]: the operator's deliberate standalone overpayment; meta {invoiceId, paymentGroupId, overpaidBy, actor}. */
  INVOICE_DELIBERATE_OVERPAYMENT: "invoice.deliberate-overpayment",
  /** SA-737: a STANDARD return's cash/card/check refund recorded; meta {returnId, returnNumber, orderId, customerId, invoiceIds, amount, tender, actor, impersonatedBy}. */
  STANDARD_REFUND_RECORDED: "return.refund-recorded",
} as const;

export type AuditActionName = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
