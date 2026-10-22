import { computeLineSubtotal, normalizeBoxesPieces } from "@routeflow/pricing";
import { mergeBoxedContributions } from "./buyer-merge-pricing";

/**
 * SA-841 PR-3: `mergeBoxedContributions` now folds through `mergeIntoStoredLine`. The ruling requires it to be
 * MONEY-IDENTICAL, so this pins the new result against the OLD Σ formula (kept here verbatim as the oracle) over a
 * seeded grid of contribution mixes: box-split, pieces-only, bare boxed (selling units), zero, and plain products.
 */
type Contribution = { qty: number; boxes: number | null; pieces: number | null };

/** The pre-SA-841 body, verbatim: pieces per contribution, then one normalize at the group pack. */
function oldMerge(contributions: Contribution[], unitPrice: number, unitsPerBox: number) {
  const upb = Number(unitsPerBox ?? 0);
  const totalPieces = contributions.reduce((sum, c) => {
    const q = Number(c.qty);
    const sellingUnit = upb > 1 && c.boxes == null && c.pieces == null;
    return sum + (sellingUnit ? q * upb : q);
  }, 0);
  if (upb > 1) {
    const split = normalizeBoxesPieces({ qty: totalPieces, unitsPerBox: upb });
    return {
      qty: split.qty,
      boxes: split.boxes,
      pieces: split.pieces,
      subtotal: computeLineSubtotal({
        unitPrice,
        qty: split.qty,
        boxes: split.boxes,
        pieces: split.pieces,
        unitsPerBox: upb,
        freeUnits: 0,
      }),
    };
  }
  return {
    qty: totalPieces,
    subtotal: computeLineSubtotal({ unitPrice, qty: totalPieces, freeUnits: 0 }),
  };
}

describe("SA-841 PR-3: mergeBoxedContributions is money-identical through mergeIntoStoredLine", () => {
  let seed = 841;
  const next = (n: number) => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed % n;
  };
  const contribution = (upb: number): Contribution => {
    const kind = next(5);
    if (kind === 0 && upb > 1) {
      // box-split: qty is pieces
      const b = next(4);
      const p = next(upb);
      return { qty: b * upb + p, boxes: b, pieces: p };
    }
    if (kind === 1) return { qty: next(30), boxes: null, pieces: next(30) }; // pieces-only
    if (kind === 2) return { qty: 0, boxes: null, pieces: null }; // a zero contribution
    return { qty: 1 + next(9), boxes: null, pieces: null }; // bare: selling units on a boxed product
  };

  it("matches the old Σ for 600 seeded groups (qty, split and subtotal), packs 0, 1, 6, 12", () => {
    let compared = 0;
    for (let i = 0; i < 600; i++) {
      const upb = [0, 1, 6, 12][next(4)];
      const unitPrice = (100 + next(9900)) / 100;
      const group = Array.from({ length: 1 + next(4) }, () => contribution(upb));
      const want = oldMerge(group, unitPrice, upb);
      const got = mergeBoxedContributions(group, unitPrice, upb);
      expect({ i, upb, group, qty: got.qty, subtotal: got.subtotal }).toEqual({
        i,
        upb,
        group,
        qty: want.qty,
        subtotal: want.subtotal,
      });
      if (upb > 1)
        expect({ i, boxes: got.boxes, pieces: got.pieces }).toEqual({
          i,
          boxes: want.boxes,
          pieces: want.pieces,
        });
      compared++;
    }
    expect(compared).toBe(600);
  });
});
