/**
 * Classify a vendor-bill line's stated pack size against what the catalog
 * already knows about the product (purchase-cost silent default).
 *
 * `VendorBillItem.qty`/`unitCost` are in the SUPPLIER's own denomination
 * (cases when `packSize > 1`, pieces otherwise) — `packSize` is what tells
 * `lineInventoryDelta` how to convert them to the PIECE basis
 * `Product.currentStock`/`averageCost` require. The AI scan prompt
 * deliberately returns `packSize: null` rather than guess a case size it
 * can't read off the document ("NEVER guess or infer") — but a plain
 * `Number(null)` is `0`, so that honest "I don't know" and a genuine
 * "sold loose" both end up indistinguishable once stored: neither is ever
 * `> 1`. `lineInventoryDelta`'s `item.packSize ?? 0` then silently treats
 * either as pieces at the line's own unit cost — under-counting inventory
 * and over-stating average cost by the pack factor for a delivery that was
 * actually cases.
 *
 * A product the catalog already knows moves in more than one piece per
 * unit (the classic pack column, or ANY units_v1 selling level above the
 * base — a product with a "Case" of 24 is self-evidently not a loose-piece
 * product, even though that ladder is about SELLING, not buying) makes a
 * bill line with no stated pack for THAT product genuinely ambiguous —
 * never a legitimate "sold loose" line. A product with no pack ladder at
 * all keeps today's behavior: no pack stated there really does mean sold
 * by the piece.
 *
 * This module never fills in the missing number from the product's own
 * pack — the supplier's case size can differ from what the product is SOLD
 * in (you sell 12s, they ship 24s) — it only decides whether to ask.
 */

export interface PackLadderProduct {
  name?: string | null;
  unitsPerBox?: number | null;
  units?: ReadonlyArray<{ factorToBase: number | null }> | null;
}

export type BillLinePackClass = "case" | "loose" | "unknown";

/** True when the catalog already knows this product moves in more than one piece per unit. */
export function productHasPackLadder(product: PackLadderProduct | null | undefined): boolean {
  if (!product) return false;
  if (Number(product.unitsPerBox ?? 0) > 1) return true;
  return (product.units ?? []).some((u) => Number(u?.factorToBase ?? 0) > 1);
}

/**
 * The product's own known pack, for the response's hint field ONLY — never
 * applied to the line. Prefers `unitsPerBox` (the classic pack), else the
 * smallest qualifying `ProductUnit` level. 0 when the product has no ladder.
 */
export function knownPackHint(product: PackLadderProduct | null | undefined): number {
  if (!product) return 0;
  const upb = Number(product.unitsPerBox ?? 0);
  if (upb > 1) return upb;
  const levels = (product.units ?? [])
    .map((u) => Number(u?.factorToBase ?? 0))
    .filter((f) => f > 1)
    .sort((a, b) => a - b);
  return levels[0] ?? 0;
}

/**
 * `"case"` — the line states its own pack (> 1); `lineInventoryDelta` converts
 *   qty/unitCost from cases to pieces.
 * `"loose"` — no pack stated, and the product has none either: today's
 *   behavior, correct — the line really is sold by the piece.
 * `"unknown"` — no pack stated (null, 0, or 1 — none of these ever mean
 *   "confirmed one piece"; a declined-to-guess scanner null is stored as 0),
 *   but the product's own pack ladder says it should have one.
 */
export function classifyBillLinePack(
  packSize: number | null | undefined,
  product: PackLadderProduct | null | undefined,
): BillLinePackClass {
  // Opus review (B743 PR A, finding 4): truncate BEFORE the > 1 check, the
  // same way vendor-bills.service.ts#billLineToPieces truncates before ever
  // converting a line — otherwise a fractional pack (a DTO-allowed 1.5)
  // classifies as a known "case" here while the actual conversion logic
  // truncates it to 1 and treats the line as NOT boxed, so the two silently
  // disagree on the exact lines this gate exists to catch.
  if (Math.trunc(Number(packSize ?? 0)) > 1) return "case";
  return productHasPackLadder(product) ? "unknown" : "loose";
}
