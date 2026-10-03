import { normalizeBoxesPieces } from "@routeflow/pricing";

/**
 * Buyer cart line math (audit, money). A boxed line carries THREE numbers (qty = total pieces, boxes, pieces) and they must
 * ALWAYS agree: pricing and the order payload read boxes/pieces (the server derives qty from them whenever either is set),
 * the cart shows qty. Every edit goes through `normalizeBoxesPieces` (@routeflow/pricing), never ad-hoc arithmetic, so a
 * stale box count can never price one quantity while the cart shows (or sends) another.
 */
export interface CartLine {
  productId: string;
  qty: number;
  unitsPerBox?: number | null;
  boxes?: number;
  pieces?: number;
}

const isBoxed = (l: { unitsPerBox?: number | null }) => Number(l.unitsPerBox ?? 0) > 1;

/** The line's total pieces: its own split when it has one, else its qty (the split is authoritative, like the server). */
function totalPieces(l: CartLine, unitsPerBox: number): number {
  return normalizeBoxesPieces({ boxes: l.boxes, pieces: l.pieces, qty: l.qty, unitsPerBox }).qty;
}

/** A line with its split re-derived from a total piece count (a plain line carries no split). */
function withTotal<T extends CartLine>(line: T, total: number): T {
  if (!isBoxed(line)) return { ...line, qty: total, boxes: undefined, pieces: undefined };
  const n = normalizeBoxesPieces({ qty: total, unitsPerBox: line.unitsPerBox });
  return { ...line, qty: n.qty, boxes: n.boxes ?? 0, pieces: n.pieces ?? 0 };
}

/**
 * A fresh ADD-TO-CART onto an EXISTING line: the added quantity is ADDED to the line's, and a boxed line's boxes/pieces are
 * re-derived so they follow (24 + one box = 36 = 3 boxes), never left on the old split.
 */
export function mergeAddLine<T extends CartLine>(existing: T, add: CartLine): T {
  if (!isBoxed(existing)) return withTotal(existing, existing.qty + add.qty);
  const upb = Number(existing.unitsPerBox);
  return withTotal(existing, totalPieces(existing, upb) + totalPieces(add, upb));
}

/** A box / loose-pieces EDIT: REPLACES the split (box + from 2 boxes = 3 boxes), normalised; null = nothing left (remove). */
export function setLineSplit<T extends CartLine>(line: T, boxes: number, pieces: number): T | null {
  if (!isBoxed(line)) return null;
  const n = normalizeBoxesPieces({ boxes, pieces, unitsPerBox: line.unitsPerBox });
  return n.qty > 0 ? withTotal(line, n.qty) : null;
}

/** A plain quantity EDIT (typed / +/-): sets the total; a boxed line's split follows it. */
export function setLineQty<T extends CartLine>(line: T, qty: number): T {
  return withTotal(line, Math.max(0, Math.trunc(Number(qty) || 0)));
}
