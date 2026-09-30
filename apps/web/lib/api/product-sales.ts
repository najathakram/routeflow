import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { ProductSalesHistory } from "@routeflow/types";
export type { ProductSaleLine, ProductSalesHistory } from "@routeflow/types";

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
