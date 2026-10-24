import { useQuery } from "@tanstack/react-query";
import type { OrderSuggestionsResponse } from "@routeflow/types";
import { apiClient } from "../api-client";

/**
 * "Usually buys" + "Order again" for the staff New Order modal: the customer's top products and last
 * five orders (product + qty + unit, never a price). Staff only; nothing fetches until a customer is
 * chosen. A failure just hides the suggestions bar — it never blocks entering an order.
 */
export function useOrderSuggestions(customerId: string | null | undefined) {
  return useQuery<OrderSuggestionsResponse>({
    queryKey: ["customers", customerId, "order-suggestions"],
    queryFn: () => apiClient.get(`/customers/${customerId}/order-suggestions`).then((r) => r.data),
    enabled: !!customerId,
    staleTime: 30_000,
    retry: false,
  });
}
