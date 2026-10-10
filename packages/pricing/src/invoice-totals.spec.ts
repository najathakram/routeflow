import { computeInvoiceLineTotal, computeInvoiceTotals } from "./invoice-totals";

describe("computeInvoiceTotals — boxed lines", () => {
  it("1 box of 24 @ $12.90 totals $12.90, never $309.60", () => {
    const t = computeInvoiceTotals([
      { unitPrice: 12.9, qty: 24, boxes: 1, pieces: 0, unitsPerBox: 24 },
    ]);
    expect(t.lineTotals).toEqual([12.9]);
    expect(t.subtotal).toBe(12.9);
    expect(t.total).toBe(12.9);
  });

  it("mixed boxes + pieces prorate the loose pieces: 2 boxes + 6 of 24 @ $12.90 = $29.03", () => {
    // 2.25 boxes x 12.90 = 29.025 -> half away from zero
    expect(
      computeInvoiceLineTotal({ unitPrice: 12.9, qty: 54, boxes: 2, pieces: 6, unitsPerBox: 24 }),
    ).toBe(29.03);
  });

  it("a non-boxed line is qty x unitPrice (callers that never split stay unchanged)", () => {
    expect(computeInvoiceLineTotal({ unitPrice: 2.5, qty: 3 })).toBe(7.5);
  });

  it("BUY_N_GET_M free units come off whole selling units before pricing", () => {
    expect(
      computeInvoiceLineTotal({
        unitPrice: 10,
        qty: 120,
        boxes: 12,
        pieces: 0,
        unitsPerBox: 10,
        freeUnits: 2,
      }),
    ).toBe(100);
  });
});

describe("computeInvoiceTotals — rounding", () => {
  it("rounds the sum of lines: 0.10 + 0.20 is 0.30, not 0.30000000000000004", () => {
    const t = computeInvoiceTotals([
      { unitPrice: 0.1, qty: 1 },
      { unitPrice: 0.2, qty: 1 },
    ]);
    expect(t.subtotal).toBe(0.3);
    expect(t.total).toBe(0.3);
  });

  it("rounds a half-cent line away from zero ($12.90 x 2.25 boxes = 29.025)", () => {
    const t = computeInvoiceTotals([
      { unitPrice: 12.9, qty: 54, boxes: 2, pieces: 6, unitsPerBox: 24 },
    ]);
    expect(t.subtotal).toBe(29.03);
  });

  it("rounds a half-cent tax away from zero ($29.00 x 7.5% = 2.175 -> 2.18)", () => {
    const t = computeInvoiceTotals([{ unitPrice: 29, qty: 1 }], { taxRate: 0.075 });
    expect(t.tax).toBe(2.18);
    expect(t.total).toBe(31.18);
  });

  it("rounds tax ONCE over the invoice, like the server (two $1.10 lines @ 5% = 0.11, not 0.12)", () => {
    const t = computeInvoiceTotals(
      [
        { unitPrice: 1.1, qty: 1 },
        { unitPrice: 1.1, qty: 1 },
      ],
      { taxRate: 0.05 },
    );
    expect(t.tax).toBe(0.11);
    expect(t.total).toBe(2.31);
  });
});

describe("computeInvoiceTotals — discount, shipping, tax", () => {
  it("applies a line discount after boxed proration, then invoice discount and shipping", () => {
    const t = computeInvoiceTotals(
      [
        { unitPrice: 12.9, qty: 24, boxes: 1, pieces: 0, unitsPerBox: 24, discount: 2.9 },
        { unitPrice: 5, qty: 4 },
      ],
      { discount: 1.5, shipping: 4 },
    );
    expect(t.lineTotals).toEqual([10, 20]);
    expect(t.subtotal).toBe(30);
    expect(t.discount).toBe(1.5);
    expect(t.shipping).toBe(4);
    expect(t.total).toBe(32.5);
  });

  it("taxes the post-discount line totals, honouring taxable:false and a per-line taxRate", () => {
    const t = computeInvoiceTotals(
      [
        { unitPrice: 100, qty: 1 }, // taxed at the invoice rate
        { unitPrice: 100, qty: 1, taxable: false }, // exempt
        { unitPrice: 100, qty: 1, taxRate: 0.1 }, // own rate wins
        { unitPrice: 100, qty: 1, discount: 20 }, // 80 taxed
      ],
      { taxRate: 0.05 },
    );
    expect(t.subtotal).toBe(380);
    expect(t.tax).toBe(5 + 0 + 10 + 4);
    expect(t.total).toBe(399);
  });

  it("a line discount above its line is NOT floored: 1 x $5 less $50, plus 1 x $100, stores $55.00", () => {
    // The server stores roundMoney(before - discount) per line and sums them; it never floors.
    const t = computeInvoiceTotals([
      { unitPrice: 5, qty: 1, discount: 50 },
      { unitPrice: 100, qty: 1 },
    ]);
    expect(t.lineTotals).toEqual([-45, 100]);
    expect(t.subtotal).toBe(55);
    expect(t.total).toBe(55);
  });

  it("a lone over-discounted line is negative, exactly as the server computes it", () => {
    const t = computeInvoiceTotals([{ unitPrice: 5, qty: 1, discount: 50 }]);
    expect(t.lineTotals).toEqual([-45]);
    expect(t.total).toBe(-45);
  });

  it("an empty invoice is all zeros; non-finite inputs are treated as 0", () => {
    expect(computeInvoiceTotals([])).toEqual({
      lineTotals: [],
      subtotal: 0,
      tax: 0,
      regularTax: 0,
      categoryTax: 0,
      discount: 0,
      shipping: 0,
      total: 0,
    });
    const t = computeInvoiceTotals([{ unitPrice: Number.NaN, qty: 3 }], {
      discount: Number.NaN,
      taxRate: Number.NaN,
    });
    expect(t.total).toBe(0);
  });

  it("the total is rounded as a whole (no float drift from subtotal - discount + shipping + tax)", () => {
    const t = computeInvoiceTotals([{ unitPrice: 0.3, qty: 1 }], { discount: 0.1, shipping: 0.2 });
    expect(t.total).toBe(0.4);
  });
});
