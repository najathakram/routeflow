import { poItemQtyLabel } from "../lib/po-item-qty-label";

describe("poItemQtyLabel (LANE-U step 8 — mobile PO detail pack/unit labels)", () => {
  it("non-boxed: renders the raw qty with the product's own unit noun", () => {
    expect(poItemQtyLabel(45.5, 0, "kg")).toBe("45.5 kg");
    expect(poItemQtyLabel(10, null, "gallon")).toBe("10 gallon");
  });

  it("non-boxed with no unit known: falls back to pcs", () => {
    expect(poItemQtyLabel(10, 0, undefined)).toBe("10 pcs");
    expect(poItemQtyLabel(10, 0, "")).toBe("10 pcs");
  });

  it("boxed: shows the piece count plus the boxes+pieces split, never the box noun on the count", () => {
    // 51 boxes of 24 + 16 pieces = 1240
    expect(poItemQtyLabel(1240, 24, "case")).toBe("1,240 pcs (51 boxes + 16 pcs)");
  });

  it("boxed, exact multiple of the pack: no leftover pieces — formatQtySplit omits the zero leg", () => {
    expect(poItemQtyLabel(48, 24, "case")).toBe("48 pcs (2 boxes)");
  });

  it("boxed but zero/negative qty: plain pcs, no split attempted", () => {
    expect(poItemQtyLabel(0, 24, "case")).toBe("0 pcs");
    expect(poItemQtyLabel(-5, 24, "case")).toBe("-5 pcs");
  });

  it("unitsPerBox of exactly 1 is not boxed — the split is indistinguishable from none", () => {
    expect(poItemQtyLabel(10, 1, "unit")).toBe("10 unit");
  });

  it("missing/invalid qty degrades to a dash rather than throwing", () => {
    expect(poItemQtyLabel(null, 24, "case")).toBe("—");
    expect(poItemQtyLabel(undefined, 24, "case")).toBe("—");
    expect(poItemQtyLabel("not-a-number", 24, "case")).toBe("—");
  });

  it("Decimal columns arrive as numeric strings — coerced, not stringified", () => {
    expect(poItemQtyLabel("1240", 24, "case")).toBe("1,240 pcs (51 boxes + 16 pcs)");
  });
});
