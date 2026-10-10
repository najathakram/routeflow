import type { BuyerInvoiceItem, BuyerInvoiceListItem, BuyerInvoicePayment } from "@routeflow/types";

/** #2703: full-shape buyer invoice line / payment fixtures (the shared types are server truth, so
 *  every field is present); tests pass only the fields they care about. */
export function invoiceItem(over: Partial<BuyerInvoiceItem> = {}): BuyerInvoiceItem {
  return {
    id: "item-1",
    description: "Widget",
    productId: "p1",
    qty: 1,
    unitPrice: 10,
    discount: 0,
    originalPrice: null,
    msrp: null,
    priceType: "STANDARD",
    subtotal: 10,
    unitLabel: null,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    promoFreeUnits: null,
    notes: null,
    categoryTaxAmount: 0,
    product: null,
    trackedCategory: null,
    trackedSubcategory: null,
    ...over,
  };
}

export function invoicePayment(over: Partial<BuyerInvoicePayment> = {}): BuyerInvoicePayment {
  return {
    id: "pay-1",
    amount: 0,
    method: "CASH",
    reference: null,
    notes: null,
    paidAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "PAID",
    checkStatus: null,
    nsfFeeAmount: null,
    creditNote: null,
    ...over,
  };
}

/** B1122: a full-shape row of GET /buyer/invoices (InvoicesService.findAll) — the money is `total`
 *  and the server-derived `balanceDue`; there is no `totalAmount`, `amount` or `balance`. */
export function invoiceListItem(over: Partial<BuyerInvoiceListItem> = {}): BuyerInvoiceListItem {
  return {
    id: "inv-1",
    invoiceNumber: "INV-0001",
    status: "SENT",
    issueDate: "2026-09-10T12:00:00.000Z",
    createdAt: "2026-09-10T12:00:00.000Z",
    dueDate: "2026-10-10T00:00:00.000Z",
    subtotal: 100,
    taxAmount: 0,
    total: 100,
    balanceDue: 100,
    paidAmount: 0,
    creditApplied: 0,
    advanceApplied: 0,
    isOverdue: false,
    customer: { id: "c-1", businessName: "Sample Buyer Co" },
    ...over,
  };
}
