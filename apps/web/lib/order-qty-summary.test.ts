import { summarizeQtyByUnit } from "./order-qty-summary";

// F03 / F19: "Total quantity 42" added 3 cases and 6 bottles into one unitless number.
describe("summarizeQtyByUnit", () => {
  it("3 cases (36 pcs stored) + 6 bottles reads per unit, never 42", () => {
    const text = summarizeQtyByUnit([
      { qty: 36, boxes: 3, pieces: 0 },
      { qty: 6, product: { unit: "bottle" } },
    ]);
    expect(text).toBe("3 boxes + 6 bottles");
  });
  it("loose pieces merge with plain each-lines under the piece word", () => {
    expect(
      summarizeQtyByUnit([
        { qty: 16, boxes: 1, pieces: 4 },
        { qty: 2, product: { unit: "each" } },
      ]),
    ).toBe("1 box + 6 pcs");
  });
  it("one unit alone, and the empty order", () => {
    expect(summarizeQtyByUnit([{ qty: 1, product: { unit: "case" } }])).toBe("1 case");
    expect(summarizeQtyByUnit([])).toBe("0");
  });
  it("a named unit line (Pallet) keeps its own label", () => {
    expect(summarizeQtyByUnit([{ qty: 2, unitLabel: "Pallet" }])).toBe("2 Pallets");
  });
});
