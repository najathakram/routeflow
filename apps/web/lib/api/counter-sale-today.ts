// `GET /orders/counter-sale/today?page=N`: today's counter sales, newest first. The shapes are the server's
// (`@routeflow/types`); page 1 carries `summary`, later pages have `summary: null`.
import { useInfiniteQuery } from "@tanstack/react-query";
import type { TodaysSalesResponse } from "@routeflow/types";
import { apiClient } from "../api-client";

/** Under ["orders"], so a completed counter sale (which invalidates ["orders"]) refreshes the sheet with no extra wiring. */
export const COUNTER_SALE_TODAY_KEY = ["orders", "counter-sale-today"] as const;

export function useCounterSaleToday(enabled = true) {
  return useInfiniteQuery<TodaysSalesResponse>({
    queryKey: COUNTER_SALE_TODAY_KEY,
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      apiClient
        .get<TodaysSalesResponse>("/orders/counter-sale/today", { params: { page: pageParam } })
        .then((r) => r.data),
    getNextPageParam: (last) =>
      last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined,
    enabled,
  });
}
