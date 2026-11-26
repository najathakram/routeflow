import { BACKORDER_TAG_LABEL } from "@routeflow/types";
import {
  formatUnitCounts,
  invoiceLineQtyText,
  plural,
  summarizeLineCounts,
  unitWords,
} from "@routeflow/pricing";

/** What the tag means, as visible text beside it (a hover title is invisible on touch). */
export const BACKORDER_HINT = "Available when stock arrives";

/** The stored facts that say which unit a line was sold in (L-332). Every field is optional. */
export interface BackorderUnit {
  boxes?: number | string | null;
  unitsPerBox?: number | string | null;
  /** The line's own selling unit ("Case"); empty means the pack. */
  unitLabel?: string | null;
  /** B1440: the product's own selling unit ("bag", "lb"). Read only for a plain line (no pack, no named unit); on a
   *  boxed line this word names the box, never the piece, so it is ignored there. */
  unit?: string | null;
}

/**
 * The shortfall in the unit the line was sold in: "2 cases" for a case line, "4 boxes" for a pack
 * line, "2 cases + 6 pcs" when it is not a whole number of them, "3 pcs" for a line sold loose, "3 bags" for a plain
 * line of a product sold by the bag (B1440: the same word, from the same counter, as the order's line summary).
 * `pieces` is always the stored base-piece count (`backorderedPieces`); it is converted here, at the
 * edge, from the line's stored pack and label, never from the live product. Only a plain line's WORD is the
 * product's (`unit.unit`): a line stores no unit word, and the order summary reads the same field.
 */
export function backorderQtyText(pieces: number, unit?: BackorderUnit | null): string {
  const upb = Number(unit?.unitsPerBox ?? 0);
  const boxes = Number(unit?.boxes ?? 0);
  const label = (unit?.unitLabel ?? "").trim();
  if (boxes > 0 && upb > 1 && Number.isInteger(pieces) && Number.isInteger(upb)) {
    const whole = Math.floor(pieces / upb);
    if (whole > 0) {
      return invoiceLineQtyText({
        qty: pieces,
        boxes: whole,
        pieces: pieces - whole * upb,
        unitLabel: label,
      }).toLowerCase();
    }
  }
  // A factor-1 named unit ("Piece"): the stored count IS the unit count, so say its own word.
  if (label && upb <= 1) return `${pieces} ${plural(label.toLowerCase(), pieces)}`;
  // B1440: a plain line counts in its own selling unit, through the ONE counter the order summary prints from
  // (a generic word, or none, is "pcs" there too). A boxed product's unit names the box, so it is not passed.
  const counted = formatUnitCounts(
    summarizeLineCounts([{ qty: pieces, unit: upb > 1 ? null : unit?.unit }]),
  );
  return counted || `${pieces} ${unitWords().baseShortFor(pieces)}`;
}

/**
 * `soldPieces` (the line's stored base-piece qty) lets the tag say WHY: what was in stock when the line was sold
 * is the sold quantity minus the part sold past stock, in the line's own unit ("(0 in stock when ordered)"; it is stock at the time of the order, not live stock).
 * Omitted or not a number, the tag is just the shortfall.
 */
export function backorderTagText(
  pieces: number,
  unit?: BackorderUnit | null,
  soldPieces?: number | null,
): string {
  const base = `${BACKORDER_TAG_LABEL} · ${backorderQtyText(pieces, unit)}`;
  if (soldPieces == null || !Number.isFinite(soldPieces)) return base;
  const inStock = Math.max(0, soldPieces - pieces);
  return inStock > 0
    ? `${base} (${backorderQtyText(inStock, unit)} in stock when ordered)`
    : `${base} (0 in stock when ordered)`;
}
