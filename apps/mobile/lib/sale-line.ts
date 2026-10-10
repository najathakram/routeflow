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
import { normalizeBoxesPieces, type SellLevel } from "@routeflow/pricing";

export interface SaleLineQty {
  qty?: number;
  boxes?: number | null;
  pieces?: number | null;
}

/**
 * A line's effective boxes/pieces split. An EXPLICIT split is returned exactly
 * as written — a denormalized pair the operator typed (0 boxes + 15 loose of a
 * 12-pack) is never silently re-rolled, which would move units between the two
 * steppers under them. A typed PLAIN qty (no boxes/pieces set — e.g. the
 * catalog-row qty editor, which writes qty and clears boxes/pieces even for a
 * boxed product) is folded through the shared rollover instead of being read as
 * an empty line (REG-B194).
 *
 * Every boxed branch in this file derives from this one helper, so the fold is
 * symmetric across increment, decrement and the two split setters.
 */
function splitFromPrev(prev: SaleLineQty, unitsPerBox: number): { boxes: number; pieces: number } {
  const hasSplit = prev.boxes != null || prev.pieces != null;
  if (hasSplit) return { boxes: prev.boxes ?? 0, pieces: prev.pieces ?? 0 };
  const normalized = normalizeBoxesPieces({ qty: prev.qty ?? 0, unitsPerBox });
  return { boxes: normalized.boxes ?? 0, pieces: normalized.pieces ?? 0 };
}

/**
 * A line's box split as total PIECES (REG-B194: a boxed increment used to
 * recompute `qty = boxes*upb + pieces` from scratch, silently destroying a
 * typed 10 the moment the line was rebuilt by the next scan).
 */
function piecesFromPrev(prev: SaleLineQty, unitsPerBox: number): number {
  const { boxes, pieces } = splitFromPrev(prev, unitsPerBox);
  return boxes * unitsPerBox + pieces;
}

export function incrementLine<T extends SaleLineQty>(
  prev: T,
  isBoxed: boolean,
  unitsPerBox: number,
): T & { qty: number; boxes?: number | null; pieces?: number | null } {
  if (isBoxed) {
    const upb = Math.max(2, Math.trunc(unitsPerBox));
    const normalized = normalizeBoxesPieces({
      qty: piecesFromPrev(prev, upb) + upb,
      unitsPerBox: upb,
    });
    return { ...prev, qty: normalized.qty, boxes: normalized.boxes, pieces: normalized.pieces };
  }
  return { ...prev, qty: (prev.qty ?? 0) + 1 };
}

/**
 * Add ONE LOOSE PIECE to a line (a PIECE-barcode scan — the product's
 * `unitSku` — as opposed to the case code, which adds a box). Loose pieces
 * ROLL OVER into boxes at unitsPerBox (scanning the 6th piece of a 6-pack
 * forms 1 case + 0 loose), matching the server's normalizeBoxesPieces and the
 * qty band's loose clamp. Non-boxed products: a piece IS the unit — plain +1.
 * Preserves every other field, like incrementLine.
 */
export function incrementLinePiece<T extends SaleLineQty>(
  prev: T,
  isBoxed: boolean,
  unitsPerBox: number,
): T & { qty: number; boxes?: number | null; pieces?: number | null } {
  if (!isBoxed) return { ...prev, qty: (prev.qty ?? 0) + 1 };
  const upb = Math.max(2, Math.trunc(unitsPerBox));
  const normalized = normalizeBoxesPieces({
    qty: piecesFromPrev(prev, upb) + 1,
    unitsPerBox: upb,
  });
  return { ...prev, qty: normalized.qty, boxes: normalized.boxes, pieces: normalized.pieces };
}

/**
 * #2717 M4a-1 (SA-580 R1/R4): add what a scan LANDED to the ONE line. The level comes from the
 * scanned code: UNIT adds one loose piece (rolled into boxes by `normalizeBoxesPieces`), BOX adds
 * one box. A unit-sold line (units_v1) steps its COUNT; a non-boxed product has no box/unit
 * distinction (R4), so either level is today's plain +1. Every other field on the line survives.
 */
export function addScannedLevelToLine<T extends SaleLineQty & { unitLabel?: string | null }>(
  prev: T,
  level: SellLevel,
  isBoxed: boolean,
  unitsPerBox: number,
): T & { qty: number; boxes?: number | null; pieces?: number | null } {
  if (level === "UNIT" && !isUnitLine(prev)) return incrementLinePiece(prev, isBoxed, unitsPerBox);
  // SA-085f one qty step: a unit line / BOX scan is exactly stepLineQty(+1) (never null for +1).
  return stepLineQty(prev, 1, isBoxed, unitsPerBox) as T & { qty: number };
}

/**
 * Decrement a line by one unit (one piece, or one BOX for a boxed product),
 * preserving every other field (unitPrice / note / noteOpen). Returns null when
 * the line should be removed (reaches empty).
 *
 * The boxed branch removes one case from the FOLDED split (REG-B194) rather
 * than decrementing `prev.boxes` in isolation: a line holding a typed plain qty
 * of 30 (24-pack) loses its case and keeps the remaining 6 loose, where the
 * isolated form clamped boxes to 0, read pieces as 0 and REMOVED the line —
 * destroying the typed quantity. Loose pieces below a full case survive the tap
 * (there is no case to remove); null still means "reaches empty", which for a
 * boxed line is 0 cases AND 0 loose.
 */
export function decrementLine<T extends SaleLineQty>(
  prev: T,
  isBoxed: boolean,
  unitsPerBox: number,
): (T & { qty: number }) | null {
  if (isBoxed) {
    const upb = Math.max(2, Math.trunc(unitsPerBox));
    const prevSplit = splitFromPrev(prev, upb);
    const boxes = Math.max(0, prevSplit.boxes - 1);
    const pieces = prevSplit.pieces;
    if (boxes === 0 && pieces === 0) return null;
    return { ...prev, qty: boxes * upb + pieces, boxes, pieces };
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
 * A typed plain qty carries over as those loose pieces (REG-B194) instead of
 * being dropped. Returns null when the line reaches empty (0 boxes + 0 pieces).
 */
export function setLineBoxes<T extends SaleLineQty & { unitLabel?: string | null }>(
  prev: T,
  boxes: number,
  unitsPerBox: number,
): (T & { qty: number; boxes: number; pieces: number }) | null {
  // units_v1 (SA-085h MEDIUM): a unit-sold line REFUSES a box/piece split outright — its qty
  // is a COUNT (stepLineQty's job), never pieces-in-a-box. Executable here, not a UI gate
  // (CartRow.tsx's isBoxed/DraftItemCard's isBoxed are the ONLY reason this was safe before).
  if (isUnitLine(prev)) return prev as T & { qty: number; boxes: number; pieces: number };
  const b = Math.max(0, Math.floor(boxes));
  const { pieces } = splitFromPrev(prev, unitsPerBox);
  const qty = b * unitsPerBox + pieces;
  if (qty === 0) return null;
  return { ...prev, qty, boxes: b, pieces };
}

/**
 * Set the loose-pieces count on a boxed line, preserving other fields and boxes.
 * A typed plain qty contributes its whole cases here (REG-B194) instead of
 * being dropped. Returns null when the line reaches empty (0 boxes + 0 pieces).
 */
export function setLinePieces<T extends SaleLineQty & { unitLabel?: string | null }>(
  prev: T,
  pieces: number,
  unitsPerBox: number,
): (T & { qty: number; boxes: number; pieces: number }) | null {
  // units_v1 (SA-085h MEDIUM): see setLineBoxes — a unit-sold line refuses a piece split too.
  if (isUnitLine(prev)) return prev as T & { qty: number; boxes: number; pieces: number };
  const pcs = Math.max(0, Math.floor(pieces));
  const { boxes } = splitFromPrev(prev, unitsPerBox);
  const qty = boxes * unitsPerBox + pcs;
  if (qty === 0) return null;
  return { ...prev, qty, boxes, pieces: pcs };
}

/** A unit-sold line (units_v1): `qty` is a COUNT of `unitLabel`, never pieces-in-a-box. */
export function isUnitLine(line: { unitLabel?: string | null }): boolean {
  return line.unitLabel != null && line.unitLabel !== "";
}

/**
 * The ONE qty step for a line, unit-aware (SA-085f BLOCKER). Every ± writer on both sale
 * builders (NewOrderScreen's addOne/removeOne + cart row, edit-items.tsx's incQty/decQty) must
 * route through this instead of calling incrementLine/decrementLine directly.
 *
 * Root cause: once `unitLabel` is set, `qty` gained a second meaning — the unit COUNT (a Case
 * line's qty:1 means "one Case," never "one piece of a 24-pack"). incrementLine/decrementLine's
 * `isBoxed`/`unitsPerBox` params exist to fold a PACK's pieces into boxes; applied to a unit
 * line they instead fold the unit count into "boxes" of the PACK's size, so tapping + on a
 * Case line ({qty:1}, 24-pack) produced {qty:25, boxes:1, pieces:1} — a line that reads
 * $229.17 on screen but bills qty×unitPrice = 25×220 = $5,500 server-side. A unit line's step
 * is always a plain ±1 on the count, boxes/pieces left untouched (unset, as setUnitLabel leaves
 * them) and `unitsPerBox`/`isBoxed` never consulted.
 */
export function stepLineQty<T extends SaleLineQty & { unitLabel?: string | null }>(
  prev: T,
  delta: 1 | -1,
  isBoxed: boolean,
  unitsPerBox: number,
): (T & { qty: number; boxes?: number | null; pieces?: number | null }) | null {
  if (isUnitLine(prev)) {
    const qty = Math.max(0, Math.trunc(prev.qty ?? 0) + delta);
    if (qty === 0) return null;
    return { ...prev, qty };
  }
  return delta === 1
    ? incrementLine(prev, isBoxed, unitsPerBox)
    : decrementLine(prev, isBoxed, unitsPerBox);
}

/**
 * Sell-by-unit entry: the operator types a TOTAL unit count for a case-packed line, and we
 * normalize it back into cases + loose units (7 units of a 6-pack -> 1 case + 1 loose).
 * Every other field on the line (unitPrice override, note) is preserved — rebuilding the line
 * from scratch is the field-wipe bug that incrementLine already exists to avoid.
 * Returns null when the line reaches zero, matching decrementLine's remove signal.
 */
export function setLineUnits<
  T extends {
    qty: number;
    boxes?: number | null;
    pieces?: number | null;
    unitLabel?: string | null;
  },
>(
  prev: T,
  units: number,
  unitsPerBox: number,
): (T & { qty: number; boxes?: number; pieces?: number }) | null {
  // units_v1 (SA-085h MEDIUM): on a unit-sold line the typed total IS the new count — the
  // same thing setQty/stepLineQty do, never a box/piece split.
  if (isUnitLine(prev)) {
    const qty = Math.max(0, Math.trunc(Number(units) || 0));
    if (qty === 0) return null;
    return { ...prev, qty, boxes: undefined, pieces: undefined };
  }
  const upb = Math.trunc(Number(unitsPerBox));
  if (!(upb > 1)) return null;
  const total = Math.max(0, Math.trunc(Number(units) || 0));
  if (total === 0) return null;
  return { ...prev, qty: total, boxes: Math.floor(total / upb), pieces: total % upb };
}
