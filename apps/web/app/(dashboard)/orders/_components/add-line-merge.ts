import { formatQtySplit } from "@routeflow/pricing";

/**
 * Pure logic behind "add a product to the order" in `CreateOrderModal` (quick-order extras,
 * LANE-S step 10): how many to add, what a NEW line starts at, and how a repeat add MERGES into an
 * existing line. Kept out of the modal so the boxed-line rule is unit-testable.
 *
 * The unit is the product's SELLING unit — a case for a case-packed product (the first add is one
 * case: `boxes: 1, qty: unitsPerBox`), a piece otherwise. Unit-level keying ("same SKU + same unit")
 * belongs to the units ladder (Lane U) and is deliberately not handled here.
 */

/** Sanity ceiling for one typed add — a slipped key ("1000000") must not create a silly line. */
export const MAX_ADD_QTY = 9999;

/** A typed "Qty" field → a whole number ≥ 1 (blank / junk / zero / negative → 1). */
export function parseAddQty(raw: string | number | null | undefined): number {
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.trunc(n), MAX_ADD_QTY);
}

/** The qty fields for a NEW line of `n` selling units. A boxed product's `qty` is total pieces. */
export function newLineQty(
  unitsPerBox: number | undefined,
  n: number,
): { qty: number; boxes?: number; pieces?: number } {
  return unitsPerBox
    ? { qty: unitsPerBox * n, boxes: n, pieces: 0 }
    : { qty: n, boxes: undefined, pieces: undefined };
}

interface QtyLine {
  qty: number;
  unitsPerBox?: number;
  boxes?: number;
  pieces?: number;
}

/**
 * Adds `n` selling units to an existing line. For a boxed line that is `n` more BOXES and `qty`
 * is re-derived from `boxes`/`pieces` — pricing and the submit payload read the split, so bumping
 * `qty` alone (what a repeat scan used to do) left the split, and the price, behind.
 */
export function mergeQtyIntoLine<T extends QtyLine>(line: T, n: number): T {
  if (line.unitsPerBox) {
    const boxes = (line.boxes ?? 0) + n;
    const pieces = line.pieces ?? 0;
    return { ...line, boxes, pieces, qty: boxes * line.unitsPerBox + pieces };
  }
  return { ...line, qty: line.qty + n };
}

/** The toast body after a merge, e.g. "Sample Cola — now 3" / "Sample Cola — now 2 boxes + 3 pcs". */
export function mergedLineMessage(name: string, merged: QtyLine): string {
  const label = merged.unitsPerBox
    ? formatQtySplit({ qty: merged.qty, boxes: merged.boxes, pieces: merged.pieces })
    : String(merged.qty);
  return `${name} — now ${label}`;
}
