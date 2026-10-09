import { buildCounterReceipt, receiptModelFromOrder } from "./counter-receipt";

/**
 * Row 239 (POS trial): the receipt names the tax rate, prints the customer when there is one, and a reprint keeps the
 * line notes the live receipt showed. (Tendered/Change on a reprint needs the API's cash-tendered fact, not built here.)
 */
const NOW = new Date("2026-10-07T15:30:00Z");
const LINE = { tempId: "a", name: "Cola", unitPrice: 2.5, qty: 2 };
const sale = (over: Record<string, unknown> = {}) => ({
  orderId: "o1",
  orderNumber: "ORD-1",
  invoiceId: "i1",
  invoiceNumber: "INV-1",
  total: 5.41,
  paid: 5.41,
  balanceDue: 0,
  paymentRecorded: true,
  method: "CASH" as const,
  ...over,
});
const live = (
  extra: Record<string, unknown> = {},
  profile: Record<string, unknown> | null = null,
) =>
  buildCounterReceipt({
    receipt: sale() as never,
    lines: [LINE],
    enteredTender: null,
    profile,
    now: NOW,
    ...extra,
  });

describe("tax rate on the receipt", () => {
  it("carries the rate from the business profile, 8.25 as given", () => {
    expect(live({}, { taxRate: 8.25 }).taxRate).toBe(8.25);
  });
  it("is null when the adjustment is not exactly tax on the subtotal (category tax, a reprice)", () => {
    // 2 x 2.50 = 5.00; 8.25% = 0.41, so 5.41 is pure tax; 5.60 carries 0.19 of something else
    expect(live({ receipt: sale({ total: 5.41 }) }, { taxRate: 8.25 }).taxRate).toBe(8.25);
    expect(live({ receipt: sale({ total: 5.6 }) }, { taxRate: 8.25 }).taxRate).toBeNull();
  });
  it("is null when the business charges no tax or the rate is unknown", () => {
    expect(live({}, { taxRate: 0 }).taxRate).toBeNull();
    expect(live({}, null).taxRate).toBeNull();
  });
});

describe("customer name on the receipt", () => {
  it("prints a named customer", () => {
    expect(live({ customerName: " Acme Market " }).customerName).toBe("Acme Market");
  });
  it("prints nothing for a walk-in (no name given)", () => {
    expect(live().customerName).toBeNull();
    expect(live({ customerName: "  " }).customerName).toBeNull();
  });
});

describe("a reprint keeps what the order stored", () => {
  const order = (over: Record<string, unknown> = {}) => ({
    orderNumber: "ORD-1",
    total: 5.41,
    customer: { businessName: "Acme Market", isWalkIn: false },
    lineItems: [
      { id: "l1", name: "Cola", qty: 2, unitPrice: 2.5, notes: " extra cold " },
      { id: "l2", name: "Water", qty: 1, unitPrice: 1, notes: null },
    ],
    ...over,
  });
  const reprint = (o = order(), profile: Record<string, unknown> | null = { taxRate: 8.25 }) =>
    receiptModelFromOrder({
      order: o as never,
      sale: {
        invoiceId: "i1",
        invoiceNumber: "INV-1",
        paid: 5.41,
        balanceDue: 0,
        methods: [{ method: "CASH", amount: 5.41 }],
        createdAt: NOW,
        timezone: "UTC",
      } as never,
      profile,
    });

  it("keeps each line's note", () => {
    const m = reprint();
    expect(m.lines[0]!.note).toBe("extra cold");
    expect(m.lines[1]!.note).toBeNull();
  });
  it("names a real customer, and nobody for the walk-in", () => {
    expect(reprint().customerName).toBe("Acme Market");
    expect(
      reprint(order({ customer: { businessName: "Walk-in customer", isWalkIn: true } }))
        .customerName,
    ).toBeNull();
  });
  it("never labels a rate: the stored order read carries no invoice-item rate snapshot, and today's setting is not the sale's", () => {
    expect(reprint().taxRate).toBeNull();
  });
});
