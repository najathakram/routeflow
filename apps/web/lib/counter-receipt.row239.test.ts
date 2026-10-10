import { receiptCustomerName, receiptModelFromOrder } from "./counter-receipt";

/**
 * Row 239 (POS trial): ONE walk-in rule for the receipt's customer name (live and reprint), and a reprint keeps the line
 * notes the live receipt showed. The money-line model (tax / adjustments / taxRatePercent) is covered by the SA-762r specs.
 */
describe("receiptCustomerName", () => {
  it("prints a named customer, trimmed", () => {
    expect(receiptCustomerName({ businessName: " Acme Market ", isWalkIn: false })).toBe(
      "Acme Market",
    );
  });
  it("prints nothing for no customer or a blank name", () => {
    expect(receiptCustomerName(null)).toBeNull();
    expect(receiptCustomerName(undefined)).toBeNull();
    expect(receiptCustomerName({ businessName: "  " })).toBeNull();
  });
  it("prints nothing when the clerk picked the system walk-in customer", () => {
    expect(receiptCustomerName({ businessName: "Walk-in customer", isWalkIn: true })).toBeNull();
  });
});

describe("a reprint keeps what the order stored", () => {
  const reprint = () =>
    receiptModelFromOrder({
      order: {
        orderNumber: "ORD-1",
        total: 6,
        lineItems: [
          { id: "l1", name: "Cola", qty: 2, unitPrice: 2.5, notes: " extra cold " },
          { id: "l2", name: "Water", qty: 1, unitPrice: 1, notes: null },
        ],
      } as never,
      sale: {
        invoiceId: "i1",
        invoiceNumber: "INV-1",
        paid: 6,
        balanceDue: 0,
        methods: [{ method: "CASH", amount: 6 }],
        createdAt: new Date("2026-10-07T15:30:00Z"),
        timezone: "UTC",
      } as never,
      profile: { taxRate: 8.25 },
    });

  it("keeps each line's note", () => {
    const m = reprint();
    expect(m.lines[0]!.note).toBe("extra cold");
    expect(m.lines[1]!.note).toBeNull();
  });
});
