import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";

/**
 * PR-B: per-buyer sales history for the product detail "Sales" card. Backed by
 * `GET /analytics/product-sales/:productId` (analytics.service.ts `getProductSales`),
 * which reads INVOICED sales through `Invoice.findMany` — StockMovement SALE is dead,
 * never read it (the invoiced-sales lesson). Lines are newest-first; `avgPrice` is
 * revenue-weighted (Σsubtotal/Σqty). Mirrors apps/web's PR-B hook (web half not yet
 * built) and the sibling `useCostHistory` in this directory.
 */
export interface ProductSaleLine {
  date: string; // ISO
  invoiceId: string;
  invoiceNumber: string;
  orderId: string | null;
  /** Human order number for `orderId`; null when the invoice had no order. */
  orderNumber: string | null;
  customerId: string;
  customerName: string;
  qty: number;
  boxes: number | null;
  pieces: number | null;
  unitsPerBox: number | null;
  unitPrice: number;
  lineTotal: number;
  originalPrice: number | null;
  overridden: boolean;
}

export interface ProductSalesSummary {
  count: number;
  buyers: number;
  totalQty: number;
  totalRevenue: number;
  minPrice: number | null;
  maxPrice: number | null;
  avgPrice: number | null;
}

export interface ProductSalesHistory {
  productId: string;
  lines: ProductSaleLine[];
  summary: ProductSalesSummary;
}

/** `limit` is clamped server-side to 1-500 (default 200) — see analytics.controller.ts. */
export function useProductSales(productId: string | null | undefined, limit?: number) {
  return useQuery<ProductSalesHistory>({
    queryKey: ["products", productId, "sales", limit],
    queryFn: () =>
      apiClient
        .get(`/analytics/product-sales/${productId}`, {
          params: limit != null ? { limit } : undefined,
        })
        .then((r) => r.data),
    enabled: !!productId,
    staleTime: 60_000,
  });
}
