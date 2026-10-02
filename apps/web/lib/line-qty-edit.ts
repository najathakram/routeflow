import { isUnitPending, normalizeBoxesPieces } from "@routeflow/pricing";
import { isShapedLine } from "@/lib/default-unit-line";

/**
 * #2865 case c (SA-632): the pure quantity editors of an order's lines. Each one REFUSES a PENDING line (its
 * default selling unit not yet resolved): the SAME lines array comes back, so a quantity can never depend on
 * how fast the units ladder loads. The decision is the shared `isUnitPending` (@routeflow/pricing), applied
 * here in the logic, not only by a disabled button.
 */
export interface QtyEditLine {
  tempId: string;
  productId?: string;
  qty: number;
  unitsPerBox?: number;
  boxes?: number;
  pieces?: number;
  unitLabel?: string;
  priceEdited?: boolean;
  sellBy?: "case" | "unit";
  startOnDefaultUnit?: boolean;
  pendingTaps?: number;
}

const isPending = (l: QtyEditLine): boolean =>
  isUnitPending({ startOnDefaultUnit: l.startOnDefaultUnit, shaped: isShapedLine(l) });

function editOne<T extends QtyEditLine>(lines: T[], tempId: string, edit: (line: T) => T): T[] {
  const target = lines.find((l) => l.tempId === tempId);
  if (!target || isPending(target)) return lines; // refused in the logic: the same array, no change
  return lines.map((l) => (l.tempId === tempId ? edit(l) : l));
}

/** One step of a plain line's quantity (−/+): a whole number, at least 1. */
export function stepQtyOnLines<T extends QtyEditLine>(
  lines: T[],
  tempId: string,
  delta: number,
): T[] {
  return editOne(lines, tempId, (li) => ({
    ...li,
    qty: Math.max(1, li.qty + delta),
    startOnDefaultUnit: false,
  }));
}

/** #2696 (b): a typed qty on a plain (non-case) line, a whole number, at least 1. */
export function setQtyOnLines<T extends QtyEditLine>(
  lines: T[],
  tempId: string,
  value: number,
): T[] {
  const qty = Math.max(1, Number.isFinite(value) ? Math.trunc(value) : 1);
  return editOne(lines, tempId, (li) => ({ ...li, qty, startOnDefaultUnit: false }));
}

export function setBoxesOnLines<T extends QtyEditLine>(
  lines: T[],
  tempId: string,
  value: number,
): T[] {
  return editOne(lines, tempId, (li) => {
    const boxes = Math.max(0, isNaN(value) ? 0 : value);
    const pieces = li.pieces ?? 0;
    const qty = boxes * (li.unitsPerBox ?? 1) + pieces;
    return {
      ...li,
      boxes,
      qty: Math.max(qty, boxes > 0 || pieces > 0 ? qty : 0),
      startOnDefaultUnit: false,
    };
  });
}

export function setPiecesOnLines<T extends QtyEditLine>(
  lines: T[],
  tempId: string,
  value: number,
): T[] {
  return editOne(lines, tempId, (li) => {
    const pieces = Math.max(0, isNaN(value) ? 0 : value);
    const boxes = li.boxes ?? 0;
    return {
      ...li,
      pieces,
      qty: boxes * (li.unitsPerBox ?? 1) + pieces,
      startOnDefaultUnit: false,
    };
  });
}

/** Unit mode: a TOTAL unit count, normalised back into cases + loose (7 of a 6-pack -> 1 case + 1 loose). */
export function setUnitQtyOnLines<T extends QtyEditLine>(
  lines: T[],
  tempId: string,
  value: number,
): T[] {
  return editOne(lines, tempId, (li) => {
    const n = normalizeBoxesPieces({ qty: value, unitsPerBox: li.unitsPerBox });
    return {
      ...li,
      boxes: n.boxes ?? 0,
      pieces: n.pieces ?? 0,
      qty: n.qty,
      startOnDefaultUnit: false,
    };
  });
}

/** The case/unit entry-mode toggle also consumes the default-start flag, so a pending line refuses it too. */
export function setSellByOnLines<T extends QtyEditLine>(
  lines: T[],
  tempId: string,
  sellBy: "case" | "unit",
): T[] {
  return editOne(lines, tempId, (li) => ({ ...li, sellBy, startOnDefaultUnit: false }));
}
