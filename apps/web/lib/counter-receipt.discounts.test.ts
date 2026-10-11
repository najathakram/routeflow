import { buildCounterReceipt, receiptModelFromOrder } from "./counter-receipt";

/**
 * One presentation of a lowered price: the live receipt (the cart's tier price) and the reprint (the order line's stored
 * `originalPrice`) both show the struck list price and a Discounts row, from pricing's receiptLineAmounts.
 */
const reprint = (
  lines: Array<Record<string, unknown>>,
  total: number,
  tax: number,
  profile: { hideOriginalPrice?: boolean } | null = null,
) =>
  receiptModelFromOrder({
    order: {
      orderNumber: "ORD-1",
      total,
      tax,
      lineItems: lines.map((l, i) => ({ id: `l${i}`, name: `L${i}`, qty: 1, unitPrice: 1, ...l })),
    },
    sale: {
      invoiceId: "i1",
      invoiceNumber: "INV-1",
      paid: total,
      balanceDue: 0,
      methods: [{ method: "CASH", amount: total }],
      createdAt: "2026-10-07T15:15:00.000Z",
    },
    profile,
  });

describe("reprint: a lowered price is struck and summed into Discounts (like the live receipt)", () => {
  it("the proof sale: Each 1 x 2.50 and Pc 2 x 10.00 off a 14.99 list -> Subtotal 32.48, Discounts 9.98, struck 29.98", () => {
    const m = reprint(
      [
        { name: "Each", qty: 1, unitPrice: 2.5 },
        { name: "Pc", qty: 2, unitPrice: "10.00", originalPrice: "14.99" },
      ],
      24.36,
      1.86,
    );
    expect(m.subtotal).toBe(32.48);
    expect(m.discounts).toBe(9.98);
    expect(m.lines[1]).toMatchObject({ total: 20, original: 29.98, discount: 9.98 });
    expect(m.lines[0]).toMatchObject({ original: null, discount: 0 });
    expect(m.tax).toBe(1.86);
    expect(m.adjustments).toBe(0);
    expect(m.total).toBe(24.36);
  });

  it("the live receipt builds the same sale to the same figures", () => {
    const live = buildCounterReceipt({
      receipt: {
        orderId: "o1",
        orderNumber: "ORD-1",
        invoiceId: "i1",
        invoiceNumber: "INV-1",
        total: 24.36,
        paid: 24.36,
        balanceDue: 0,
        tax: 1.86,
        taxRatePercent: null,
        method: "CARD",
        paymentRecorded: true,
        // the stored lines the response serves: the Pc line was rung at 10.00 off the 14.99 LIST price
        lines: [
          { productId: "pa", unitPrice: 2.5, originalPrice: null, priceType: "STANDARD" },
          { productId: "pb", unitPrice: 10, originalPrice: 14.99, priceType: "DISCOUNTED" },
        ],
      },
      lines: [
        { tempId: "a", productId: "pa", name: "Each", unitPrice: 2.5, qty: 1 },
        { tempId: "b", productId: "pb", name: "Pc", unitPrice: 10, qty: 2 },
      ],
      enteredTender: null,
      profile: null,
      now: new Date("2026-10-07T15:15:00.000Z"),
    });
    expect(live.subtotal).toBe(32.48);
    expect(live.discounts).toBe(9.98);
    expect(live.lines[1]).toMatchObject({ original: 29.98, discount: 9.98 });
  });

  it("the tenant's hideOriginalPrice (the invoices' setting): net lines only, no struck price and no Discounts, reprint and live", () => {
    const hidden = reprint(
      [
        { name: "Each", qty: 1, unitPrice: 2.5 },
        { name: "Pc", qty: 2, unitPrice: "10.00", originalPrice: "14.99", priceType: "DISCOUNTED" },
      ],
      24.36,
      1.86,
      { hideOriginalPrice: true },
    );
    expect(hidden).toMatchObject({ subtotal: 22.5, discounts: 0, tax: 1.86, total: 24.36 });
    expect(hidden.lines.every((l) => l.original === null && l.discount === 0)).toBe(true);
    const live = buildCounterReceipt({
      receipt: {
        orderId: "o1",
        orderNumber: "ORD-1",
        invoiceId: "i1",
        invoiceNumber: "INV-1",
        total: 24.36,
        paid: 24.36,
        balanceDue: 0,
        tax: 1.86,
        taxRatePercent: null,
        method: "CARD",
        paymentRecorded: true,
        lines: [
          { productId: "pa", unitPrice: 2.5, originalPrice: null, priceType: "STANDARD" },
          { productId: "pb", unitPrice: 10, originalPrice: 14.99, priceType: "DISCOUNTED" },
        ],
      },
      lines: [
        { tempId: "a", productId: "pa", name: "Each", unitPrice: 2.5, qty: 1 },
        { tempId: "b", productId: "pb", name: "Pc", unitPrice: 10, qty: 2 },
      ],
      enteredTender: null,
      profile: { hideOriginalPrice: true },
      now: new Date("2026-10-07T15:15:00.000Z"),
    });
    expect(live).toMatchObject({ subtotal: 22.5, discounts: 0, total: 24.36 });
    expect(live.lines.every((l) => l.original === null && l.discount === 0)).toBe(true);
  });

  it("a list price at or below the charge (or none) prints plain", () => {
    const m = reprint(
      [
        { name: "A", qty: 1, unitPrice: 5, originalPrice: 5 },
        { name: "B", qty: 2, unitPrice: 6, originalPrice: "4.00" },
        { name: "C", qty: 1, unitPrice: 3, originalPrice: null },
      ],
      23,
      0,
    );
    expect(m.discounts).toBe(0);
    expect(m.subtotal).toBe(20);
    expect(m.lines.every((l) => l.original === null)).toBe(true);
  });
});
