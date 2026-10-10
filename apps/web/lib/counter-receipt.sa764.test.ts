import { adjustmentLabel, receiptModelFromOrder } from "./counter-receipt";

const reprint = (
  total: number,
  facts: { cashTendered?: number | null; taxRatePercent?: number | null },
  methods: Array<{ method: "CASH" | "CARD"; amount: number }>,
) =>
  receiptModelFromOrder({
    order: {
      orderNumber: "ORD-1",
      total,
      lineItems: [{ id: "l1", name: "Cola", qty: 4, unitPrice: 10 }],
    },
    sale: {
      invoiceId: "i1",
      invoiceNumber: "INV-1",
      paid: total,
      balanceDue: 0,
      methods,
      createdAt: "2026-10-07T15:15:00.000Z",
      ...facts,
    },
    profile: null,
  });

describe("SA-764 reprint: Tendered / Change and Tax (r%)", () => {
  it("a cash sale tendering $50 on $43.30 prints Tendered $50.00 and Change $6.70", () => {
    const m = reprint(43.3, { cashTendered: 50 }, [{ method: "CASH", amount: 43.3 }]);
    expect(m.tendered).toBe(50);
    expect(m.change).toBe(6.7);
  });
  it("change is tendered minus the CASH applied, so a split sale's card leg is not change", () => {
    const m = reprint(43.3, { cashTendered: 30 }, [
      { method: "CASH", amount: 20 },
      { method: "CARD", amount: 23.3 },
    ]);
    expect(m.change).toBe(10);
  });
  it("legacy and card sales (null or absent) keep today's behaviour: no Tendered, no Change", () => {
    for (const f of [{}, { cashTendered: null }]) {
      const m = reprint(43.3, f, [{ method: "CARD", amount: 43.3 }]);
      expect(m.tendered).toBeNull();
      expect(m.change).toBeNull();
    }
  });
  it("names the rate when one stored rate explains the adjustment", () => {
    const m = reprint(43.3, { taxRatePercent: 8.25 }, [{ method: "CARD", amount: 43.3 }]);
    expect(m.taxRatePercent).toBe(8.25);
    expect(adjustmentLabel(m.taxRatePercent)).toBe("Tax (8.25%)");
  });
  it("keeps 'Tax and adjustments' for a null rate, or a rate that does not explain the adjustment", () => {
    expect(adjustmentLabel(null)).toBe("Tax and adjustments");
    expect(reprint(43.3, { taxRatePercent: null }, []).taxRatePercent).toBeNull();
    expect(reprint(45, { taxRatePercent: 8.25 }, []).taxRatePercent).toBeNull();
  });
  it("prints a whole-number rate without trailing zeros", () => {
    expect(adjustmentLabel(8)).toBe("Tax (8%)");
  });
});
