import { BACKORDER_TAG_LABEL } from "@routeflow/types";
import { invoiceLineQtyText, plural } from "@routeflow/pricing";

/** What the tag means, as visible text beside it (a hover title is invisible on touch). */
export const BACKORDER_HINT = "Ships when stock arrives";

/** The stored facts that say which unit a line was sold in (L-332). Every field is optional. */
export interface BackorderUnit {
  boxes?: number | string | null;
  unitsPerBox?: number | string | null;
  /** The line's own selling unit ("Case"); empty means the pack. */
  unitLabel?: string | null;
}

/**
 * The shortfall in the unit the line was sold in: "2 cases" for a case line, "4 boxes" for a pack
 * line, "2 cases + 6 pcs" when it is not a whole number of them, "3 pcs" for a line sold loose.
 * `pieces` is always the stored base-piece count (`backorderedPieces`); it is converted here, at the
 * edge, from the line's stored pack and label, never from the live product.
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
  return `${pieces} ${pieces === 1 ? "pc" : "pcs"}`;
}

export function backorderTagText(pieces: number, unit?: BackorderUnit | null): string {
  return `${BACKORDER_TAG_LABEL} · ${backorderQtyText(pieces, unit)}`;
}
