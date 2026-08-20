import type { ProductSaleLine, ProductSalesSummary } from "./api/product-sales";

/**
 * Pure helpers for the product detail "Sales" card (PR-B). Extracted so the
 * summary strip and row tap-through rules are tested without mounting the
 * screen — mirrors lib/customer-order-filter.ts.
 */

/** `$1,234.56`-style formatting for the summary strip and row prices. */
function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Compact "buyers · qty · price range" line shown above the Sales card rows.
 * Falls back to a shorter form when there's no price data yet (zero-sales,
 * or every line credited to $0). A single distinct price collapses the
 * min–max range to one number instead of "$5.00–$5.00".
 */
export function productSalesSummaryLine(summary: ProductSalesSummary): string {
  const buyers = `${summary.buyers} buyer${summary.buyers === 1 ? "" : "s"}`;
  const qty = `${summary.totalQty} sold`;
  if (summary.minPrice == null || summary.maxPrice == null || summary.avgPrice == null) {
    return `${buyers} · ${qty}`;
  }
  const range =
    summary.minPrice === summary.maxPrice
      ? money(summary.minPrice)
      : `${money(summary.minPrice)}–${money(summary.maxPrice)}`;
  return `${buyers} · ${qty} · ${range} avg ${money(summary.avgPrice)}`;
}

export type ProductSaleRowTarget =
  | { screen: "order"; id: string }
  | { screen: "invoice"; id: string };

/**
 * Where a Sales-card row navigates on tap. `orderId` is null for invoices cut
 * without a backing order (e.g. a manual/POS invoice) — those fall back to
 * the invoice detail, which always exists for a returned line.
 */
export function productSaleRowTarget(
  line: Pick<ProductSaleLine, "orderId" | "invoiceId">,
): ProductSaleRowTarget {
  return line.orderId
    ? { screen: "order", id: line.orderId }
    : { screen: "invoice", id: line.invoiceId };
}
