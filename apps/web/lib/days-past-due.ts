import { calendarDateFromIso } from "./calendar-date";

/**
 * Whole calendar days an invoice is past its DUE date, counted on the business's own calendar: `tenantDay` is the
 * tenant's "today" (`useTenantToday`, YYYY-MM-DD), `dueDate` the stored UTC-midnight calendar date. Both are read as
 * plain calendar days, so the browser's zone never moves the count. 0 = due today or not yet due; no due date = 0.
 */
export function daysPastDue(tenantDay: string, dueDate: string | null | undefined): number {
  const due = calendarDateFromIso(dueDate);
  if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(tenantDay)) return 0;
  const diff = Math.round(
    (Date.parse(`${tenantDay}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000,
  );
  return diff > 0 ? diff : 0;
}
