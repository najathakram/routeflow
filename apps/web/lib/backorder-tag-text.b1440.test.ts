import { backorderQtyText, backorderTagText } from "./backorder-tag-text";

/**
 * REG-B1440: the backorder tag said "pcs" on a line sold in the product's own unit ("3 bags" in the order summary,
 * "Backorder · 3 pcs" on the line). A plain line (no pack, no named unit) now counts in the same word the summary
 * prints, through the same shared counter.
 */
describe("REG-B1440: a plain line's backorder tag says the product's own unit", () => {
  it("a line sold in bags: 3 bags, never 3 pcs", () => {
    expect(backorderQtyText(3, { unit: "bag" })).toBe("3 bags");
    expect(backorderTagText(3, { unit: "bag" }, 3)).toBe(
      "Backorder · 3 bags (0 in stock when ordered)",
    );
  });

  it("one bag is singular, and the in-stock part uses the same word", () => {
    expect(backorderQtyText(1, { unit: "bag" })).toBe("1 bag");
    expect(backorderTagText(3, { unit: "Bag" }, 5)).toBe(
      "Backorder · 3 bags (2 bags in stock when ordered)",
    );
  });

  it("a stored pack of 1 or none is still a plain line", () => {
    expect(backorderQtyText(2, { unitsPerBox: 1, unit: "bottle" })).toBe("2 bottles");
    expect(backorderQtyText(4, { unitsPerBox: null, boxes: null, unit: "lb" })).toBe("4 lb");
  });

  it("a generic or missing unit word stays pcs", () => {
    for (const unit of ["each", "unit", "piece", "", null, undefined]) {
      expect(backorderQtyText(3, { unit })).toBe("3 pcs");
      expect(backorderQtyText(1, { unit })).toBe("1 pc");
    }
    expect(backorderQtyText(3)).toBe("3 pcs");
  });
});

describe("REG-B1440 pins: boxed and named-unit lines read as before", () => {
  it("a boxed line never borrows the product's unit (it names the box, not the piece)", () => {
    expect(backorderQtyText(24, { boxes: 2, unitsPerBox: 12, unit: "case" })).toBe("2 boxes");
    expect(backorderQtyText(30, { boxes: 2, unitsPerBox: 12, unit: "case" })).toBe(
      "2 boxes + 6 pcs",
    );
    // less than one whole box short, and a boxed product sold loose
    expect(backorderQtyText(6, { boxes: 1, unitsPerBox: 12, unit: "case" })).toBe("6 pcs");
    expect(backorderQtyText(3, { boxes: 0, unitsPerBox: 12, unit: "case" })).toBe("3 pcs");
  });

  it("a named unit keeps its own word over the product's unit", () => {
    expect(
      backorderQtyText(24, { boxes: 2, unitsPerBox: 12, unitLabel: "Case", unit: "can" }),
    ).toBe("2 cases");
    expect(backorderQtyText(3, { unitsPerBox: 1, unitLabel: "Piece", unit: "bag" })).toBe(
      "3 pieces",
    );
  });
});
