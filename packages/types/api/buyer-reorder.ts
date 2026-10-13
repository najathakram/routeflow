/**
 * `POST /buyer/templates/:id/reorder` (portal limits, lane A): a buyer's Reorder leaves out the lines a
 * selling restriction hides from this buyer and orders the rest. The reason never reaches the buyer
 * (staff-only), just the product and its name, so the portal can say "2 items aren't available to you
 * and were left out." Empty (or absent) when nothing was left out.
 */
export interface BuyerReorderSkippedLine {
  productId: string;
  name: string;
}

/** The customer-facing order the reorder placed, plus the lines that were left out. */
export interface BuyerReorderSkipped {
  skipped: BuyerReorderSkippedLine[];
}
