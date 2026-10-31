/**
 * SA-1002 (W-925): the ONE rule for "low stock". Every reader that decides it (the products list filter and its ids / CSV
 * twins, the web dashboard panel) uses this predicate, and the SQL prefetch in apps/api/src/products/low-stock-ids.ts is
 * the same rule pinned to LOW_STOCK_DEFAULT by a spec.
 *
 * LOW is `isActive && stock <= (reorderPoint ?? LOW_STOCK_DEFAULT)`, inclusive (reorder when stock REACHES the point), and
 * it includes an active product at or below zero. Out-of-stock is the stricter, separate question (stock <= 0 or inactive).
 */

/** The threshold of a product with no reorder point: today's list threshold, so a tenant that never set one sees no change. */
export const LOW_STOCK_DEFAULT = 5;

/** "OUT" is only an inactive product here; an active product at or below zero is still LOW (SA-1002: keeps the mobile home count). */
export type StockLevel = "OUT" | "LOW" | "IN" | "UNKNOWN";

/** The low-stock threshold of a product: its reorder point when it has one, else the default. */
export function lowStockThreshold(reorderPoint: number | null | undefined): number {
  return reorderPoint ?? LOW_STOCK_DEFAULT;
}

/**
 * Where a product stands. `stock` and `reorderPoint` are numbers (convert a Decimal string first). A stock that is not a finite
 * number, or a negative reorder point, is "UNKNOWN": the caller shows no level rather than a made-up one. An inactive product is
 * "OUT" (it is not for sale), matching the list's out-of-stock filter.
 */
export function stockLevel(
  stock: number,
  reorderPoint: number | null | undefined,
  isActive: boolean,
): StockLevel {
  if (!Number.isFinite(stock)) return "UNKNOWN";
  if (reorderPoint != null && (!Number.isFinite(reorderPoint) || reorderPoint < 0))
    return "UNKNOWN";
  if (!isActive) return "OUT";
  if (stock <= lowStockThreshold(reorderPoint)) return "LOW";
  return "IN";
}

/** LOW as the list filter and the dashboard panel mean it: active, and at or below its threshold (zero and below included). */
export function isLowStock(
  stock: number,
  reorderPoint: number | null | undefined,
  isActive: boolean,
): boolean {
  return isActive && stockLevel(stock, reorderPoint, isActive) === "LOW";
}
