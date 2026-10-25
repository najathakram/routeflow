import * as React from "react";
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

/**
 * Seed a date field with the tenant's day, ONCE, when it first resolves (SA-964 §4). `apply(day)` should write only into a
 * field nobody has filled (`setDate((cur) => cur || day)`): the field starts empty, so nothing is shown or saved on the
 * browser's day while the zone loads, and a value the user typed meanwhile is never overwritten. Returns the tenant's day
 * (or `undefined` while unknown) for display comparisons.
 */
export function useOnTenantToday(apply: (day: string) => void, enabled = true): string | undefined {
  const today = useTenantToday(enabled);
  const applied = React.useRef(false);
  const latest = React.useRef(apply);
  latest.current = apply;
  React.useEffect(() => {
    if (today && !applied.current) {
      applied.current = true;
      latest.current(today);
    }
  }, [today]);
  return today;
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
