import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Eligible orders (in-builder order picker, WP-E2) ─────────────────────────
//
// Backed by WP-E1's GET /trips/eligible-orders (apps/api/src/trips/trips.service.ts
// getEligibleOrders / EligibleOrdersResult). Server-side `checkEligibility` already
// ran — every row here is addable, so `eligible` is always `true`. The rest of the
// trip hooks (useTripEligibility, useCreateTrip, TripOrigin, …) still live in
// ./routes.ts — this file exists only for the picker's own query, per the plan's
// file list; it is not a migration of the existing trip hooks.

export interface EligibleTripOrderRow {
  orderId: string;
  orderNumber: string | null;
  customerId: string;
  customerName: string | null;
  total: number;
  itemCount: number;
  /** Calendar date (stored UTC midnight) — format with fmtCalendarDate, never formatDate/toLocaleDateString. */
  deliveryDate: string | null;
  eligible: true;
}

interface EligibleTripOrdersResponse {
  data: EligibleTripOrderRow[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export interface UseEligibleTripOrdersParams {
  search?: string;
  page?: number;
  limit?: number;
  /** Order ids already in the builder — dropped server-side so the picker only offers addable orders. */
  exclude?: string[];
}

export function useEligibleTripOrders(
  params: UseEligibleTripOrdersParams,
  options?: { enabled?: boolean },
) {
  const { search, page = 1, limit = 20, exclude } = params;
  return useQuery<EligibleTripOrdersResponse>({
    queryKey: ["trips-eligible-orders", { search: search || undefined, page, limit, exclude }],
    queryFn: () =>
      apiClient
        .get("/trips/eligible-orders", {
          params: {
            search: search || undefined,
            page,
            limit,
            exclude: exclude && exclude.length > 0 ? exclude.join(",") : undefined,
          },
        })
        .then((r) => r.data),
    // Keep the previous page's rows visible while the next page/search loads
    // instead of flashing empty — same idiom as lib/api/product-demand.ts.
    placeholderData: keepPreviousData,
    enabled: options?.enabled,
  });
}
