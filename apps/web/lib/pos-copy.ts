/**
 * POS mode (SA-763r P-2) visible copy: fixed strings, never an API message (lib/raw-message-allowlist.json is a
 * ratchet: a new surface must not read `.response.data.message`).
 */
export const POS_COPY = {
  switchLabel: "POS mode",
  switchHint: "A named customer, invoiced now. For walk-in, pay-now sales use Counter.",
  switchFailed: "Couldn't save your POS mode setting. Try again.",
  confirmAndInvoice: "Confirm & invoice",
  confirmOnly: "Confirm only",
  confirmedInvoiced: "Order confirmed and invoiced",
  confirmedOnly: "Order confirmed",
  confirmMissing: "Order created, but it couldn't be confirmed. Open it to confirm.",
  mergedConfirmMissing: "Order merged, but it couldn't be confirmed. Open it to confirm.",
  invoiceMissing:
    "Order confirmed, but the invoice wasn't created. Open it and choose Create invoice.",
  mergeTitle: "This customer already has an open counter order",
  mergeDescription: "Add these items to it, or start a new order?",
  mergeAdd: "Add to it",
  mergeNew: "Start a new one",
  cutAfterHandOver:
    "Cutting items after hand-over doesn't put them back on the shelf. If the goods came back, record a return.",
  stepConfirmed: "Confirmed",
  stepInvoiceDraft: "Invoice (draft)",
  stepInvoice: "Invoice",
  stepHandedOver: "Handed over",
  readyForPickup: "Ready for pickup",
  createInvoice: "Create invoice",
  handOver: "Hand over",
  recordPayment: "Record payment",
  printInvoice: "Print invoice",
  invoiceCreated: "Invoice created",
  switchToDelivery: "Switch to delivery",
  invoiceFailed: "Couldn't create the invoice. Try again.",
} as const;
