/**
 * #2276 / SA-388 (#938, tier 1): the ONE count function for a stored unit-aware order line — the
 * count of its named unit ("3 Cases"), derived from the server's stored fields. Web (orders/[id]
 * edit) and mobile (edit-items-draft, buyer edit-items) both import this; there are no copies.
 *
 * - `boxes` when it is a positive integer (unit-line-build.ts stores the COUNT there);
 * - else `qty ÷ unitsPerBox` — the line's SNAPSHOT factor — when that factor is an integer ≥ 1 and
 *   `qty` (base pieces) is a POSITIVE integer and a whole multiple of it (factor-1 "Each" lines,
 *   boxes null, land here);
 * - else `null`: LOCKED. There is no safe count, so the caller takes no qty edit and refuses a
 *   price/note edit rather than guessing. Falling back to raw `qty` read base pieces as the count —
 *   a price-only save re-billed a 3-Case line as 36 Cases (12x).
 *
 * Fields are `unknown` so both apps' line shapes (numbers, or Decimal-as-string JSON) fit.
 */
export function unitLineCount(li: {
  qty?: unknown;
  boxes?: unknown;
  unitsPerBox?: unknown;
}): number | null {
  const boxes = li.boxes == null ? null : Number(li.boxes);
  if (boxes != null && Number.isInteger(boxes) && boxes > 0) return boxes;
  const factor = li.unitsPerBox == null ? null : Number(li.unitsPerBox);
  const qty = Number(li.qty);
  if (
    factor != null &&
    Number.isInteger(factor) &&
    factor >= 1 &&
    Number.isInteger(qty) &&
    qty > 0 &&
    qty % factor === 0
  ) {
    return qty / factor;
  }
  return null;
}

/**
 * The most a line may count in its selling unit when its PIECE total may not pass `cap`: `cap` for Each lines, and
 * `floor(cap / unitsPerBox)` Cases for a boxed Case line (cases x unitsPerBox = pieces). `unitsPerBox` null,
 * missing, below 2 or not a whole number returns `cap`; it never divides by 0. B1382: the one bound the buyer cart
 * hook and mobile cart store clamp to.
 */
export function maxLineCount(cap: number, unitsPerBox?: unknown): number {
  const factor = unitsPerBox == null ? null : Number(unitsPerBox);
  if (factor == null || !Number.isInteger(factor) || factor < 2) return cap;
  return Math.floor(cap / factor);
}
