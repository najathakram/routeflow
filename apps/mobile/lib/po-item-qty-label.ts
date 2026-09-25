/**
 * "1,240 pcs (51 boxes + 16 pcs)" for a boxed product's PO line, "45.5 kg" otherwise — the
 * mobile twin of web's `unitsLabel` (apps/web/lib/stock-label.ts), same `@routeflow/pricing`
 * primitives so the two surfaces can never disagree on the split.
 *
 * A PO line's `qtyOrdered`/`qtyReceived` are stored in PIECES system-wide (see
 * `@routeflow/pricing`). For a BOXED product (`unitsPerBox > 1`) the line's own `product.unit`
 * is the SELLING unit noun ("case", "box") — never render a piece count next to it, so the raw
 * count stays primary and the box/piece breakdown is parenthetical. For a NON-boxed product the
 * stored figure is already in the product's own unit, so it keeps its real noun ("kg", "gallon");
 * "pcs" is only the fallback when no unit is known.
 *
 * `getPurchaseOrder` (the PO detail endpoint) includes `product.unitsPerBox`/`product.unit` on
 * every item — `listPurchaseOrders` does not, so this is detail-screen only (LANE-U step 8).
 */
import { formatQtySplit, normalizeBoxesPieces } from "@routeflow/pricing";

export function poItemQtyLabel(
  qty: number | string | null | undefined,
  unitsPerBox?: number | null,
  unit?: string | null,
): string {
  // Prisma Decimal columns arrive as numeric STRINGS, and a missing field must degrade to a
  // dash rather than throw inside a render. `Number(null) === 0`, so null needs its own check —
  // Number.isFinite alone would silently render a missing qty as "0 pcs".
  if (qty == null) return "—";
  const q = Number(qty);
  if (!Number.isFinite(q)) return "—";
  const n = q.toLocaleString("en-US");
  const upb = Number(unitsPerBox ?? 0);
  // Not boxed: the figure is denominated in the product's own unit, so keep its noun.
  if (!(upb > 1)) return `${n} ${unit?.trim() || "pcs"}`;
  // Boxed: a piece count — `unit` is the box noun, so it must NOT be used here.
  if (q <= 0) return `${n} pcs`;
  const split = normalizeBoxesPieces({ qty: q, unitsPerBox: upb });
  return `${n} pcs (${formatQtySplit({ qty: split.qty, boxes: split.boxes, pieces: split.pieces })})`;
}
