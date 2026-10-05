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

/**
 * Background (mount-time) history fetches are budgeted: a big order mounts one price-history button
 * and one chip row per line, and the API throttle is 100 requests/min/IP shared by every operator
 * behind a shop's NAT. Only the first AUTO_FETCH_BUDGET distinct (customer, product) lines fetch on
 * mount; every other line fetches when its popover opens. A line's button and chips share one slot.
 */
export const AUTO_FETCH_BUDGET = 5;
const slotRefs = new Map<string, number>();

export function useAutoFetchSlot(
  customerId: string | null | undefined,
  productId: string | null | undefined,
): boolean {
  const key = customerId && productId ? `${customerId}:${productId}` : null;
  const [granted, setGranted] = React.useState(false);
  React.useEffect(() => {
    if (!key) {
      setGranted(false);
      return;
    }
    if (!slotRefs.has(key) && slotRefs.size >= AUTO_FETCH_BUDGET) {
      setGranted(false);
      return;
    }
    slotRefs.set(key, (slotRefs.get(key) ?? 0) + 1);
    setGranted(true);
    return () => {
      const n = (slotRefs.get(key) ?? 1) - 1;
      if (n <= 0) slotRefs.delete(key);
      else slotRefs.set(key, n);
    };
  }, [key]);
  return granted;
}

/** Warm the cache as soon as a customer + product are known, so the panel opens with no spinner. */
export function usePrefetchPriceHistory(
  customerId: string | null | undefined,
  productId: string | null | undefined,
  limit = 25,
  enabled = true,
) {
  const qc = useQueryClient();
  React.useEffect(() => {
    if (!enabled || !customerId || !productId) return;
    void qc.prefetchQuery({
      queryKey: priceHistoryKey(customerId, productId, limit),
      queryFn: () => fetchPriceHistory(customerId, productId, limit),
      staleTime: 30_000,
    });
  }, [qc, customerId, productId, limit, enabled]);
}
