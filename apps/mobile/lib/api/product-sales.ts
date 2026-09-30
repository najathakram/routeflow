import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { ProductSalesHistory } from "@routeflow/types";
export type { ProductSaleLine, ProductSalesHistory, ProductSalesSummary } from "@routeflow/types";

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
