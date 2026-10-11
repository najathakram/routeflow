import { adjustmentLabel, receiptModelFromOrder } from "./counter-receipt";

const reprint = (
  total: number,
  facts: { cashTendered?: number | null; change?: number | null; taxRatePercent?: number | null },
  methods: Array<{ method: "CASH" | "CARD" | "STORE_CREDIT"; amount: number }>,
  tax?: number,
) =>
  receiptModelFromOrder({
    order: {
      orderNumber: "ORD-1",
      total,
      tax,
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
    const m = reprint(43.3, { cashTendered: 50, change: 6.7 }, [{ method: "CASH", amount: 43.3 }]);
    expect(m.tendered).toBe(50);
    expect(m.change).toBe(6.7);
  });
  it("the change is the SERVER's figure: with Tendered but no served change, none is invented from the methods", () => {
    const m = reprint(43.3, { cashTendered: 50, change: null }, [{ method: "CASH", amount: 43.3 }]);
    expect(m.tendered).toBe(50);
    expect(m.change).toBeNull();
    expect(
      reprint(43.3, { cashTendered: 50 }, [{ method: "CASH", amount: 43.3 }]).change,
    ).toBeNull();
  });
  it("a split sale reprints the amount applied per method (card first) and no Tendered / Change line, though the row serves them (G7)", () => {
    const m = reprint(43.3, { cashTendered: 30, change: 10 }, [
      { method: "CASH", amount: 20 },
      { method: "CARD", amount: 23.3 },
    ]);
    expect(m.tendered).toBeNull();
    expect(m.change).toBeNull();
    expect(m.tenderLines.map((t) => [t.label, t.amount])).toEqual([
      ["Card", 23.3],
      ["Cash", 20],
    ]);
  });
  it("cash plus store credit is not a split: it keeps the one-method reprint and its change", () => {
    const m = reprint(43.3, { cashTendered: 30, change: 10 }, [
      { method: "CASH", amount: 20 },
      { method: "STORE_CREDIT", amount: 23.3 },
    ]);
    expect(m.tenderLines).toEqual([]);
    expect(m.change).toBe(10);
  });
  it("no row change means no Change line, even with a tender (never a computed or clamped 0)", () => {
    const m = reprint(43.3, { cashTendered: 43.3, change: null }, [
      { method: "CASH", amount: 43.3 },
    ]);
    expect(m.tendered).toBe(43.3);
    expect(m.change).toBeNull();
  });
  it("legacy and card sales (null or absent) keep today's behaviour: no Tendered, no Change", () => {
    for (const f of [{}, { cashTendered: null }]) {
      const m = reprint(43.3, f, [{ method: "CARD", amount: 43.3 }]);
      expect(m.tendered).toBeNull();
      expect(m.change).toBeNull();
    }
  });
  it("names the rate when one stored rate explains the order's tax", () => {
    const m = reprint(43.3, { taxRatePercent: 8.25 }, [{ method: "CARD", amount: 43.3 }], 3.3);
    expect(m.tax).toBe(3.3);
    expect(m.adjustments).toBe(0);
    expect(m.taxRatePercent).toBe(8.25);
    expect(adjustmentLabel(m.taxRatePercent)).toBe("Tax (8.25%)");
  });
  it("prints plain 'Tax' for a null rate, or a rate that does not explain the stored tax", () => {
    expect(adjustmentLabel(null)).toBe("Tax");
    expect(reprint(43.3, { taxRatePercent: null }, [], 3.3).taxRatePercent).toBeNull();
    expect(reprint(45, { taxRatePercent: 8.25 }, [], 5).taxRatePercent).toBeNull();
  });
  it("prints a whole-number rate without trailing zeros", () => {
    expect(adjustmentLabel(8)).toBe("Tax (8%)");
  });
});
