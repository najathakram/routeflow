import { useQuery } from "@tanstack/react-query";
import { apiClient } from "./api-client";
import { startOfTenantWeek } from "./tenant-week";

/**
 * The business's own IANA zone (`TenantConfig.timezone` via GET /settings). `zone` is `undefined` until it
 * has loaded (or when the server did not send one) — callers must show their loading/error state rather
 * than a number computed in the wrong zone. Shares the ["settings"] query with the other /settings readers.
 */
export function useTenantTimeZoneQuery(enabled = true) {
  const q = useQuery<{ timezone?: string | null }>({
    queryKey: ["settings"],
    queryFn: () => apiClient.get("/settings").then((r) => r.data),
    enabled,
  });
  const tz = q.data?.timezone;
  return {
    zone: typeof tz === "string" && tz ? tz : undefined,
    isError: q.isError,
    retry: () => void q.refetch(),
  };
}

export function useTenantTimeZone(enabled = true): string | undefined {
  return useTenantTimeZoneQuery(enabled).zone;
}

/** `shippedFrom` for the "Shipped this week" card and the orders week view: Sunday 00:00 in the
 *  business's zone, as an ISO instant; `undefined` while the zone is unknown. */
export function useShippedWeekFrom(enabled = true): string | undefined {
  return useShippedWeek(enabled).from;
}

export function useShippedWeek(enabled = true) {
  const { zone, isError, retry } = useTenantTimeZoneQuery(enabled);
  return {
    from: zone ? startOfTenantWeek(new Date(), zone).toISOString() : undefined,
    isError,
    retry,
  };
}
