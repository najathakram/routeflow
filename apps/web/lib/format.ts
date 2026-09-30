/**
 * Display formatting — the ONE place money, quantities, dates, and enum labels
 * are turned into strings for the UI. Never re-derive with toFixed/
 * toLocaleDateString inline; import from here. Display only — money MATH stays
 * in lib/pricing.ts.
 */
const moneyFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatMoney(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return moneyFmt.format(Number.isFinite(n) ? n : 0);
}

/** Whole numbers render bare ("61"), fractional quantities keep up to 2 dp ("1.5"). */
export function formatQty(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/**
 * App-standard date: "Aug 27, 2026", rendered in the VIEWER'S LOCAL timezone —
 * so it is correct for real timestamps (`createdAt`, `paidAt`, `startedAt`, …).
 *
 * ⚠️ NOT for calendar dates stored at UTC midnight (`dueDate`, `issueDate`,
 * `scheduledDate`, `expiresAt`, …): local formatting renders UTC midnight as the
 * PREVIOUS day for every negative-offset viewer (all of the Americas). Use
 * `fmtCalendarDate` from `@/lib/formatting` for those — it is the same output
 * shape with `timeZone: "UTC"`.
 */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "PARTIALLY_DELIVERED" → "Partially Delivered". */
export function humanizeEnum(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
