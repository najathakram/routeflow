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

/**
 * SA-1067 Z4: "UTC" is the fallback the API writes when nobody picked a zone (`FALLBACK_ZONE`), so it is the one value that
 * means "not set yet". An unknown zone (still loading, or none sent) is NOT unset: nothing should flash before /settings answers.
 */
export function isZoneUnset(zone: string | undefined): boolean {
  return zone === "UTC";
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

/**
 * SA-943 (W-765): the default for a payment / settled / received date box - the BUSINESS's today in its zone, so the
 * API (which reads a date-only tenant-local today as "now") never sees yesterday's UTC day or tomorrow's. With no zone
 * (still loading, or none on file) it is the UTC day: the SAME fallback the API applies to a business without a zone, so
 * the box and the server always name the same day. Never the browser's day - for a business with no zone a Chicago
 * browser at 20:00 CDT would send 10-24, which the UTC-zoned server stores as 10-24T00:00Z, 20 hours early. A box
 * defaulted while the zone was loading moves to the zone's day when it arrives (`useResyncOnZone`). Pinned by
 * `payment-date-defaults.inventory.test.ts`.
 */
export function tenantTodayIso(zone: string | undefined, now: Date = new Date()): string {
  return zone ? calendarDayInZone(zone, now) : utcDay(now);
}

/**
 * SA-943 MUST 2: a stored payment instant as the date its edit box shows - the tenant-local day, the same day the API's
 * "kept" rule compares against, so resending it unchanged keeps the stored instant. "" for no instant. With no zone it
 * is the UTC day, the server's own fallback for that comparison.
 */
export function tenantDateOf(iso: string | null | undefined, zone: string | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  return zone ? calendarDayInZone(zone, at) : utcDay(at);
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * SA-943: keeps a date box that was defaulted from `defaultFor(zone)` in step with the zone. When the zone arrives (or
 * changes) and the box still holds the default computed under the previous zone, it moves to the new zone's default;
 * a date the user typed is never touched. Known edge: a typed date EQUAL to the previous default is indistinguishable
 * from the default and does move (only possible in the brief window before the zone loads).
 */
export function useResyncOnZone(
  zone: string | undefined,
  defaultFor: (zone: string | undefined) => string,
  current: string,
  apply: (next: string) => void,
): void {
  const prevZone = React.useRef(zone);
  React.useEffect(() => {
    if (prevZone.current === zone) return;
    const before = defaultFor(prevZone.current);
    prevZone.current = zone;
    const next = defaultFor(zone);
    if (current === before && next !== before) apply(next);
  }, [zone, defaultFor, current, apply]);
}
