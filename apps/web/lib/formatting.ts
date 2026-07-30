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

/** Format an ISO date string as "Mar 30, 2026". Returns "\u2014" for null/invalid. */
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

/** Today's date in YYYY-MM-DD format */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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
