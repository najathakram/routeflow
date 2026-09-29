import type { DemandBucket, DemandGranularity, DemandRange } from "@routeflow/types";

/**
 * Pure series math for the product-detail demand chart (mirrors web's DemandCard).
 * Display-only: bar heights are ratios of SERVER-provided figures — no money or
 * quantity is derived here.
 */

export type DemandMetric = "units" | "revenue";

export const DEMAND_RANGE_OPTIONS: readonly {
  value: DemandRange;
  label: string;
  aria: string;
  noun: string;
}[] = [
  { value: "30d", label: "30D", aria: "Last 30 days", noun: "30 days" },
  { value: "6m", label: "6M", aria: "Last 6 months", noun: "6 months" },
  { value: "1y", label: "1Y", aria: "Last year", noun: "year" },
  { value: "5y", label: "5Y", aria: "Last 5 years", noun: "5 years" },
];

/** Guaranteed (minimum) reach of each server window in days — see web DemandCard. */
const RANGE_REACH_DAYS: Record<DemandRange, number> = {
  "30d": 29,
  "6m": 175,
  "1y": 334,
  "5y": 1795,
};

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

/** Calendar parts of a "YYYY-MM-DD" key. Never `new Date(iso)` (UTC-midnight trap). */
function parts(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

export function axisLabel(iso: string, granularity: DemandGranularity): string {
  const { y, m, d } = parts(iso);
  if (granularity === "month") return `${MONTHS[m - 1]} '${String(y).slice(2)}`;
  return `${m}/${d}`;
}

export function tipLabel(iso: string, granularity: DemandGranularity): string {
  const { y, m, d } = parts(iso);
  if (granularity === "month") return `${MONTHS[m - 1]} ${y}`;
  if (granularity === "week") return `Week of ${MONTHS[m - 1]} ${d}`;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function monthYear(iso: string): string {
  const { y, m } = parts(iso);
  return `${MONTHS[m - 1]} ${y}`;
}

export function rangeNoun(range: DemandRange): string {
  return DEMAND_RANGE_OPTIONS.find((o) => o.value === range)?.noun ?? range;
}

/** Show a label every Nth bar: all up to 12 buckets, else about 10 labels. */
export function tickStep(count: number): number {
  if (count <= 12) return 1;
  return Math.ceil(count / 10);
}

export interface DemandBar {
  key: string;
  value: number;
  /** 0-100. Non-zero values never render below MIN_BAR_PCT so they stay visible. */
  heightPct: number;
  axis: string;
  tip: string;
  showAxis: boolean;
}

const MIN_BAR_PCT = 2;

export function chartBars(
  buckets: readonly DemandBucket[],
  metric: DemandMetric,
  granularity: DemandGranularity,
): { max: number; bars: DemandBar[] } {
  const values = buckets.map((b) => Number(metric === "revenue" ? b.revenue : b.units) || 0);
  const max = values.reduce((m, v) => (v > m ? v : m), 0);
  const step = tickStep(buckets.length);
  const bars = buckets.map((bk, i) => {
    const value = values[i];
    const heightPct = max <= 0 || value <= 0 ? 0 : Math.max(MIN_BAR_PCT, (value / max) * 100);
    return {
      key: bk.date,
      value,
      heightPct,
      axis: axisLabel(bk.date, granularity),
      tip: tipLabel(bk.date, granularity),
      showAxis: i % step === 0,
    };
  });
  return { max, bars };
}

/** Smallest range guaranteed to reach the last sale, or null if none / already shown. */
export function suggestRange(
  lastSaleAt: string | null | undefined,
  shownRange: DemandRange,
  nowMs: number,
): DemandRange | null {
  if (!lastSaleAt) return null;
  const { y, m, d } = parts(lastSaleAt);
  const ageDays = (nowMs - Date.UTC(y, m - 1, d)) / 86_400_000;
  const fit = DEMAND_RANGE_OPTIONS.find((o) => RANGE_REACH_DAYS[o.value] > ageDays);
  return fit && fit.value !== shownRange ? fit.value : null;
}

const demandMoney = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Revenue headline, web parity (products/[id]/DemandCard.tsx): "$12,345.67". */
export function fmtDemandMoney(n: number): string {
  return demandMoney.format(Number.isFinite(n) ? n : 0);
}
