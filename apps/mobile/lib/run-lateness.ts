import { calendarDateFromIso } from "./calendar-date";

/**
 * Late-route predicate for the operator Exceptions screen — extracted verbatim from
 * `app/(operator)/exceptions.tsx`'s late-route loop (see B90) so it is directly testable.
 * `now` replaces the inline `new Date()` so the caller controls "current time" in tests;
 * the comparison itself is unchanged.
 *
 * `scheduledDateIso` is a calendar-date field (UTC-midnight storage convention), so its
 * calendar day is read via `calendarDateFromIso` — never floored through the runtime's
 * local clock, which used to read a UTC-midnight instant as the PREVIOUS calendar day for
 * any negative-UTC-offset viewer (B90). "Today" is the viewer's own local day: when
 * `timeZone` is supplied it drives "today" via `Intl.DateTimeFormat` (so a test — or a
 * future caller that knows the viewer's IANA zone — controls the result on every host);
 * omitted, it falls back to the device's own local day (`localYmd`), since that is
 * genuinely what "today" means to whoever is holding the device.
 */
function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ymdInZone(now: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    if (!y || !m || !day) return localYmd(now);
    return `${y}-${m}-${day}`;
  } catch {
    return localYmd(now);
  }
}

export function isRunPastDue(scheduledDateIso: string, now: Date, timeZone?: string): boolean {
  const today = timeZone ? ymdInZone(now, timeZone) : localYmd(now);
  return calendarDateFromIso(scheduledDateIso) < today;
}
