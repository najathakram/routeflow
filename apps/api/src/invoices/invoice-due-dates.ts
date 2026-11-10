import { calendarFieldStamp, tenantTodayDay } from "../common/calendar-date";
import { tenantTimeZone } from "../common/tenant-time-zone";

export { calendarFieldStamp };

/**
 * #2256: an optional client due date → the UTC-midnight stamp of the literal day it names (the
 * #2197 issueDate rule), null when absent; 400 naming `field` when it names no real day. Never
 * `new Date(raw)`, whose offset moves the day.
 */
export function dueStamp(raw: string | null | undefined, field: string): Date | null {
  return raw ? calendarFieldStamp(raw, field) : null;
}

/** #2256: both client due dates of an invoice write, validated together before any read. */
export function dueDateStamps(d: { dueDate?: string | null; depositDueDate?: string | null }) {
  return {
    dueDate: dueStamp(d.dueDate, "dueDate"),
    depositDueDate: dueStamp(d.depositDueDate, "depositDueDate"),
  };
}

/**
 * W-1188: the year segment of an invoice number is the tenant's calendar year at mint time (entry sequence, entry
 * year; never the issue year). Read through the caller's tx when it has one, so this never asks the pool for a second
 * connection while that tx holds one.
 */
export async function numberYear(db: any, tenantId?: string | null): Promise<number> {
  const zone = await tenantTimeZone(db, { tenantId: tenantId ?? null });
  return Number(tenantTodayDay(zone).slice(0, 4));
}
