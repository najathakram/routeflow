import type { BuyerOrderLine, BuyerOrderListItem } from "@routeflow/types";

/** B1130: full-shape buyer order list row / line fixtures. The shared types are server truth
 *  (GET /buyer/orders returns `lineItems`, never an `itemCount`), so every field is present and
 *  a renamed or invented field fails type-check; tests pass only the fields they care about. */
export function orderLine(over: Partial<BuyerOrderLine> = {}): BuyerOrderLine {
  return {
    id: "line-1",
    productId: "p1",
    name: null,
    qty: 1,
    unitPrice: 10,
    subtotal: 10,
    priceType: "STANDARD",
    originalPrice: null,
    status: "PENDING",
    deliveredQty: 0,
    boxes: null,
    pieces: null,
    promoFreeUnits: null,
    categoryTaxAmount: 0,
    unitLabel: null,
    notes: null,
    product: { id: "p1", name: "Widget", unit: "ea" },
    ...over,
  };
}

export function orderListItem(over: Partial<BuyerOrderListItem> = {}): BuyerOrderListItem {
  return {
    id: "ord-1",
    orderNumber: "ORD-00001",
    status: "PENDING",
    createdAt: "2026-09-10T12:00:00Z",
    requestedDeliveryDate: null,
    deliveredAt: null,
    notes: null,
    urgent: false,
    subtotal: 10,
    tax: 0,
    total: 10,
    discountAmount: 0,
    customer: { id: "c-1", businessName: "Sample Buyer Co" },
    lineItems: [orderLine()],
    ...over,
  };
}
