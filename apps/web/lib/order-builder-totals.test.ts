import { orderBuilderTotals } from "./order-builder-totals";

/** W-882: the order builder's total is saleTotals' figure to the cent, not inline subtotal * rate. */
const plain = (unitPrice: number, qty = 1) => ({ unitPrice, qty });

describe("orderBuilderTotals", () => {
  it("$10.00 at 8.25% totals 10.83 (the inline math gave 10.825)", () => {
    const t = orderBuilderTotals([plain(10)], { taxRatePct: 8.25 });
    expect(t.tax).toBe(0.83);
    expect(t.total).toBe(10.83);
  });

  it("$1.00 at 7.5% taxes 0.08 (the inline math gave 0.07)", () => {
    expect(orderBuilderTotals([plain(1)], { taxRatePct: 7.5 }).tax).toBe(0.08);
  });

  it("a tax-exempt customer owes no tax", () => {
    const t = orderBuilderTotals([plain(10)], { taxRatePct: 8.25, isTaxExempt: true });
    expect(t.tax).toBe(0);
    expect(t.total).toBe(10);
  });

  it("a boxed line prices boxes + prorated pieces, never qty * box price", () => {
    const t = orderBuilderTotals([
      { unitPrice: 24, qty: 30, boxes: 1, pieces: 6, unitsPerBox: 24 },
    ]);
    expect(t.subtotal).toBe(30);
  });

  it("a per-unit regulated levy is in the total and a named charge row", () => {
    const cats = new Map([
      ["c1", { id: "c1", name: "CRV deposit", taxType: "EXCISE_PER_UNIT", rate: "0.05" }],
    ]);
    const t = orderBuilderTotals([{ unitPrice: 2, qty: 10, trackedCategoryId: "c1" }], {
      categoryById: cats,
    });
    expect(t.charges).toBe(0.5);
    expect(t.total).toBe(20.5);
    expect(t.chargeLines).toEqual([expect.objectContaining({ amount: 0.5 })]);
    expect(t.chargeLines[0].label).toMatch(/CRV deposit/);
  });

  it("an exempt customer owes no levy either", () => {
    const cats = new Map([
      ["c1", { id: "c1", name: "CRV deposit", taxType: "EXCISE_PER_UNIT", rate: "0.05" }],
    ]);
    const t = orderBuilderTotals([{ unitPrice: 2, qty: 10, trackedCategoryId: "c1" }], {
      categoryById: cats,
      isTaxExempt: true,
    });
    expect(t.charges).toBe(0);
    expect(t.chargeLines).toEqual([]);
  });

  it("discount and shipping move the total", () => {
    const t = orderBuilderTotals([plain(100)], { discount: 5, shipping: 7.5 });
    expect(t.total).toBe(102.5);
  });

  it("an order discount is taken to the cent like the server: 1.005 -> 1.01, total 8.99 (unrounded gave 9.00)", () => {
    const t = orderBuilderTotals([plain(10)], { discount: 1.005 });
    expect(t.discount).toBe(1.01);
    expect(t.total).toBe(8.99);
  });
});
