/**
 * NEW-rweb-7: Parse a UTC ISO datetime string as a local calendar date.
 *
 * Problem: `new Date("2026-04-30T00:00:00.000Z")` in America/New_York (UTC-5)
 * produces 2026-04-29 (previous day), making scheduled-date labels show
 * "yesterday" to drivers and operators.
 *
 * Fix: extract only the YYYY-MM-DD portion and parse it as a local date
 * by using "/" separators, which browsers/JSCore treat as local time.
 *
 * @param isoOrDateStr ISO-8601 string (e.g. "2026-04-30T00:00:00.000Z") OR
 *                     plain date string "2026-04-30".
 * @returns Date object representing midnight LOCAL time on that calendar date.
 */
export function parseLocalDate(isoOrDateStr: string): Date {
  // Extract the date-only portion (first 10 chars: "YYYY-MM-DD")
  const datePart = isoOrDateStr.slice(0, 10);
  // Replace hyphens with slashes → browsers parse "YYYY/MM/DD" as LOCAL time
  return new Date(datePart.replace(/-/g, "/"));
}
