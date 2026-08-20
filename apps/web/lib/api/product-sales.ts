import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";

/**
 * Per-buyer sales history for the product-detail Sales card (PR-B). Backed by
 * `GET /analytics/product-sales/:productId?limit=` — see
 * `apps/api/src/analytics/analytics.service.ts getProductSales`. Reads INVOICED
 * sales only (DRAFT/VOID/WRITTEN_OFF excluded), newest first. `lineTotal`/
 * `unitPrice` are authoritative — never re-derive from qty × unitPrice (would
 * over-charge a boxed line by `unitsPerBox`).
 */
export interface ProductSaleLine {
  /** ISO issue date of the invoice this line was billed on. */
  date: string;
  invoiceId: string;
  invoiceNumber: string;
  /** Null when the invoice was raised directly rather than from an order. */
  orderId: string | null;
  /** Human order number for `orderId`; null when the invoice had no order. */
  orderNumber: string | null;
  customerId: string;
  /** Stored name — renders even for a deleted/renamed customer. */
  customerName: string;
  /** Base units (pieces) sold on this line. */
  qty: number;
  /** Sale-time box split, for "N boxes + M pcs". Null when not boxed. */
  boxes: number | null;
  pieces: number | null;
  unitsPerBox: number | null;
  /** Net price actually charged per selling unit. */
  unitPrice: number;
  /** Authoritative line total — never re-derived from qty × unitPrice. */
  lineTotal: number;
  /** Struck-through list price when this line was re-priced, else null. */
  originalPrice: number | null;
  /** True when the line carries a non-STANDARD price (override/promo/tier). */
  overridden: boolean;
}

export interface ProductSalesHistory {
  productId: string;
  lines: ProductSaleLine[];
  summary: {
    /** Number of invoiced lines. */
    count: number;
    /** Distinct buyers who bought it. */
    buyers: number;
    /** Σ base units. */
    totalQty: number;
    /** Σ line subtotals. */
    totalRevenue: number;
    /** Per-unit price extremes across the returned lines; null when empty. */
    minPrice: number | null;
    maxPrice: number | null;
    /** Revenue-weighted (Σsubtotal / Σqty), NOT a mean of the unit prices —
     *  a 100-unit sale moves this more than a 1-unit sale. Null when
     *  no units sold (e.g. a fully-credited history). */
    avgPrice: number | null;
  };
}

/** `limit` caps the returned lines (server clamps to 1-500, default 200). */
export function useProductSales(productId: string | null | undefined, limit?: number) {
  return useQuery<ProductSalesHistory>({
    queryKey: ["products", productId, "sales", limit ?? 200],
    queryFn: () =>
      apiClient
        .get(`/analytics/product-sales/${productId}`, {
          params: limit ? { limit } : undefined,
        })
        .then((r) => r.data),
    enabled: !!productId,
    staleTime: 60_000,
  });
}
