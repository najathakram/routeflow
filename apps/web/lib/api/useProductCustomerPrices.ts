import { useQuery } from "@tanstack/react-query";
import type { ProductCustomerPricesResponse } from "@routeflow/types";
import { apiClient } from "../api-client";

export const productCustomerPricesKey = (productId: string) =>
  ["products", productId, "customer-prices"] as const;

/** The customers holding set prices on one product: the planners' `customers` input (units v2, capped at 500). */
export function useProductCustomerPrices(productId: string, enabled = true) {
  return useQuery<ProductCustomerPricesResponse>({
    queryKey: productCustomerPricesKey(productId),
    queryFn: () => apiClient.get(`/products/${productId}/customer-prices`).then((r) => r.data),
    enabled: enabled && !!productId,
  });
}
