import { backorderTagText, BACKORDER_HINT } from "./backorder-tag-text";

/** R3 Q17 / F14 / L-332: the shortfall is read in the unit the line was sold in. */
describe("backorderTagText", () => {
  it("a case line states cases, never the pieces behind them", () => {
    expect(backorderTagText(24, { boxes: 2, unitsPerBox: 12, unitLabel: "Case" })).toBe(
      "Backorder · 2 cases",
    );
    expect(backorderTagText(12, { boxes: 2, unitsPerBox: 12, unitLabel: "Case" })).toBe(
      "Backorder · 1 case",
    );
  });
  it("a pack line (no unit label) states the pack word, as the Qty cell does", () => {
    expect(backorderTagText(48, { boxes: 4, unitsPerBox: 12, unitLabel: null })).toBe(
      "Backorder · 4 boxes",
    );
  });
  it("a shortfall that is not a whole number of cases keeps the loose pieces", () => {
    expect(backorderTagText(30, { boxes: 3, unitsPerBox: 12, unitLabel: "Case" })).toBe(
      "Backorder · 2 cases + 6 pcs",
    );
    expect(backorderTagText(5, { boxes: 3, unitsPerBox: 12, unitLabel: "Case" })).toBe(
      "Backorder · 5 pcs",
    );
  });
  it("a line sold in loose pieces, or with no unit facts, reads in pieces", () => {
    expect(backorderTagText(3, { boxes: 0, unitsPerBox: 12 })).toBe("Backorder · 3 pcs");
    expect(backorderTagText(3, { boxes: null, unitsPerBox: null })).toBe("Backorder · 3 pcs");
    expect(backorderTagText(1)).toBe("Backorder · 1 pc");
    expect(backorderTagText(3)).toBe("Backorder · 3 pcs");
  });
  it("says what the tag means, as a separate visible sentence", () => {
    expect(BACKORDER_HINT).toBe("Ships when stock arrives");
  });
});
