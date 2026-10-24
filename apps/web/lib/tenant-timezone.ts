import { useQuery } from "@tanstack/react-query";
import { apiClient } from "./api-client";
import { calendarDayInZone } from "./calendar-date";
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

/**
 * The business's own "today" (YYYY-MM-DD) in its zone, for a check that must agree with the API's tenant day (row 735:
 * the Create Order past-date check). `undefined` until the zone is known: the caller must not fall back to the BROWSER's
 * day (it can be a different day than the business's) - the server stays the authority until the zone arrives.
 * Derived at every render from the clock, so the day rolls over without a refetch.
 */
export function useTenantToday(enabled = true): string | undefined {
  const zone = useTenantTimeZone(enabled);
  return zone ? calendarDayInZone(zone) : undefined;
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

/**
 * SA-943 (W-765): the default for a payment / settled / received date box - the BUSINESS's today in its zone, so the
 * API (which reads a date-only tenant-local today as "now") never sees yesterday's UTC day or tomorrow's. While the zone
 * is still loading it falls back to the browser's LOCAL day, never the UTC day (`todayIso()` is `toISOString()`: after
 * 19:00 CDT that is already tomorrow). Pinned by `payment-date-defaults.inventory.test.ts`.
 */
export function tenantTodayIso(zone: string | undefined, now: Date = new Date()): string {
  return zone ? calendarDayInZone(zone, now) : localDay(now);
}

/**
 * SA-943 MUST 2: a stored payment instant as the date its edit box shows - the tenant-local day, the same day the API's
 * "kept" rule compares against, so resending it unchanged keeps the stored instant. "" for no instant.
 */
export function tenantDateOf(iso: string | null | undefined, zone: string | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  return zone ? calendarDayInZone(zone, at) : localDay(at);
}

function localDay(d: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
