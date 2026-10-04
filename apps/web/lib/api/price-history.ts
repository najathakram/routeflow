import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

import type {
  PriceHistoryResponse as ApiPriceHistoryResponse,
  PriceHistoryRow,
  PriceHistorySource,
  PriceHistorySummary,
} from "@routeflow/types";

export type { PriceHistoryRow, PriceHistorySource, PriceHistorySummary };

/**
 * GET /customers/:customerId/products/:productId/price-history — what THIS customer has paid for
 * THIS product (invoiced sales, plus open not-yet-invoiced orders, labelled separately). Staff only.
 * The contract is `@routeflow/types` (price-history.ts); `references` / `aggregate` are the v1.1
 * extension (builder F), optional until that API lands.
 */
export interface PriceHistoryReferences {
  listPrice: number | null;
  tierPrice: number | null;
  /** Fraction (0.03 = +3%) of the newest sale vs the one before; null with fewer than two. */
  changeSinceLast: number | null;
}

/** Other customers' prices for the product (never names): low / typical (median) / high. */
export interface PriceHistoryAggregate {
  low: number;
  median: number;
  high: number;
  customers: number;
  unitLabel: string;
}

export interface PriceHistoryResponse extends ApiPriceHistoryResponse {
  references?: PriceHistoryReferences;
  aggregate?: PriceHistoryAggregate | null;
}

export const priceHistoryKey = (
  customerId: string | null | undefined,
  productId: string | null | undefined,
  limit: number,
) => ["customers", customerId, "products", productId, "price-history", limit] as const;

const fetchPriceHistory = (customerId: string, productId: string, limit: number) =>
  apiClient
    .get(`/customers/${customerId}/products/${productId}/price-history`, { params: { limit } })
    .then((r) => r.data as PriceHistoryResponse);

export function usePriceHistory(
  customerId: string | null | undefined,
  productId: string | null | undefined,
  enabled: boolean,
  limit = 25,
) {
  return useQuery<PriceHistoryResponse>({
    queryKey: priceHistoryKey(customerId, productId, limit),
    queryFn: () => fetchPriceHistory(customerId!, productId!, limit),
    enabled: enabled && !!customerId && !!productId,
    staleTime: 30_000,
    retry: false,
  });
}

/** Warm the cache as soon as a customer + product are known, so the panel opens with no spinner. */
export function usePrefetchPriceHistory(
  customerId: string | null | undefined,
  productId: string | null | undefined,
  limit = 25,
) {
  const qc = useQueryClient();
  React.useEffect(() => {
    if (!customerId || !productId) return;
    void qc.prefetchQuery({
      queryKey: priceHistoryKey(customerId, productId, limit),
      queryFn: () => fetchPriceHistory(customerId, productId, limit),
      staleTime: 30_000,
    });
  }, [qc, customerId, productId, limit]);
}
