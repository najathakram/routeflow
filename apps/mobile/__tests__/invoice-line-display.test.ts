import { invoiceLineQtyText } from "@routeflow/pricing";
import { invoiceLineUnitNoun, usesUnitDisplay } from "../lib/invoice-line-display";

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
