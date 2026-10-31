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
    expect(BACKORDER_HINT).toBe("Available when stock arrives");
  });
});

/** apple-ux r5 N06: the tag says why: how much of the line WAS in stock when it was sold (sold qty - backordered). */
describe("backorderTagText with the sold quantity (N06)", () => {
  const cases = { boxes: 2, unitsPerBox: 12, unitLabel: "Case" };
  it("nothing in stock when the whole line is backordered", () => {
    expect(backorderTagText(24, cases, 24)).toBe("Backorder · 2 cases (0 in stock when ordered)");
  });
  it("names what was in stock, in the line's own unit, when only part is short", () => {
    expect(backorderTagText(12, cases, 24)).toBe(
      "Backorder · 1 case (1 case in stock when ordered)",
    );
    expect(backorderTagText(30, { ...cases, boxes: 3 }, 36)).toBe(
      "Backorder · 2 cases + 6 pcs (6 pcs in stock when ordered)",
    );
    expect(backorderTagText(2, undefined, 8)).toBe(
      "Backorder · 2 pcs (6 pcs in stock when ordered)",
    );
  });
  it("never goes negative, and says nothing extra when the sold quantity is unknown", () => {
    expect(backorderTagText(5, undefined, 3)).toBe("Backorder · 5 pcs (0 in stock when ordered)");
    expect(backorderTagText(5)).toBe("Backorder · 5 pcs");
    expect(backorderTagText(5, undefined, Number.NaN)).toBe("Backorder · 5 pcs");
  });
});
