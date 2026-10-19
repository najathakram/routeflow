import { billLinesTotal } from "./bill-lines-total";

describe("billLinesTotal", () => {
  it("sums qty x unitCost", () => {
    expect(
      billLinesTotal([
        { qty: 2, unitCost: 5 },
        { qty: 3, unitCost: 1.5 },
      ]),
    ).toBe(14.5);
  });

  it("a missing, null or zero qty is 1", () => {
    expect(
      billLinesTotal([{ unitCost: 4 }, { qty: null, unitCost: 4 }, { qty: 0, unitCost: 4 }]),
    ).toBe(12);
  });

  it("a null or missing unitCost falls back to unitPrice, then 0; a 0 unitCost stays 0", () => {
    expect(billLinesTotal([{ qty: 2, unitCost: null, unitPrice: 20 }])).toBe(40);
    expect(billLinesTotal([{ qty: 2 }])).toBe(0);
    expect(billLinesTotal([{ qty: 2, unitCost: 0, unitPrice: 20 }])).toBe(0);
  });

  it("accepts Decimal-like values and rounds to cents", () => {
    const dec = (n: string) => ({ toString: () => n, valueOf: () => Number(n) });
    expect(billLinesTotal([{ qty: dec("3"), unitCost: dec("1.2345") }])).toBe(3.7);
  });

  it("no lines is 0", () => {
    expect(billLinesTotal([])).toBe(0);
  });
});
