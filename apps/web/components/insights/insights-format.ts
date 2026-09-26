import type { InsightGrain } from "@routeflow/types";

/**
 * #2121 — pure display helpers for the insights panels. Formatting only: every figure arrives
 * computed (and rounded) by the API; nothing here re-derives money.
 */

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export const formatMoney = (n: number) => usd.format(n);

/** $1.2k / $34k / $1.1M for axes and dense tiles; exact below $1,000. */
export function formatMoneyShort(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}$${Math.round(abs / 1_000)}k`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${Math.round(abs)}`;
}

/** Share 0–1 → "42%" (one decimal under 10%). */
export function formatShare(share: number): string {
  const pct = share * 100;
  if (pct > 0 && pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

/** Parts of a "YYYY-MM-DD" day. Never `new Date(day)` — that is UTC midnight, the previous
 *  day west of UTC. */
function parts(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  return { y, m, d };
}

/** "Sep 5, 2026". */
export function formatDay(day: string): string {
  const { y, m, d } = parts(day);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** A bucket start as an axis label for its grain. */
export function bucketAxisLabel(day: string, grain: InsightGrain): string {
  const { y, m, d } = parts(day);
  if (grain === "month") return `${MONTHS[m - 1]} '${String(y).slice(2)}`;
  if (grain === "quarter") return `Q${Math.floor((m - 1) / 3) + 1} '${String(y).slice(2)}`;
  return `${m}/${d}`;
}

/** A bucket start as a tooltip title for its grain. */
export function bucketTitle(day: string, grain: InsightGrain): string {
  const { y, m, d } = parts(day);
  if (grain === "month") return `${MONTHS[m - 1]} ${y}`;
  if (grain === "quarter") return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  if (grain === "week") return `Week of ${MONTHS[m - 1]} ${d}, ${y}`;
  return formatDay(day);
}

/** "every 12 days" / "every 1.5 days". */
export function formatEvery(days: number): string {
  return `every ${Number.isInteger(days) ? days : days.toFixed(1)} day${days === 1 ? "" : "s"}`;
}

/** "today" / "1 day ago" / "12 days ago". */
export function formatAgo(days: number): string {
  if (days <= 0) return "today";
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export type PriceTone = "above" | "below" | "same";

/**
 * This customer's effective per-piece price against every buyer's, as a signed percentage.
 * Null when either side is missing or the reference is zero. Within ±0.5% counts as the same.
 */
export function priceVsAverage(
  mine: number | null,
  reference: number | null,
): { pct: number; tone: PriceTone; label: string } | null {
  if (mine == null || reference == null || reference === 0) return null;
  const pct = Math.round(((mine - reference) / reference) * 1000) / 10;
  if (Math.abs(pct) < 0.5) return { pct: 0, tone: "same", label: "at average" };
  const tone: PriceTone = pct > 0 ? "above" : "below";
  return { pct, tone, label: `${pct > 0 ? "+" : ""}${pct.toFixed(1)}% vs avg` };
}

export const PERIOD_PRESETS = [
  { months: 3, label: "3M", aria: "Last 3 months" },
  { months: 6, label: "6M", aria: "Last 6 months" },
  { months: 12, label: "12M", aria: "Last 12 months" },
  { months: 24, label: "24M", aria: "Last 24 months" },
] as const;
export type PeriodMonths = (typeof PERIOD_PRESETS)[number]["months"];

/**
 * The first day of a trailing N-calendar-month window ending in the month of `today`
 * ("YYYY-MM-DD" in, "YYYY-MM-DD" out) — the server's own 12-month default, generalized.
 */
export function presetFrom(today: string, months: number): string {
  const { y, m } = parts(today);
  const idx = y * 12 + (m - 1) - (months - 1);
  const fy = Math.floor(idx / 12);
  const fm = (idx % 12) + 1;
  return `${fy}-${String(fm).padStart(2, "0")}-01`;
}

/** Today as "YYYY-MM-DD" in the browser's calendar. */
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Filename-safe token for a download. */
export function fileToken(s: string): string {
  return (
    s
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "customer"
  );
}
