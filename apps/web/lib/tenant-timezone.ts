import { useQuery } from "@tanstack/react-query";
import { apiClient } from "./api-client";
import { startOfTenantWeek } from "./tenant-week";

/**
 * The business's own IANA zone (`TenantConfig.timezone` via GET /settings). `undefined` until it has
 * loaded (or when the server did not send one) — callers must show their loading placeholder rather than
 * a number computed in the wrong zone. Shares the ["settings"] query with the other /settings readers.
 */
export function useTenantTimeZone(enabled = true): string | undefined {
  const { data } = useQuery<{ timezone?: string | null }>({
    queryKey: ["settings"],
    queryFn: () => apiClient.get("/settings").then((r) => r.data),
    enabled,
  });
  return typeof data?.timezone === "string" && data.timezone ? data.timezone : undefined;
}

/** `shippedFrom` for the "Shipped this week" card and the orders week view: Sunday 00:00 in the
 *  business's zone, as an ISO instant; `undefined` while the zone is unknown. */
export function useShippedWeekFrom(enabled = true): string | undefined {
  const tz = useTenantTimeZone(enabled);
  return tz ? startOfTenantWeek(new Date(), tz).toISOString() : undefined;
}
