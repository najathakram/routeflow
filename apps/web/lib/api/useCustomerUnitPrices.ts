import { useQuery } from "@tanstack/react-query";
import type { CustomerUnitPricesResponse } from "@routeflow/types";
import { apiClient } from "../api-client";

export const customerUnitPricesKey = (customerId: string, productId?: string, page = 1) =>
  ["customers", customerId, "unit-prices", productId ?? null, page] as const;

/**
 * What one customer pays per unit (units v2, flag.units_prices_v2). Read-only. `customerId` null = nobody chosen yet, so
 * nothing is fetched. `productId` narrows to one product (the product-page Customer view).
 */
export function useCustomerUnitPrices(
  customerId: string | null,
  productId?: string,
  opts?: { page?: number; limit?: number },
) {
  const page = opts?.page ?? 1;
  return useQuery<CustomerUnitPricesResponse>({
    queryKey: customerUnitPricesKey(customerId ?? "", productId, page),
    queryFn: () =>
      apiClient
        .get(`/customers/${customerId}/unit-prices`, {
          params: { productId, page: page > 1 ? page : undefined, limit: opts?.limit },
        })
        .then((r) => r.data),
    enabled: !!customerId,
    retry: (n, e) =>
      (e as { response?: { status?: number } } | null)?.response?.status !== 404 && n < 2,
  });
}
