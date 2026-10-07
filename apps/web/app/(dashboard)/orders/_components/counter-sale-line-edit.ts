import { normalizeBoxesPieces } from "@routeflow/pricing";
import type { CounterSaleItem } from "@routeflow/types";
import type { SaleLine } from "./counter-sale-scan";

/**
 * Pure line logic of the counter cart row: what a line reads as, and the wire item it sends. Money is never derived here
 * (the screen prices through cartTotals -> @routeflow/pricing).
 */

/** A pack of 1 (or no pack) has no box/piece split: it reads in pieces. Only unitsPerBox > 1 is a boxed line. */
export const isBoxedLine = (l: SaleLine) => (l.unitsPerBox ?? 0) > 1;

/** ONE quantity label for the cart and the receipt: whole boxes, then loose pieces; a plain line reads "× qty". */
export const lineQtyLabel = (l: SaleLine): string => {
  if (!isBoxedLine(l)) return `× ${l.qty}`;
  // Always the normalized split (pieces < pack), so a stored 0 boxes + 30 pcs on a 24-pack still reads "1 box + 6 pcs".
  const n = normalizeBoxesPieces({
    boxes: l.boxes,
    pieces: l.pieces,
    qty: l.qty,
    unitsPerBox: l.unitsPerBox,
  });
  const boxes = n.boxes ?? 0;
  return `${boxes} box${boxes === 1 ? "" : "es"}${n.pieces ? ` + ${n.pieces} pcs` : ""}`;
};

/**
 * The wire item for one line, shaped the way the server's normaliser reads it (`normalizeBoxesPieces`): a boxed product
 * (unitsPerBox > 1) sends `{boxes, pieces, qty}` with `qty` the integer piece count; anything else (no pack, or a pack of 1,
 * which has no box/piece split) sends `qty` alone. Boxes without a qty is what the server reads as 0.
 */
export const toSaleItem = (l: SaleLine): CounterSaleItem => {
  const n = normalizeBoxesPieces({
    boxes: l.boxes,
    pieces: l.pieces,
    qty: l.qty,
    unitsPerBox: l.unitsPerBox,
  });
  return n.boxes === null || n.pieces === null
    ? { productId: l.productId, qty: n.qty }
    : { productId: l.productId, boxes: n.boxes, pieces: n.pieces, qty: n.qty };
};
