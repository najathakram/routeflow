/**
 * Where a catalog pick list offers "add unlisted item" (the ad-hoc, non-catalog
 * line).
 *
 * Every cart/review-sheet opener on the build screens is gated on lines already
 * existing, so the catalog list is the ONLY way in with an empty cart — which is
 * exactly the case that starts an order for something the tenant doesn't stock.
 * The catalog's empty state carries the opener when nothing matches; a non-empty
 * catalog gets it as the list footer. Exactly one of the two is live at a time,
 * so they can never both render and never both vanish.
 */
export type UnlistedAffordance = "none" | "empty-state" | "list-footer";

export function unlistedAffordancePlacement(state: {
  /** Rows the list is about to render (post-search, post-category filter). */
  rowCount: number;
  /** Catalog request still in flight. */
  loading: boolean;
}): UnlistedAffordance {
  if (state.rowCount > 0) return "list-footer";
  // The spinner owns the empty slot while the catalog is in flight: offering an
  // ad-hoc line before the operator can see whether the product exists invites a
  // duplicate of something already in the catalog.
  return state.loading ? "none" : "empty-state";
}
