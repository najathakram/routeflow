import { normalizeBoxesPieces } from "./pricing";

/**
 * B297 row 355 (SA-734r2 r-note 5): a product can sit on SEVERAL lines of one order (row 340's rate-trio
 * splits, a pack line beside a box-split line). A promotion is a property of the PRODUCT's quantity, not of
 * one line's: a 6 + 6 split must meet a 12-unit QTY_BREAK, and a buy-5-get-1 earns the same free units as
 * one 12-unit line would. These two helpers are the ONE home of that rule:
 *
 *  - `productPromotionQty` measures the product's COMBINED quantity, each line read from its OWN stored
 *    unit fields (a box-split line's `qty` is pieces; a pack line's `qty` is selling units, so its pieces
 *    are `qty x unitsPerBox` — never `qty` read as pieces);
 *  - `allocateFreeUnits` splits the combined free units across the lines, oldest first, capped at each
 *    line's whole selling units. `promoFreeUnits` stays a per-line column.
 *
 * A price promotion (PERCENT / FIXED / QTY_BREAK) needs no allocation: resolved once on the combined
 * quantity, every line of the product bills the same net unit price.
 */
export interface PromoQtyLine {
  qty: number | string;
  boxes?: number | null;
  pieces?: number | null;
}

export interface ProductPromotionQty {
  /** Combined quantity in PIECES: the QTY_BREAK gate's basis. */
  qtyPieces: number;
  /** Combined whole SELLING units (boxes for a boxed product; loose pieces never count). */
  qtyUnits: number;
  /** The combined denomination, for `applyBestPromotion`'s billed-money comparison. */
  boxes: number | null;
  pieces: number | null;
  unitsPerBox: number | null;
}

const isBoxSplit = (l: PromoQtyLine) => l.boxes != null || l.pieces != null;

/** One line's quantity in pieces, from its OWN unit fields. */
export function linePromoPieces(line: PromoQtyLine, unitsPerBox: number): number {
  const q = Number(line.qty) || 0;
  return unitsPerBox > 1 && !isBoxSplit(line) ? q * unitsPerBox : q;
}

/** One line's WHOLE selling units (the BUY_N_GET_M basis and the allocation cap). */
export function linePromoUnits(line: PromoQtyLine, unitsPerBox: number): number {
  if (unitsPerBox > 1) {
    return isBoxSplit(line)
      ? Math.trunc(Number(line.boxes) || 0)
      : Math.trunc(Number(line.qty) || 0);
  }
  return Math.trunc(Number(line.qty) || 0);
}

export function productPromotionQty(
  lines: ReadonlyArray<PromoQtyLine>,
  unitsPerBox: number | null | undefined,
): ProductPromotionQty {
  const upb = Number(unitsPerBox ?? 0);
  const qtyPieces = lines.reduce((sum, l) => sum + linePromoPieces(l, upb), 0);
  if (upb > 1) {
    const split = normalizeBoxesPieces({ qty: qtyPieces, unitsPerBox: upb });
    return {
      qtyPieces,
      qtyUnits: Number(split.boxes ?? 0),
      boxes: split.boxes,
      pieces: split.pieces,
      unitsPerBox: upb,
    };
  }
  return { qtyPieces, qtyUnits: qtyPieces, boxes: null, pieces: null, unitsPerBox: null };
}

/**
 * Split `totalFree` whole free units across lines, in the order given (the caller passes them OLDEST FIRST:
 * stored lines by id, then lines added in this edit), capping each at that line's `capUnits`. Returns one
 * count per line; the sum is `totalFree` unless every line is already at its cap.
 */
export function allocateFreeUnits(totalFree: number, capUnits: ReadonlyArray<number>): number[] {
  let left = Math.max(0, Math.trunc(Number(totalFree) || 0));
  return capUnits.map((cap) => {
    const take = Math.min(left, Math.max(0, Math.trunc(Number(cap) || 0)));
    left -= take;
    return take;
  });
}
