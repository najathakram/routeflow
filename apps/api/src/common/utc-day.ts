/**
 * The UTC calendar day an instant falls on, as that day's 00:00:00.000Z instant (B955). Daily
 * idempotency windows and calendar-date comparisons must use the SAME day boundary as the stored
 * UTC-midnight dates; the host's local midnight (`setHours(0,0,0,0)`) shifts the window by the
 * host's offset on any non-UTC host. Railway runs UTC, so prod behaviour is unchanged.
 */
export function startOfUtcDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** ISO weekday (1 = Monday … 7 = Sunday) of the UTC calendar day an instant falls on (B955). */
export function isoWeekdayUtc(date: Date): number {
  const d = date.getUTCDay();
  return d === 0 ? 7 : d;
}
