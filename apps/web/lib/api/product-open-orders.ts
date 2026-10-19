import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { ProductOpenOrders } from "@routeflow/types";
export type { ProductOpenOrderLine, ProductOpenOrders } from "@routeflow/types";

/** Open orders still to be billed for a product (staff). The server clamps `limit` to 1-500, default 200. */
export function useProductOpenOrders(productId: string | null | undefined) {
  return useQuery<ProductOpenOrders>({
    queryKey: ["products", productId, "open-orders"],
    queryFn: () => apiClient.get(`/products/${productId}/open-orders`).then((r) => r.data),
    enabled: !!productId,
    staleTime: 60_000,
  });
}
