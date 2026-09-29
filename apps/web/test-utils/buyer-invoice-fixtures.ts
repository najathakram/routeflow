import type { BuyerInvoiceItem, BuyerInvoicePayment } from "@routeflow/types";

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
