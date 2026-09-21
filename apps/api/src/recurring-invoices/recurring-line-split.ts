/**
 * B646 — a recurring template line is a PACK COUNT (A0: `unitLabel` null = the pack): the operator types
 * BOXES against a per-box price. Handed to `invoicesService.create` as a bare `qty`, the line was stored with
 * qty = boxes in the pieces column (COGS and the levy basis understated by unitsPerBox). Generation is a
 * NEW sale, so the LIVE pack at generation time is the right one (Senior Architect `buildLine` contract);
 * the split makes the builder derive `qty = boxes x pack`, the prorated subtotal and the pieces basis.
 *
 * Returns the `{ boxes, pieces }` to pass, or null when the line is not a boxed pack count (a non-boxed or
 * freeform product, a selling-unit line) or its qty is not a whole number of pieces (kept as today).
 */
export function recurringLineSplit(
  line: { productId: string | null; qty: unknown; unitLabel?: string | null },
  livePack: number | null | undefined,
): { boxes: number; pieces: number } | null {
  const pack = Math.trunc(Number(livePack ?? 0));
  if (!line.productId || line.unitLabel || pack <= 1) return null;
  const qty = Number(line.qty);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const boxes = Math.floor(qty);
  const pieces = Math.round((qty - boxes) * pack);
  // qty is Decimal(10,3): 1.5 boxes of 12 is 1 box + 6 pieces, but 1.3 of 12 is not a whole piece count.
  if (Math.abs((qty - boxes) * pack - pieces) > 1e-6) return null;
  return { boxes: boxes + Math.floor(pieces / pack), pieces: pieces % pack };
}
