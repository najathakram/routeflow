/**
 * The two InvoicesService methods updateOrderItems reaches on EVERY staff edit (SA-763r P-3 / SA-760 Q-760-1):
 * `projectEditedInvoiceTotals` (the overpay judge's projection) and `followPartialPrices` (the DRAFT-partial
 * price follow). A spec that builds OrdersService with a hand-made `invoicesService` (no real InvoicesService)
 * spreads this into it, so there is ONE definition of "an order with no invoices to project or follow".
 * Production never needs it: OrdersService is injected the real InvoicesService (edit-overpay-wiring.spec.ts).
 */
export const INVOICE_EDIT_STUBS = {
  projectEditedInvoiceTotals: async () => [],
  followPartialPrices: async () => ({ issuedPartialsUnchanged: [], followed: [] as string[] }),
};
