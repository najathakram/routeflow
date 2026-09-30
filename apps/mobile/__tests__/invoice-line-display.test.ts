import { invoiceLineQtyText } from "@routeflow/pricing";
import { invoiceLineUnitNoun, priceUnitSuffix, usesUnitDisplay } from "../lib/invoice-line-display";

/**
 * B653 (mobile piece) + #1275 review round: the operator invoice detail's per-line
 * qty/unit text and display routing. `invoiceLineQtyText` itself is the shared
 * `@routeflow/pricing` formatter now (its own coverage lives in
 * packages/pricing/src/pricing.spec.ts) — these pins prove THIS screen's routing
 * decision (`usesUnitDisplay`) and noun (`invoiceLineUnitNoun`), not the formatter.
 */

describe("usesUnitDisplay", () => {
  it("REG-B653-mobile: routes a factor-1 unit line (no split) through the unit form", () => {
    expect(usesUnitDisplay({ boxes: null, pieces: null, unitLabel: "Piece" })).toBe(true);
  });

  it("REG-B653-mobile: routes a boxed split through the unit form, byte-identical to before", () => {
    expect(usesUnitDisplay({ boxes: 2, pieces: 3, unitLabel: null })).toBe(true);
  });

  it("REG-B653-mobile: a plain non-boxed, non-unit line does NOT route through the unit form", () => {
    expect(usesUnitDisplay({ boxes: null, pieces: null, unitLabel: null })).toBe(false);
    expect(usesUnitDisplay({ boxes: null, pieces: null })).toBe(false);
    expect(usesUnitDisplay({ boxes: null, pieces: null, unitLabel: "  " })).toBe(false);
  });
});

describe("invoiceLineUnitNoun", () => {
  it('REG-B653-mobile: names the units_v1 unit ("Case") for the "@ price/<noun>" suffix', () => {
    expect(invoiceLineUnitNoun({ unitLabel: "Case" })).toBe("Case");
  });

  it('REG-B653-mobile: defaults to "box" for an ordinary boxed line — unchanged from today', () => {
    expect(invoiceLineUnitNoun({ unitLabel: null })).toBe("box");
    expect(invoiceLineUnitNoun({})).toBe("box");
    expect(invoiceLineUnitNoun({ unitLabel: "  " })).toBe("box");
  });
});

describe("priceUnitSuffix (#2055)", () => {
  // RED PIN: this is exactly the defect the review found in edit-items.tsx's own
  // pre-fix ternary (`isBoxed ? " / box of ${upb}" : item.unitLabel ? ...`), where
  // `isBoxed` itself excludes any line carrying a unitLabel — so a genuinely boxed
  // units_v1 line (a real Case of 12) fell to the bare-unitLabel branch and lost the
  // pack size entirely. A naive re-implementation of that same exclusion would fail
  // this exact case.
  it("REG-B757-edit-items: a boxed units_v1 line (Case, upb 12) names BOTH the noun and the pack size", () => {
    expect(priceUnitSuffix({ unitLabel: "Case" }, 12)).toBe(" / Case of 12");
  });

  it("an ordinary boxed line (no unitLabel) still reads the plain 'box' noun, unchanged", () => {
    expect(priceUnitSuffix({}, 12)).toBe(" / box of 12");
    expect(priceUnitSuffix({ unitLabel: null }, 12)).toBe(" / box of 12");
  });

  it("a factor-1 unit line (upb <= 1, unitLabel set) reads its own label with no pack size", () => {
    expect(priceUnitSuffix({ unitLabel: "Piece" }, 0)).toBe(" / Piece");
    expect(priceUnitSuffix({ unitLabel: "Piece" }, 1)).toBe(" / Piece");
  });

  it("a plain non-boxed, non-unit line falls back to the product's own unit noun", () => {
    expect(priceUnitSuffix({ unit: "ea" }, 1)).toBe(" / ea");
  });

  it("a plain non-boxed, non-unit, no-unit-noun line renders nothing", () => {
    expect(priceUnitSuffix({}, 1)).toBe("");
    expect(priceUnitSuffix({}, 0)).toBe("");
  });
});

// Pins: the exact three scenarios named in the #1275 review round.
describe("pins — factor-1 unit, boxed split (byte-identical), plain line", () => {
  it("factor-1 unit line reads '5 Piece', never a bare '5' (review finding: the local copy got this wrong)", () => {
    expect(invoiceLineQtyText({ qty: 5, boxes: null, pieces: null, unitLabel: "Piece" })).toBe(
      "5 Piece",
    );
  });

  it("a boxed split (no unitLabel) is byte-identical to before this change", () => {
    expect(invoiceLineQtyText({ qty: 27, boxes: 2, pieces: 3 })).toBe("2 boxes + 3 pcs");
  });

  it("a plain line (no split, no unitLabel) reads the bare qty", () => {
    expect(invoiceLineQtyText({ qty: 5, boxes: null, pieces: null })).toBe("5");
  });
});
