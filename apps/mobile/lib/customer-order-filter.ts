/**
 * Pure logic for the entity-scoped filter chips on the operator Orders list
 * (A3 cross-link: the customer detail screen's "View orders" pushes
 * `?customerId=`, which the orders list must read, forward to `useAdminOrders`,
 * and surface as a dismissible chip). Extracted so the derive/dismiss rules are
 * tested without mounting the screen — mirrors lib/product-search-params.ts.
 *
 * PR-B (2026-08-19) extends the same pattern for `?productId=` (the product
 * detail Sales card's "View orders" link) rather than inventing a second
 * mechanism — the two filters are independent: each has its own state, its
 * own route param, and its own dismiss, and both chips can be active at once.
 */

/** Read the `customerId` search param into filter state. Blank/whitespace → no filter. */
export function resolveCustomerIdParam(customerId?: string | null): string | null {
  const trimmed = customerId?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Label for the dismissible "Customer: X" chip. The customer record can still be
 * loading (or, for a stale/deleted id, missing) when the chip first renders, so
 * it falls back to a neutral placeholder rather than showing "Customer: undefined".
 */
export function customerFilterChipLabel(customerName?: string | null): string {
  const trimmed = customerName?.trim();
  return `Customer: ${trimmed || "…"}`;
}

/** Read the `productId` search param into filter state. Blank/whitespace → no filter. */
export function resolveProductIdParam(productId?: string | null): string | null {
  const trimmed = productId?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Label for the dismissible "Product: X" chip — same loading/missing fallback
 * as `customerFilterChipLabel`.
 */
export function productFilterChipLabel(productName?: string | null): string {
  const trimmed = productName?.trim();
  return `Product: ${trimmed || "…"}`;
}
