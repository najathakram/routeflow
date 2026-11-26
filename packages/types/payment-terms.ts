/**
 * W-1487: ONE table of invoice payment terms for web, mobile and the API (which keeps a literal copy at
 * apps/api/src/invoices/payment-terms.ts, pinned equal by payment-terms-parity.spec.ts, L-261). Terms are stored as text
 * ("Net 30"), so there is no migration. Pure: no imports.
 *
 * `termDays` reads "Due on Receipt" (0) and "Net N" for a whole N from 1 to 365; any other text gives null, so a caller
 * decides its own fallback (the product uses 30 days). The due date itself is the caller's calendar-day helper
 * (`addDaysIso` on web, `dueDateFor` on mobile, `addCalendarDays` in the API), never the browser clock.
 */
export const PAYMENT_TERM_PRESETS = [
  "Due on Receipt",
  "Net 7",
  "Net 15",
  "Net 30",
  "Net 45",
  "Net 60",
  "Net 90",
] as const;
export type PaymentTermPreset = (typeof PAYMENT_TERM_PRESETS)[number];

export const PAYMENT_TERM_MIN_DAYS = 1;
export const PAYMENT_TERM_MAX_DAYS = 365;

/** "Net N" for a whole N in range, else null. Exactly the label `netLabel` writes: no "net 30 days", no 7.5, no -3. */
export function termDays(label: string | null | undefined): number | null {
  if (typeof label !== "string") return null;
  const text = label.trim();
  if (text === "Due on Receipt") return 0;
  const m = /^Net ([1-9]\d{0,2})$/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= PAYMENT_TERM_MIN_DAYS && n <= PAYMENT_TERM_MAX_DAYS ? n : null;
}

/** The label stored for a custom term: `netLabel(21)` is "Net 21"; null when `n` is not a whole number of days in range. */
export function netLabel(n: number): string | null {
  return Number.isInteger(n) && n >= PAYMENT_TERM_MIN_DAYS && n <= PAYMENT_TERM_MAX_DAYS
    ? `Net ${n}`
    : null;
}
