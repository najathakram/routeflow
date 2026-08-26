/**
 * Shared formatting utilities.
 * Import from "@/lib/formatting" instead of redefining per-file.
 */

/** Format number as USD currency, e.g. $1,234.56 */
export function fmt(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/** Format number as USD without cents, e.g. $1,235 */
export function fmtShort(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return fmt(n);
}

/**
 * Format a real timestamp (`createdAt`, `paidAt`, `settledAt`, …) as "Mar 30, 2026"
 * in the VIEWER'S LOCAL timezone. Returns "\u2014" for null/invalid.
 *
 * For a calendar date stored at UTC midnight (`issueDate`, `dueDate`, `billDate`,
 * `expiresAt`, …) use `fmtCalendarDate` instead — local formatting renders UTC
 * midnight as the PREVIOUS day for any negative-UTC-offset viewer.
 */
export function fmtDate(d?: string | null): string {
  if (!d) return "\u2014";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "\u2014";
  return dt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Format a CALENDAR date as "Mar 30, 2026". Returns "\u2014" for null/invalid.
 *
 * Calendar dates (issueDate, dueDate, billDate, expiresAt, …) are stored at UTC
 * midnight — the meaningful part is the YYYY-MM-DD, not a moment in time. Formatting
 * them in the viewer's local timezone would render UTC midnight as the PREVIOUS day
 * for any negative-UTC-offset viewer (all of the Americas), so we format the UTC
 * calendar components directly via `timeZone: "UTC"`.
 *
 * Do NOT use this for real timestamps (`createdAt`, `paidAt`, `settledAt`, `startedAt`,
 * …) — those carry a meaningful time-of-day and must keep rendering in local time,
 * otherwise an evening event lands on the next calendar day. Mirrors `fmtCalendarDate`
 * in apps/mobile/lib/format-date.ts.
 */
export function fmtCalendarDate(d?: string | null): string {
  if (!d) return "\u2014";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "\u2014";
  return dt.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Today's date in YYYY-MM-DD format */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Whole calendar days from the viewer's LOCAL today until a stored
 * UTC-midnight calendar date. Negative = that many days overdue. The due
 * date's day is read in UTC (it is a calendar value — see fmtCalendarDate);
 * "today" is the viewer's local calendar day. Mixing the two the other way
 * round is the badge variant of the −1-day bug.
 */
export function calendarDaysUntil(d?: string | null): number | null {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return null;
  const dueUTC = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
  const now = new Date();
  const todayUTC = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((dueUTC - todayUTC) / 86_400_000);
}

/**
 * True for the internal, non-routable email sentinels we mint when a customer has no address:
 * `no-email+<uuid>@placeholder.local` (User.email is required + unique per tenant) and
 * `<username>@imported.local` (CSV import). Never render one of these to a user.
 */
export function isInternalEmail(email?: string | null): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  return e.endsWith("@placeholder.local") || e.endsWith("@imported.local");
}
