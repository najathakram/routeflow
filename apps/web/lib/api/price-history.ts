import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

import type {
  PriceHistoryAggregate,
  PriceHistoryReferences,
  PriceHistoryResponse,
  PriceHistoryRow,
  PriceHistorySource,
  PriceHistorySummary,
} from "@routeflow/types";

// The contract (rows, summaries, `references`, the `?compare=all` `aggregate`) is `@routeflow/types`
// (price-history.ts): re-exported here, never redeclared.
export type {
  PriceHistoryAggregate,
  PriceHistoryReferences,
  PriceHistoryResponse,
  PriceHistoryRow,
  PriceHistorySource,
  PriceHistorySummary,
};

export const priceHistoryKey = (
  customerId: string | null | undefined,
  productId: string | null | undefined,
  limit: number,
  excludeOrderId?: string | null,
  compare = false,
) =>
  [
    "customers",
    customerId,
    "products",
    productId,
    "price-history",
    limit,
    excludeOrderId ?? null,
    ...(compare ? (["compare"] as const) : []),
  ] as const;

/**
 * `excludeOrderId`: the order being edited, so its own price is never shown as history (hunt2 F6).
 * `compare` adds `?compare=all`: the server then returns the anonymous other-customers `aggregate`.
 */
const fetchPriceHistory = (
  customerId: string,
  productId: string,
  limit: number,
  excludeOrderId?: string | null,
  compare = false,
) =>
  apiClient
    .get(`/customers/${customerId}/products/${productId}/price-history`, {
      params: {
        limit,
        ...(excludeOrderId ? { excludeOrderId } : {}),
        ...(compare ? { compare: "all" } : {}),
      },
    })
    .then((r) => r.data as PriceHistoryResponse);

export function usePriceHistory(
  customerId: string | null | undefined,
  productId: string | null | undefined,
  enabled: boolean,
  limit = 25,
  excludeOrderId?: string | null,
  compare = false,
) {
  return useQuery<PriceHistoryResponse>({
    queryKey: priceHistoryKey(customerId, productId, limit, excludeOrderId, compare),
    queryFn: () => fetchPriceHistory(customerId!, productId!, limit, excludeOrderId, compare),
    enabled: enabled && !!customerId && !!productId,
    staleTime: 30_000,
    retry: false,
    // NO placeholderData: it ignores `enabled`, so a changed customer would keep showing the previous
    // customer's prices (and their "use this price" chips) while the new query is pending or disabled.
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
  excludeOrderId?: string | null,
) {
  const qc = useQueryClient();
  React.useEffect(() => {
    if (!enabled || !customerId || !productId) return;
    void qc.prefetchQuery({
      queryKey: priceHistoryKey(customerId, productId, limit, excludeOrderId),
      queryFn: () => fetchPriceHistory(customerId, productId, limit, excludeOrderId),
      staleTime: 30_000,
    });
  }, [qc, customerId, productId, limit, enabled, excludeOrderId]);
}
