import { computeLineSubtotal, normalizeBoxesPieces, type PromotionRule } from "@routeflow/pricing";
import { PriceType } from "@prisma/client";
import {
  MERGE_CONTRIBUTION_QTY_INVALID,
  MERGE_CONTRIBUTION_REFUSED,
  isBuyerPricedLine,
  mergeBoxedContributions,
  rescaleBogoFreeUnits,
} from "./buyer-merge-pricing";

/**
 * SA-841 PR-3: `mergeBoxedContributions` folds through `mergeIntoStoredLine`, and the ruling requires it to be
 * MONEY-IDENTICAL. The oracle below is master's function at the merge base, VERBATIM (sliced out of the file, only its
 * name changed), so every field of the result is compared: qty, boxes/pieces, subtotal, freeUnits and storedFreeUnits.
 *
 * #3587 review MUST-1: the generator draws from the HIGH bits of independent LCG streams (one per dimension) and walks
 * every pack x group size, so no dimension is tied to another; a coverage assert proves it. MUST-2: fractional qty
 * (OrderItem.qty is Decimal(10,3)) is in the rows.
 */
// --- oracle: master's mergeBoxedContributions, verbatim ---
function oldMergeBoxedContributions(
  contributions: Array<{
    qty: unknown;
    boxes: number | null;
    pieces: number | null;
    promoFreeUnits?: number | null;
    priceType?: PriceType | null;
    overriddenBy?: string | null;
  }>,
  unitPrice: number,
  unitsPerBox: number | null | undefined,
  bogo?: {
    promos: PromotionRule[];
    productId: string | null;
    category: string | null;
    canEarnNew?: boolean;
    /**
     * The merged line's surviving unitPrice already carries a price-promo
     * discount (winner/meta line is PROMO with a strikethrough). Promotions
     * never stack — a buyer splitting one cart in two must not merge back to
     * a percent discount PLUS free units — so both the stored-snapshot rescale
     * and canEarnNew are suppressed and the merged line keeps price-off only.
     */
    pricePromoApplied?: boolean;
  },
): {
  qty: number;
  boxes: number | null;
  pieces: number | null;
  subtotal: number;
  freeUnits: number;
  /** Σ of the contributions' BUY_N_GET_M snapshots — 0 when no line carried one. */
  storedFreeUnits: number;
} {
  const upb = Number(unitsPerBox ?? 0);
  const totalPieces = contributions.reduce((sum, c) => {
    const q = Number(c.qty);
    const sellingUnit = upb > 1 && c.boxes == null && c.pieces == null;
    return sum + (sellingUnit ? q * upb : q);
  }, 0);
  // Free-unit snapshots and the whole selling units they were earned at. A
  // box-split line counts its BOXES (its `qty` is pieces); every other shape
  // already stores selling units in `qty`.
  const storedFreeUnits = contributions.reduce(
    (sum, c) => sum + Math.max(0, Number(c.promoFreeUnits ?? 0) || 0),
    0,
  );
  const oldUnits = contributions.reduce(
    (sum, c) => sum + (c.boxes != null ? Number(c.boxes) : Number(c.qty)),
    0,
  );
  const canEarnNew = bogo?.canEarnNew === true && contributions.every((c) => isBuyerPricedLine(c));
  const freeUnitsFor = (newUnits: number) =>
    bogo?.pricePromoApplied === true
      ? 0
      : rescaleBogoFreeUnits({
          promos: bogo?.promos ?? [],
          productId: bogo?.productId ?? null,
          category: bogo?.category ?? null,
          unitPrice,
          storedFreeUnits,
          oldUnits,
          newUnits,
          canEarnNew,
        });
  if (upb > 1) {
    const split = normalizeBoxesPieces({ qty: totalPieces, unitsPerBox: upb });
    const freeUnits = freeUnitsFor(Number(split.boxes ?? 0));
    return {
      qty: split.qty,
      boxes: split.boxes,
      pieces: split.pieces,
      freeUnits,
      storedFreeUnits,
      subtotal: computeLineSubtotal({
        unitPrice,
        qty: split.qty,
        boxes: split.boxes,
        pieces: split.pieces,
        unitsPerBox: upb,
        freeUnits,
      }),
    };
  }
  const freeUnits = freeUnitsFor(totalPieces);
  return {
    qty: totalPieces,
    boxes: null,
    pieces: null,
    freeUnits,
    storedFreeUnits,
    subtotal: computeLineSubtotal({ unitPrice, qty: totalPieces, freeUnits }),
  };
}

// --- end oracle ---

/** An LCG stream drawing from its HIGH bits (the low bits of an LCG repeat on a short cycle). */
function stream(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 16) % n;
  };
}

type Contribution = Parameters<typeof mergeBoxedContributions>[0][number];
const PACKS: Array<number | null> = [null, 0, 1, 6, 12];
const BOGO: PromotionRule = {
  id: "promo-1",
  type: "BUY_N_GET_M",
  value: 1,
  minQty: 2,
  scope: "PRODUCTS",
  productIds: ["p1"],
};

describe("SA-841 PR-3: mergeBoxedContributions is money-identical through mergeIntoStoredLine", () => {
  const shape = stream(1);
  const size = stream(2);
  const amount = stream(3);
  const price = stream(4);
  const promo = stream(5);

  const contribution = (upb: number): Contribution => {
    const priceType = [PriceType.STANDARD, PriceType.MANUAL, PriceType.PROMO][promo(3)];
    const promoFreeUnits = promo(4) === 0 ? 1 + promo(2) : null;
    const frac = [0, 0.5, 0.25, 0.125][amount(4)];
    switch (shape(5)) {
      case 0: {
        if (!(upb > 1))
          return { qty: 1 + amount(20), boxes: null, pieces: null, priceType, promoFreeUnits };
        const b = amount(4);
        const p = amount(upb);
        return { qty: b * upb + p, boxes: b, pieces: p, priceType, promoFreeUnits }; // box-split
      }
      case 1:
        return {
          qty: amount(30) + frac,
          boxes: null,
          pieces: amount(30) + frac,
          priceType,
          promoFreeUnits,
        }; // pieces-only
      case 2:
        return { qty: 0, boxes: null, pieces: null, priceType }; // a zero contribution
      default:
        return { qty: 1 + amount(9) + frac, boxes: null, pieces: null, priceType, promoFreeUnits }; // bare (selling units)
    }
  };

  it("matches master's function on EVERY field, over every pack (incl. null) x group size 1-4, 40 groups each", () => {
    const seen = new Map<string, number>();
    for (const upb of PACKS)
      for (let groupSize = 1; groupSize <= 4; groupSize++)
        for (let k = 0; k < 40; k++) {
          const group = Array.from({ length: groupSize }, () => contribution(Number(upb ?? 0)));
          const unitPrice = (100 + price(9900)) / 100;
          const bogo =
            promo(3) === 0
              ? undefined
              : {
                  promos: [BOGO],
                  productId: "p1",
                  category: null,
                  canEarnNew: promo(2) === 0,
                  pricePromoApplied: promo(5) === 0,
                };
          const want = oldMergeBoxedContributions(group, unitPrice, upb, bogo);
          const got = mergeBoxedContributions(group, unitPrice, upb, bogo);
          expect({ upb, group, unitPrice, bogo, got }).toEqual({
            upb,
            group,
            unitPrice,
            bogo,
            got: want,
          });
          const key = `${upb}x${groupSize}`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
    // MUST-1 coverage: every pack x size cell is exercised, none tied to another dimension
    for (const upb of PACKS)
      for (let n = 1; n <= 4; n++)
        expect({ cell: `${upb}x${n}`, hits: seen.get(`${upb}x${n}`) }).toEqual({
          cell: `${upb}x${n}`,
          hits: 40,
        });
  });

  it("the generator reaches the hard rows: fractional qty, zero, BOGO snapshots, all four contribution shapes", () => {
    const all = PACKS.flatMap((upb) =>
      Array.from({ length: 200 }, () => contribution(Number(upb ?? 0))),
    );
    expect(all.some((c) => !Number.isInteger(Number(c.qty)))).toBe(true);
    expect(all.some((c) => Number(c.qty) === 0)).toBe(true);
    expect(all.some((c) => (c.promoFreeUnits ?? 0) > 0)).toBe(true);
    expect(all.some((c) => c.boxes != null)).toBe(true);
    expect(all.some((c) => c.boxes == null && c.pieces != null)).toBe(true);
    expect(all.some((c) => c.boxes == null && c.pieces == null && Number(c.qty) > 0)).toBe(true);
  });

  it.each([
    [
      "pieces 2.5 + 2.5 at pack 12",
      [
        { qty: 2.5, boxes: null, pieces: 2.5 },
        { qty: 2.5, boxes: null, pieces: 2.5 },
      ],
      12,
    ],
    [
      "bare 1.25 + 1.25 at pack 6",
      [
        { qty: 1.25, boxes: null, pieces: null },
        { qty: 1.25, boxes: null, pieces: null },
      ],
      6,
    ],
  ] as Array<[string, Contribution[], number]>)(
    "MUST-2 fractional qty is money-identical (sum, then one normalize): %s",
    (_label, group, upb) => {
      expect(mergeBoxedContributions(group, 10, upb)).toEqual(
        oldMergeBoxedContributions(group, 10, upb),
      );
    },
  );

  it("one BUY_N_GET_M case: the merged line earns its own free units exactly as before", () => {
    const group: Contribution[] = [
      { qty: 3, boxes: null, pieces: null, promoFreeUnits: 1, priceType: PriceType.STANDARD },
      { qty: 3, boxes: null, pieces: null, promoFreeUnits: 1, priceType: PriceType.STANDARD },
    ];
    const bogo = { promos: [BOGO], productId: "p1", category: null, canEarnNew: true };
    const got = mergeBoxedContributions(group, 10, 12, bogo);
    expect(got).toEqual(oldMergeBoxedContributions(group, 10, 12, bogo));
    expect(got.freeUnits).toBeGreaterThan(0);
  });

  it.each([[-1], [Number.NaN]])(
    "a contribution qty of %s is refused with MERGE_CONTRIBUTION_QTY_INVALID, never dropped",
    (qty) => {
      expect(() =>
        mergeBoxedContributions(
          [
            { qty: 2, boxes: null, pieces: null },
            { qty, boxes: null, pieces: null },
          ],
          10,
          12,
        ),
      ).toThrow(expect.objectContaining({ code: MERGE_CONTRIBUTION_QTY_INVALID }));
    },
  );
});

describe("SA-841 PR-3: an unreachable helper refusal is coded, never swallowed", () => {
  afterEach(() => jest.restoreAllMocks());

  it("a PACK_MISMATCH from mergeIntoStoredLine throws MERGE_CONTRIBUTION_REFUSED", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const helper = require("./stored-line-merge");
    jest.spyOn(helper, "mergeIntoStoredLine").mockReturnValue({
      ok: false,
      reason: "PACK_MISMATCH",
      linePack: 12,
      addPack: 6,
    });
    expect(() => mergeBoxedContributions([{ qty: 1, boxes: null, pieces: null }], 10, 12)).toThrow(
      expect.objectContaining({ code: MERGE_CONTRIBUTION_REFUSED }),
    );
  });
});
