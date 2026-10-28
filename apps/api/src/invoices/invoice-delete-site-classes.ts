/**
 * SA-1050 A-1: the class of every hard delete of an Invoice row, as data. Read by invoice-delete-sites.pin.spec (every site
 * classed) and write-off-ledger.pin.spec (event deletes only at the WIPE sites). Paths are relative to apps/api.
 *   WIPE        deletes the events of the invoices it deletes, first
 *   REFUSE      refuses an invoice that has write-off history (assertNoWriteOffHistory)
 *   DRAFT_ONLY  deletes DRAFT invoices only; a DRAFT never carries an event, and the RESTRICT FK is its backstop
 */
export type InvoiceDeleteClass = "WIPE" | "REFUSE" | "DRAFT_ONLY";

export const INVOICE_DELETE_SITE_CLASSES: Record<string, InvoiceDeleteClass> = {
  "src/system-config/settings.controller.ts": "WIPE",
  "scripts/cleanup-qa-data.js": "WIPE",
  "scripts/demo-seed.js": "WIPE",
  "scripts/reset-and-seed.ts": "WIPE",
  "scripts/sales-facts-timing.ts": "WIPE",
  "src/invoices/invoices.service.ts": "REFUSE",
  "src/orders/order-invoice-delete.ts": "REFUSE",
  "src/customers/customer-delete-preflight.ts": "DRAFT_ONLY",
};
