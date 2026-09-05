/**
 * Pure logic seam for EditRunModal (B59 fix — bug-test-plan.md T1/T2).
 */

import { calendarDateFromIso } from "@/lib/calendar-date";

/**
 * `scheduledDate` is a UTC-midnight calendar-date field — pre-filling the
 * modal must read it as a calendar day (`calendarDateFromIso`), never through
 * local calendar-component getters, which mis-render it as the previous day
 * for negative-UTC-offset viewers (B59).
 *
 * A calendar date has no zone — the read side never takes one.
 */
export function readCalendarInput(scheduledDate: string): string {
  return calendarDateFromIso(scheduledDate);
}

/**
 * Only sets `scheduledDate` on the PATCH body when the date field actually
 * changed from its seeded `initialDate` — otherwise merely opening Edit Route
 * Run and saving an unrelated field (e.g. driver) silently rewrites the run's
 * date (B59).
 */
export function buildRunPatchBody(args: {
  id: string;
  driverId: string;
  initialDriverId: string;
  date: string;
  initialDate: string;
  notes: string;
  isInProgress: boolean;
}): { id: string; driverId?: string | null; scheduledDate?: string; notes: string } {
  const { id, driverId, initialDriverId, date, initialDate, notes, isInProgress } = args;
  const body: { id: string; driverId?: string | null; scheduledDate?: string; notes: string } = {
    id,
    notes,
  };
  if (driverId !== initialDriverId) body.driverId = driverId || null;
  if (!isInProgress && date !== initialDate) body.scheduledDate = date;
  return body;
}
