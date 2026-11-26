import { normalizeBoxesPieces } from "./pricing";

/**
 * SA-1067 M3: the most one unit of a line may sell for. The server's `unitPrice` DTOs and the till's price dialog
 * (`OVER_LIMIT`) both read this, so a value the server would answer with a 400 is refused where it is typed. A million
 * dollars keeps the line math inside the Decimal(10,2) the schema reserves for totals.
 */
export const MAX_UNIT_PRICE = 1_000_000;

/**
 * B1382 (SA-1281 part 3, SA-1285): the most one buyer order line may carry, in PIECES (qty, boxes or pieces). The
 * buyer shop and cart stop at it (a case line at `maxLineCount(BUYER_LINE_QTY_MAX, unitsPerBox)` cases), and the
 * server's buyer DTOs refuse above it, so a number the server would answer with a 400 is refused where it is typed.
 */
export const BUYER_LINE_QTY_MAX = 100_000;

/**
 * B1386 (SA-1285 section 1): a buyer line's PIECE total, the figure the cap is judged on. A line written in pieces
 * (a box-split line, or an entry with a filed split) counts its `qty`; a pack line counts `qty` packs x
 * `unitsPerBox`. A pack that is missing, below 2 or not a whole number counts as 1 (the `maxLineCount` rule).
 */
export function buyerLinePieces(qty: number, inPieces: boolean, unitsPerBox?: unknown): number {
  const pack = unitsPerBox == null ? NaN : Number(unitsPerBox);
  const factor = Number.isInteger(pack) && pack >= 2 ? pack : 1;
  return inPieces ? qty : qty * factor;
}

/**
 * B1386 (SA-1285 section 1, order CREATE): the PIECE total a buyer's new order line is built to, exactly as
 * `OrdersService.create` builds it. A line that names a split (boxes or pieces above 0) is `boxes x pack + pieces`
 * through `normalizeBoxesPieces` (the `qty` is ignored when a pack of 2 or more is known; a product with no pack keeps
 * its `qty`); a plain `qty` counts PACKS (SA-601), so it is `qty x pack`. A pack that is missing, below 2 or not a
 * whole number counts as 1 (the `maxLineCount` rule). This is the figure the cap is judged on: the DTO bounds each
 * field alone, so `{ qty: 1, boxes: 100000 }` on a 12-pack is 1,200,000 pieces.
 */
export function buyerCreateLinePieces(line: {
  qty?: number | null;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: unknown;
}): number {
  const pack = line.unitsPerBox == null ? NaN : Number(line.unitsPerBox);
  const factor = Number.isInteger(pack) && pack >= 2 ? pack : 1;
  const qty = Number(line.qty ?? 0);
  if ((line.boxes ?? 0) > 0 || (line.pieces ?? 0) > 0) {
    return normalizeBoxesPieces({
      boxes: line.boxes,
      pieces: line.pieces,
      qty,
      unitsPerBox: factor,
    }).qty;
  }
  return buyerLinePieces(qty, false, factor);
}

/**
 * B1386 (SA-1285 section 1, rise-only): true when a buyer line's new piece total passes `BUYER_LINE_QTY_MAX` AND is
 * above what that same line already held (`storedPieces`; 0 for a new line). An existing line above the cap stays
 * editable: it may be resent or lowered, never raised.
 */
export function buyerLineOverCap(pieces: number, storedPieces = 0): boolean {
  if (!Number.isFinite(pieces)) return true; // fail closed: a figure that is not a number is never under the cap
  return pieces > BUYER_LINE_QTY_MAX && pieces > storedPieces;
}
