/**
 * Sale-builder line-quantity helper. Increment a line by one unit (one piece, or
 * one BOX for a boxed product) while PRESERVING every other field on the line —
 * a unit-price override, a per-line note, its noteOpen state.
 *
 * Both mobile sale-builders (NewOrderScreen, operator invoices/new) previously
 * rebuilt the line from scratch on each add (`{ qty: prev.qty + 1 }`), silently
 * wiping the operator's price/note on a repeat scan or a +/- tap. Spreading
 * `...prev` fixes that and matches web's `{ ...li, qty: li.qty + 1 }`.
 */
export interface SaleLineQty {
  qty?: number;
  boxes?: number | null;
  pieces?: number | null;
}

export function incrementLine<T extends SaleLineQty>(
  prev: T,
  isBoxed: boolean,
  unitsPerBox: number,
): T & { qty: number; boxes?: number | null; pieces?: number | null } {
  if (isBoxed) {
    const boxes = (prev.boxes ?? 0) + 1;
    const pieces = prev.pieces ?? 0;
    return { ...prev, qty: boxes * unitsPerBox + pieces, boxes, pieces };
  }
  return { ...prev, qty: (prev.qty ?? 0) + 1 };
}

/**
 * Decrement a line by one unit (one piece, or one BOX for a boxed product),
 * preserving every other field (unitPrice / note / noteOpen). Returns null when
 * the line should be removed (reaches empty).
 */
export function decrementLine<T extends SaleLineQty>(
  prev: T,
  isBoxed: boolean,
  unitsPerBox: number,
): (T & { qty: number }) | null {
  if (isBoxed) {
    const boxes = Math.max(0, (prev.boxes ?? 0) - 1);
    const pieces = prev.pieces ?? 0;
    if (boxes === 0 && pieces === 0) return null;
    return { ...prev, qty: boxes * unitsPerBox + pieces, boxes, pieces };
  }
  const qty = Math.max(0, (prev.qty ?? 0) - 1);
  if (qty === 0) return null;
  return { ...prev, qty };
}

/**
 * Set a plain (non-box) qty. Preserves other fields but explicitly CLEARS
 * boxes/pieces so the server does not recompute qty from a stale box split
 * (preserving setQty's original intent). Returns null when qty resolves to 0.
 */
export function setLineQty<T extends SaleLineQty>(
  prev: T,
  qty: number,
): (Omit<T, "boxes" | "pieces"> & { qty: number }) | null {
  const q = Math.max(0, Math.floor(qty));
  if (q === 0) return null;
  const rest = { ...prev };
  delete rest.boxes;
  delete rest.pieces;
  return { ...rest, qty: q };
}

/**
 * Set the box count on a boxed line, preserving other fields and loose pieces.
 * Returns null when the line reaches empty (0 boxes + 0 pieces).
 */
export function setLineBoxes<T extends SaleLineQty>(
  prev: T,
  boxes: number,
  unitsPerBox: number,
): (T & { qty: number; boxes: number; pieces: number }) | null {
  const b = Math.max(0, Math.floor(boxes));
  const pieces = prev.pieces ?? 0;
  const qty = b * unitsPerBox + pieces;
  if (qty === 0) return null;
  return { ...prev, qty, boxes: b, pieces };
}

/**
 * Set the loose-pieces count on a boxed line, preserving other fields and boxes.
 * Returns null when the line reaches empty (0 boxes + 0 pieces).
 */
export function setLinePieces<T extends SaleLineQty>(
  prev: T,
  pieces: number,
  unitsPerBox: number,
): (T & { qty: number; boxes: number; pieces: number }) | null {
  const pcs = Math.max(0, Math.floor(pieces));
  const boxes = prev.boxes ?? 0;
  const qty = boxes * unitsPerBox + pcs;
  if (qty === 0) return null;
  return { ...prev, qty, boxes, pieces: pcs };
}
