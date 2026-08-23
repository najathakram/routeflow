/**
 * Shared calendar-date formatter for invoice/bill screens.
 *
 * `Invoice.issueDate`/`dueDate` (and the equivalent fields on recurring
 * invoices, credit notes, and scanned vendor bills) are stored as UTC-midnight
 * instants — the meaningful part is the YYYY-MM-DD, not a moment in time.
 * `new Date(iso).toLocaleDateString()` renders UTC midnight as the PREVIOUS
 * day for any negative-UTC-offset viewer, so we format the UTC components
 * directly instead (Hermes supports `toLocaleDateString` with `timeZone`).
 *
 * Do NOT use this for real timestamps (payment `paidAt`, `createdAt`,
 * `receivedAt`, `lastRunAt`, …) — those carry a meaningful time-of-day and
 * should keep rendering in the viewer's local time.
 */

export type CalendarDateStyle = "numeric" | "short";

/**
 * @param style "numeric" (default) matches the plain `toLocaleDateString()`
 *   most screens already use (device-locale numeric date, e.g. "8/21/2026").
 *   "short" matches the month/day/year style a few screens use
 *   (e.g. "Aug 21, 2026").
 */
export function fmtCalendarDate(
  iso: string | Date | null | undefined,
  style: CalendarDateStyle = "numeric",
): string {
  if (!iso) return "";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  if (style === "short") {
    return d.toLocaleDateString("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
  return d.toLocaleDateString(undefined, { timeZone: "UTC" });
}
