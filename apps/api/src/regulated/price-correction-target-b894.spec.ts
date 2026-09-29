/**
 * B894 (SA-576): B662's price-correction TARGET is "the new figure on the qty still held". The held-side
 * convention must equal the credit convention (linear), or booked − returned credits stops netting to the
 * target. So the target is monotone in the held qty, is the whole figure at the full qty and $0 at none.
 */
import { priceCorrectionTarget } from "./regulated-ledger.service";

describe("B894 — priceCorrectionTarget is a linear slice of the new figure", () => {
  // the FULL line shape production passes (free units + box split): the linear rule must ignore them, and on master
  // (prorateLineSubtotal with the free-unit telescope) they bend the curve. A variable, not a literal, so the extra
  // fields are not an excess-property error against the narrowed Pick<..., "qty">.
  const line = { qty: 20, boxes: 5, unitsPerBox: 4, promoFreeUnits: 2 };

  it("monotone non-decreasing in the held qty, 0 at none, the whole figure at the full qty", () => {
    const curve = Array.from({ length: 21 }, (_, held) => priceCorrectionTarget(24, held, line));
    expect(curve[0]).toBe(0);
    expect(curve[20]).toBe(24);
    for (let h = 1; h <= 20; h++) expect(curve[h]).toBeGreaterThanOrEqual(curve[h - 1]);
  });

  it("the size-4 case: holding 9 of 20 targets 10.80, not 18.00 (the floored telescope's value)", () => {
    expect(priceCorrectionTarget(24, 9, line)).toBe(10.8);
    expect(priceCorrectionTarget(24, 10, line)).toBe(12);
  });

  const bogo = { qty: 2, boxes: null, unitsPerBox: null, promoFreeUnits: 1 };

  it("size 1 BOGO (P=2, F=1): holding 1 of 2 targets half, not the whole figure", () => {
    expect(priceCorrectionTarget(10, 1, bogo)).toBe(5);
  });
});
