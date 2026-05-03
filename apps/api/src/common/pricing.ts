/**
 * Shared line-item subtotal calculation.
 *
 * `pricePerUnit` on a Product is the canonical SELLING-UNIT price the operator
 * entered. For products with `unitsPerBox > 1` the canonical selling unit is
 * one BOX (because operators almost always quote and price by the case);
 * issuing loose pieces is prorated as `pricePerUnit / unitsPerBox`.
 *
 * Historically the codebase computed `subtotal = pricePerUnit * qty` where
 * `qty` was already expanded to total pieces (boxes × unitsPerBox + pieces).
 * That over-charged boxed items by a factor of `unitsPerBox` (a single $43.75
 * box of 6 came out as $262.50). This helper centralises the correct formula
 * so orders, invoices, estimates, vendor bills and the buyer cart all agree.
 */

export interface LineSubtotalInput {
  unitPrice: number;
  /** Total qty in pieces — kept for backward compat & non-boxed products. */
  qty: number;
  /** Number of full boxes (only meaningful when unitsPerBox > 1). */
  boxes?: number | null;
  /** Loose pieces below a full box. */
  pieces?: number | null;
  /** Box size; null/1 means the product is sold as individual pieces. */
  unitsPerBox?: number | null;
}

export function computeLineSubtotal(input: LineSubtotalInput): number {
  const { unitPrice, qty, boxes, pieces, unitsPerBox } = input;
  const upb = Number(unitsPerBox ?? 0);
  const hasBoxPackaging = upb > 1;
  const boxesPiecesProvided = boxes != null || pieces != null;

  if (hasBoxPackaging && boxesPiecesProvided) {
    // unitPrice is the BOX price. One box = unitPrice; loose pieces are prorated.
    const b = Number(boxes ?? 0);
    const p = Number(pieces ?? 0);
    const boxEquivalent = b + p / upb;
    return unitPrice * boxEquivalent;
  }

  // Non-boxed product (or caller didn't split): unitPrice is per piece, qty in pieces.
  return unitPrice * qty;
}
