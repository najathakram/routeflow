import { formatQtySplit, normalizeBoxesPieces, type SellLevel } from "@routeflow/pricing";

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

/**
 * #2717 M4a-1 (SA-580 R1/R4): the qty fields for a NEW line born from a scan that carried `level`.
 * A UNIT scan on a boxed product (upb > 1) is ONE loose piece — `{qty:1, boxes:0, pieces:1}` — never
 * a hidden case. Every other case (BOX, or upb <= 1 where there is no box/unit distinction) is
 * today's `newLineQty`.
 */
export function newLineQtyForLevel(
  unitsPerBox: number | undefined,
  level: SellLevel,
  n: number,
): { qty: number; boxes?: number; pieces?: number } {
  if (level === "UNIT" && unitsPerBox && unitsPerBox > 1) return { qty: n, boxes: 0, pieces: n };
  return newLineQty(unitsPerBox, n);
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

/**
 * Adds `n` loose PIECES to an existing line (a UNIT scan): pieces + n, rolled into boxes by
 * `normalizeBoxesPieces` so `pieces < unitsPerBox` always holds and the line states boxes AND pieces.
 * A non-boxed line (no pack, or upb <= 1) just gains `n`, exactly as `mergeQtyIntoLine` (R4).
 */
export function mergePieceIntoLine<T extends QtyLine>(line: T, n: number): T {
  if (line.unitsPerBox && line.unitsPerBox > 1) {
    const total = (line.boxes ?? 0) * line.unitsPerBox + (line.pieces ?? 0) + n;
    const norm = normalizeBoxesPieces({ qty: total, unitsPerBox: line.unitsPerBox });
    return { ...line, boxes: norm.boxes ?? 0, pieces: norm.pieces ?? 0, qty: norm.qty };
  }
  return mergeQtyIntoLine(line, n);
}

/** The toast body after a merge, e.g. "Sample Cola — now 3" / "Sample Cola — now 2 cases + 3 pcs". */
export function mergedLineMessage(name: string, merged: QtyLine): string {
  const label = merged.unitsPerBox
    ? formatQtySplit({
        qty: merged.qty,
        boxes: merged.boxes,
        pieces: merged.pieces,
        boxLabel: "case", // the line row says "cases"
      })
    : String(merged.qty);
  return `${name} — now ${label}`;
}
