import { useQuery } from "@tanstack/react-query";
import type { CustomerPriceLayerResponse } from "@routeflow/types";
import {
  priceLayerStatus,
  type CustomerLayerUnit,
  type PriceLayerStatus,
} from "@routeflow/pricing";
import { apiClient } from "../api-client";
import { useSubscription } from "./billing";

/** The plan flag that gates the units v2 prices (same key as the web `PRICES_V2_FLAG`). */
export const PRICES_V2_FLAG = "flag.units_prices_v2";

/** Does the tenant's subscription serve `flag.units_prices_v2`? FAIL-CLOSED: an unknown answer is "off" (no request, master's chain). */
export function usePricesV2Enabled(): boolean {
  const q = useSubscription();
  return ((q.data?.flags ?? []) as readonly string[]).includes(PRICES_V2_FLAG);
}

/**
 * S19b A0 (SA-811a, SA-813): the customer's price layer, billing's own resolved rows. Same contract as the web hook: key
 * ["customers", id, "price-layer"], staleTime 0, refetch on mount and focus, no request when the flag is off; while pending or
 * failed prices are UNCONFIRMED (disable Create/Save/Send until `ready`, per product via `lineReady`).
 */
export const priceLayerKey = (customerId: string) =>
  ["customers", customerId, "price-layer"] as const;

export interface CustomerPriceLayer extends PriceLayerStatus {
  layerOf(productId: string | null | undefined): readonly CustomerLayerUnit[] | undefined;
  /** The raw read (memo deps track it, not just `ready`). */
  data: CustomerPriceLayerResponse | undefined;
  error: unknown;
  refetch: () => void;
}

export function useCustomerPriceLayer(customerId: string | null | undefined): CustomerPriceLayer {
  const pricesV2 = usePricesV2Enabled();
  const enabled = pricesV2 && !!customerId;
  const q = useQuery<CustomerPriceLayerResponse>({
    queryKey: priceLayerKey(customerId ?? ""),
    queryFn: () => apiClient.get(`/customers/${customerId}/price-layer`).then((r) => r.data),
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const status = priceLayerStatus({
    enabled,
    isPending: q.isPending,
    isError: q.isError,
    data: q.data,
  });
  return {
    ...status,
    layerOf: (productId) => (enabled && productId ? q.data?.products[productId] : undefined),
    data: q.data,
    error: q.error,
    refetch: () => void q.refetch(),
  };
}
