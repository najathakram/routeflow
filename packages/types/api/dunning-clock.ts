/**
 * SA-1037 r2 PR-6: the dunning clock, in ONE place for the web. A failed payment starts the clock (`pastDueSince`);
 * the owner chose "retry, remind, pause at 14 days" (05:21Z), which supersedes the day-7 pause of D-2026-10-08.
 *
 * The API keeps its own literals in `apps/api/src/billing/dunning-config.ts`; `dunning-clock-parity.spec.ts` pins them
 * equal to this object (L-261), so a clock moved on one side fails a spec instead of misdating a banner.
 */
const PAUSE_HOURS = 336;
const FINAL_LEAD_HOURS = 24;

export const DUNNING_CLOCK = {
  /** The d3 reminder is due at +72 h. */
  d3Hours: 72,
  /** The d7 reminder (the d3 copy) is due at +168 h: no ten-day silence before the last day. */
  d7Hours: 168,
  /** The last-day notice ("read-only tomorrow") is due the final-notice lead before the pause: +312 h. */
  lastDayHours: PAUSE_HOURS - FINAL_LEAD_HOURS,
  /** The final notice goes out at least this many hours before a pause. */
  finalLeadHours: FINAL_LEAD_HOURS,
  /** Hours from the first failure until the tenant may be paused: day 14. */
  pauseHours: PAUSE_HOURS,
  /** The grace window in days: the date the copy asks the admin to update by. */
  graceDays: PAUSE_HOURS / 24,
} as const;
