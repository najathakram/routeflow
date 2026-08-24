import { formatQtySplit, normalizeBoxesPieces } from "@/lib/pricing";

/**
 * "1,240 pcs (51 boxes + 16 pcs)" for a boxed product, "45.5 kg" otherwise.
 *
 * `Product.currentStock` (and every other stock figure — StockMovement.quantity,
 * StockLot.qty) is stored in PIECES system-wide (see apps/api/src/common/pricing.ts).
 * For a BOXED product (`unitsPerBox > 1`) `product.unit` is the SELLING unit noun
 * ("case", "box") — never render a piece count next to it; the split is a display
 * re-grouping of the summed piece count, so the raw count stays primary and the
 * box/piece breakdown is parenthetical. For a NON-boxed product the stored figure
 * is already in the product's own unit, so pass `unit` and it keeps its real noun
 * ("kg", "gallon"); "pcs" is only the fallback when no unit is known.
 *
 * Extracted from DemandCard's original `unitsLabel()` — shared so the product
 * detail page's on-hand figures use the identical pattern.
 */
export function unitsLabel(
  units: number | string | null | undefined,
  unitsPerBox?: number | null,
  unit?: string | null,
): string {
  // Prisma Decimal columns arrive as numeric STRINGS, and a missing field must
  // degrade to a dash rather than throw inside a render.
  const u = Number(units);
  if (!Number.isFinite(u)) return "—";
  const n = u.toLocaleString("en-US");
  const upb = Number(unitsPerBox ?? 0);
  // Not boxed: the figure is denominated in the product's own unit, so keep its noun.
  if (!(upb > 1)) return `${n} ${unit?.trim() || "pcs"}`;
  // Boxed: a piece count — `unit` is the box noun, so it must NOT be used here.
  if (u <= 0) return `${n} pcs`;
  const split = normalizeBoxesPieces({ qty: u, unitsPerBox: upb });
  return `${n} pcs (${formatQtySplit({ qty: split.qty, boxes: split.boxes, pieces: split.pieces })})`;
}
