import type {
  ReceiptBranding,
  ReceiptInvoiceInput,
  ReceiptOrderInput,
  ReceiptPaymentInput,
} from "./receipt-model";

/** Placeholders only (acme-style): no live client name, address or number anywhere in these fixtures. */
export const BRANDING: ReceiptBranding = {
  businessName: "Acme Test Store",
  street: "1 Main St",
  city: "Springfield",
  state: "IL",
  zip: "62701",
  phone: "555-0100",
  footer: null,
};

/** A counter sale: 3 x $2.50 (7.50) + 1 box and 3 pcs of a 12-pack at $12.00 a box (15.00) + a $4.00 line = 26.50, tax 2.12. */
export function orderFixture(over: Partial<ReceiptOrderInput> = {}): ReceiptOrderInput {
  return {
    id: "ord-1",
    orderNumber: "ORD-1001",
    status: "DELIVERED",
    total: "28.62",
    tax: "2.12",
    createdAt: new Date("2026-10-07T15:15:00.000Z"),
    orderDate: null,
    counterSale: true,
    counterCashTendered: null,
    customer: { businessName: "Acme Test Customer", isWalkIn: false },
    lineItems: [
      {
        id: "li-1",
        name: null,
        status: "DELIVERED",
        qty: "3",
        unitPrice: "2.50",
        unitsPerBox: null,
        boxes: null,
        pieces: null,
        product: { name: "Cola", variantName: null, parentProductId: null, parent: null },
      },
      {
        id: "li-2",
        name: null,
        status: "DELIVERED",
        qty: "15",
        unitPrice: "12.00",
        unitsPerBox: 12,
        boxes: 1,
        pieces: 3,
        product: { name: "Chips", variantName: null, parentProductId: null, parent: null },
      },
      {
        id: "li-3",
        name: "Loose candy",
        status: "DELIVERED",
        qty: "1",
        unitPrice: "4.00",
        unitsPerBox: null,
        boxes: null,
        pieces: null,
        product: null,
      },
      {
        id: "li-4",
        name: "Cancelled item",
        status: "CANCELLED",
        qty: "9",
        unitPrice: "99.00",
        unitsPerBox: null,
        boxes: null,
        pieces: null,
        product: null,
      },
    ],
    ...over,
  };
}

/** The stored invoice (line rates only: a missing categoryTaxAmount reads as 0): every line carries the 8% rate that reproduces the order's $2.12 over the $26.50 lines. */
export const INVOICE: ReceiptInvoiceInput = {
  id: "inv-1",
  invoiceNumber: "INV-2001",
  status: "PAID",
  subtotal: "26.50",
  taxAmount: "2.12",
  items: [{ taxRate: "0.0800" }, { taxRate: "0.0800" }, { taxRate: "0.0800" }],
};

export function paymentsFixture(over: ReceiptPaymentInput[] = []): ReceiptPaymentInput[] {
  return over.length
    ? over
    : [
        { invoiceId: "inv-1", method: "CASH", amount: "20.00", status: "PAID" },
        { invoiceId: "inv-1", method: "CREDIT_CARD", amount: "8.62", status: "PAID" },
      ];
}
