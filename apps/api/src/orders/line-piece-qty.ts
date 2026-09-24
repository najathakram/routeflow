/**
 * RF-4: the piece count a per-unit category tax multiplies. Box-split lines
 * store `qty` already in pieces; a boxed selling-unit line (boxes null) stores
 * `qty` in SELLING UNITS, so expand it by the snapshot `unitsPerBox`. PER_VOLUME
 * stays approximate (pieces, not true volume) until a `Product.volumePerUnit`
 * field lands — see computeCategoryTax's contract.
 */
export function linePieceQty(
  li: { qty: unknown; boxes: unknown; unitsPerBox?: unknown },
  unitsPerBoxFallback?: number,
): number {
  const qty = Number(li.qty) || 0;
  if (li.boxes != null) return qty; // already pieces
  // A boxed product ordered as SELLING UNITS stores unitsPerBox:null on the line
  // (create only snapshots it for box-split lines), so fall back to the product's
  // unitsPerBox — otherwise a per-unit levy collapses by a factor of unitsPerBox on
  // any later edit (create expanded qty→pieces but the recompute couldn't).
  // B661-sweep: a line-tax (not ledger) box-unaware multiply — follow-up PR converts this to
  // @routeflow/pricing's regulatedUnitBasis; see no-second-legacy-line-pieces.spec.ts's allowlist.
  const upb = Number(li.unitsPerBox ?? unitsPerBoxFallback ?? 0);
  return upb > 1 ? qty * upb : qty;
}
