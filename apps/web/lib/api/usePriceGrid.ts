import { useQuery } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { apiClient } from "../api-client";

export const priceGridKey = (productId: string) => ["products", productId, "price-grid"] as const;

/** The read-only per-unit price grid for one product (units v2). Values come from the API as-is. */
export function usePriceGrid(productId: string, enabled = true) {
  return useQuery<ProductPriceGridDto>({
    queryKey: priceGridKey(productId),
    queryFn: () => apiClient.get(`/products/${productId}/price-grid`).then((r) => r.data),
    enabled: enabled && !!productId,
    retry: (n, e) =>
      (e as { response?: { status?: number } } | null)?.response?.status !== 404 && n < 2,
  });
}
