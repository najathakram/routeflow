import { adjustLineFreeUnits, lineUnitsPerBox } from "../lib/at-door-line-units";

/**
 * B657 — the at-door "Adjust order" screen box math must use the LINE'S OWN
 * `unitsPerBox` snapshot (sale time), falling back to the live product only
 * when the line has none — never the live product first. A product repacked
 * after the sale (24/box -> 12/box) must not desync an already-agreed line.
 */

describe("lineUnitsPerBox", () => {
  it("prefers the line's own snapshot over a repacked live product (B657)", () => {
    // Sold at 24/box; the product has since been repacked to 12/box.
    const li = { unitsPerBox: 24, product: { unitsPerBox: 12 } };
    expect(lineUnitsPerBox(li)).toBe(24); // fails today: reads the live 12
  });

  it("falls back to the live product only when the line has no snapshot (legacy line)", () => {
    const li = { unitsPerBox: null, product: { unitsPerBox: 12 } };
    expect(lineUnitsPerBox(li)).toBe(12);
  });

  it("a non-boxed line (no product, no snapshot) resolves to 0", () => {
    expect(lineUnitsPerBox({ unitsPerBox: null, product: undefined })).toBe(0);
    expect(lineUnitsPerBox({ unitsPerBox: undefined })).toBe(0);
  });
});

describe("adjustLineFreeUnits", () => {
  it("rescales BOGO free units off the line's own box size, not the repacked product (B657)", () => {
    // Sold 4 boxes of 24 (96 pcs), 2 free boxes earned. Live product now says 12/box.
    // Driver dials the line DOWN to 48 pcs (2 boxes at the TRUE 24/box size) — the free
    // units must rescale proportionally: 2 boxes of 4 bought -> half the free boxes -> 1.
    const li = {
      boxes: 4,
      pieces: 0,
      qty: 96,
      promoFreeUnits: 2,
      unitsPerBox: 24,
      product: { unitsPerBox: 12 },
    };
    expect(adjustLineFreeUnits(li, 48)).toBe(1);
    // At the WRONG 12/box size, 48 pcs reads as 4 boxes (unchanged from the 4 bought) ->
    // no rescale -> the full 2 free boxes, over-crediting the door estimate.
  });

  it("a non-boxed line (no unitsPerBox anywhere) counts free units by qty, not boxes", () => {
    const li = { boxes: null, pieces: null, qty: 8, promoFreeUnits: 1, unitsPerBox: null };
    expect(adjustLineFreeUnits(li, 8)).toBe(1);
    expect(adjustLineFreeUnits(li, 4)).toBe(0); // shrunk below the 2-unit earn threshold
  });
});
