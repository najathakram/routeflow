import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import type { CustomerPriceLayerResponse } from "@routeflow/types";
import {
  priceLayerStatus,
  type CustomerLayerUnit,
  type PriceLayerStatus,
} from "@routeflow/pricing";
import { apiClient } from "../api-client";
import { usePricesV2Enabled } from "./units-v2";

/**
 * S19b A0 (SA-811a, SA-813): the customer's price layer for order, invoice and estimate surfaces. The server returns billing's
 * own resolved rows (`GET /customers/:id/price-layer`), so no ladder is evaluated here: pick a line's row with
 * `customerLinePrice({ product, tier, layer: layerOf(productId), unitLabel })`.
 *
 * Flag off (or no customer): NO request, `layerOf` is undefined for every product and every site runs master's chain.
 * Flag on: staleTime 0 and refetch on mount and on focus, so an opened surface always reads the current layer. While it is
 * pending or failed prices are UNCONFIRMED (M3): disable Create/Save/Send until `ready`, per product via `lineReady`.
 */
export const priceLayerKey = (customerId: string) =>
  ["customers", customerId, "price-layer"] as const;

export interface CustomerPriceLayer extends PriceLayerStatus {
  /** `response.products[productId]`; undefined flag-off, with no layer, or while unconfirmed. */
  layerOf(productId: string | null | undefined): readonly CustomerLayerUnit[] | undefined;
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
  // Stable identities (integration review SHOULD 2): a page keeps this object (and `layerOf`) in useCallback / useMemo deps,
  // so they change only when the read itself changes, never on an unrelated re-render.
  const { isPending, isError, isFetching, data, error, refetch: queryRefetch } = q;
  const status = React.useMemo(
    () => priceLayerStatus({ enabled, isPending, isError, isFetching, data }),
    [enabled, isPending, isError, isFetching, data],
  );
  const layerOf = React.useCallback<CustomerPriceLayer["layerOf"]>(
    (productId) => (enabled && productId ? data?.products[productId] : undefined),
    [enabled, data],
  );
  const refetch = React.useCallback(() => void queryRefetch(), [queryRefetch]);
  return React.useMemo(
    () => ({ ...status, layerOf, error, refetch }),
    [status, layerOf, error, refetch],
  );
}
