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
  PriceSummaryEntry,
  PriceSummaryResponse,
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
  PriceSummaryEntry,
  PriceSummaryResponse,
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

/** The endpoint refuses more than this many distinct product ids per request. */
export const PRICE_SUMMARY_MAX_IDS = 50;

export const priceSummaryKey = (
  customerId: string | null | undefined,
  sortedIds: readonly string[],
  excludeOrderId?: string | null,
) => ["customers", customerId, "price-summary", sortedIds, excludeOrderId ?? null] as const;

const fetchPriceSummary = async (
  customerId: string,
  sortedIds: readonly string[],
  excludeOrderId?: string | null,
): Promise<PriceSummaryResponse> => {
  const chunks: string[][] = [];
  for (let i = 0; i < sortedIds.length; i += PRICE_SUMMARY_MAX_IDS) {
    chunks.push(sortedIds.slice(i, i + PRICE_SUMMARY_MAX_IDS));
  }
  const parts = await Promise.all(
    chunks.map((ids) =>
      apiClient
        .get(`/customers/${customerId}/price-summary`, {
          params: {
            productIds: ids.join(","),
            ...(excludeOrderId ? { excludeOrderId } : {}),
          },
        })
        .then((r) => r.data as PriceSummaryResponse),
    ),
  );
  return Object.assign({}, ...parts) as PriceSummaryResponse;
};

/**
 * ONE batched request for every line's "Recent prices" chips (replaces a price-history request per
 * line). Ids are de-duplicated and sorted so the key is stable across line reordering; more than 50
 * ids are chunked into <= 50-id requests and merged. `excludeOrderId`: the order being edited.
 */
export function usePriceSummary(
  customerId: string | null | undefined,
  productIds: readonly (string | null | undefined)[],
  excludeOrderId?: string | null,
) {
  const idKey = Array.from(new Set(productIds.filter((id): id is string => !!id)))
    .sort()
    .join(",");
  const sortedIds = React.useMemo(() => (idKey ? idKey.split(",") : []), [idKey]);
  return useQuery<PriceSummaryResponse>({
    queryKey: priceSummaryKey(customerId, sortedIds, excludeOrderId),
    queryFn: () => fetchPriceSummary(customerId!, sortedIds, excludeOrderId),
    enabled: !!customerId && sortedIds.length > 0,
    staleTime: 30_000,
    retry: false,
    // NO placeholderData (same reason as usePriceHistory): a changed customer must not show the
    // previous customer's prices or their "use this price" chips.
  });
}
