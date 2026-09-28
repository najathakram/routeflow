import { calendarFieldStamp } from "../common/calendar-date";

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
