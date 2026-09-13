/**
 * Formats a stored calendar-date value (a UTC-midnight ISO instant, e.g.
 * "2026-09-01T00:00:00.000Z", or a bare calendar-date string "2026-09-01")
 * into a human-readable date like "Sep 1, 2026".
 *
 * Always reads the date in UTC — never the host's local timezone — so a
 * UTC-midnight instant is never shifted onto the previous local day (e.g. in
 * a UTC-6 or later timezone, `new Date(...).toLocaleDateString()` without a
 * pinned `timeZone` would render "Aug 31, 2026" for the value above).
 *
 * Returns `""` for null, undefined, or an unparsable date.
 */
export function formatDateOnly(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

export default formatDateOnly;
