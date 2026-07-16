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
