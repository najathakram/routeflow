import { priceInUnit, pricePerBaseUnit, roundMoney, unitNameKey } from "@routeflow/pricing";
import type { PriceHistoryAveragePoint, PriceHistoryComparisonLine } from "@routeflow/types";

/**
 * SA-954 D1 / D2: the two reference lines next to this customer's own price line. Pure: the service reads, these decide.
 *
 *  - likeForLike (line 2): OTHER customers' lines in the plot unit's NAME and PACK, the monthly mean of the line price.
 *  - converted (line 3): ALL customers' lines with a known pack, in any unit. Each line's price per base unit
 *    (`pricePerBaseUnit`, unrounded); each month's mean of those, re-expressed in the plot unit with ONE rounding
 *    (`priceInUnit`). This customer's lines count in the mean, never toward the floor.
 *
 * The floor, for both lines: a month backed by fewer than `minBuyers` distinct OTHER buyers is left out and never
 * bridged. A line whose pack cannot be read from the line is left out of line 3, never guessed (`salePackOf`).
 * Months are UTC calendar months ("YYYY-MM"). No customer id or name leaves this module.
 */
export interface ComparisonSale {
  /** The line's unit price (before discounts and free units), as the history rows show it. */
  price: number;
  /** Who bought it: used only to count DISTINCT buyers, never returned. */
  buyer: string;
  /** This customer's own line: counted in line 3's mean, never toward a floor, never in line 2. */
  own: boolean;
  month: string;
  unitLabel: string;
  /** Pieces per selling unit from the line's own snapshot (1 = by the piece); null = cannot be known. */
  pack: number | null;
}

/** One plot unit: a unit name and its pack (pieces per unit, >= 1). */
export interface PlotUnit {
  unitLabel: string;
  pack: number;
}

const byMonth = (a: PriceHistoryAveragePoint, b: PriceHistoryAveragePoint) =>
  a.month < b.month ? -1 : a.month > b.month ? 1 : 0;

interface Bucket {
  sum: number;
  n: number;
  /** Distinct OTHER buyers only. */
  others: Set<string>;
}

function monthly(
  sales: readonly ComparisonSale[],
  value: (s: ComparisonSale) => number | null,
  minBuyers: number,
  finish: (mean: number) => number,
): PriceHistoryAveragePoint[] {
  const months = new Map<string, Bucket>();
  for (const s of sales) {
    const v = value(s);
    if (v == null) continue;
    const m = months.get(s.month) ?? { sum: 0, n: 0, others: new Set<string>() };
    m.sum += v;
    m.n += 1;
    if (!s.own) m.others.add(s.buyer);
    months.set(s.month, m);
  }
  return [...months.entries()]
    .filter(([, m]) => m.others.size >= minBuyers)
    .map(([month, m]) => ({ month, average: finish(m.sum / m.n) }))
    .sort(byMonth);
}

export function comparisonFor(
  sales: readonly ComparisonSale[],
  plot: PlotUnit,
  minBuyers: number,
): PriceHistoryComparisonLine {
  const key = unitNameKey(plot.unitLabel);
  const likeForLike = monthly(
    sales.filter((s) => !s.own && s.pack === plot.pack && unitNameKey(s.unitLabel) === key),
    (s) => s.price,
    minBuyers,
    roundMoney,
  );
  const converted = monthly(
    sales,
    (s) => pricePerBaseUnit(s.price, s.pack),
    minBuyers,
    (mean) => priceInUnit(mean, plot.pack),
  );
  return {
    unitLabel: plot.unitLabel,
    unitsPerBox: plot.pack > 1 ? plot.pack : null,
    likeForLike,
    converted,
  };
}

/** The plot units: this customer's distinct (unit name, pack) with a known pack, newest first; the label is the newest row's. */
export function plotUnitsOf(
  rows: ReadonlyArray<{ unitLabel: string; pack: number | null }>,
): PlotUnit[] {
  const seen = new Map<string, PlotUnit>();
  for (const r of rows) {
    if (r.pack == null || !(r.pack >= 1)) continue;
    const k = `${unitNameKey(r.unitLabel)}|${r.pack}`;
    if (!seen.has(k)) seen.set(k, { unitLabel: r.unitLabel, pack: r.pack });
  }
  return [...seen.values()];
}

/**
 * The most common known pack among a unit's sales (ties go to the larger pack); null when none is known. With no
 * history of its own, the plot unit is the summary's unit at this pack (D2).
 */
export function mostCommonPack(packs: ReadonlyArray<number | null>): number | null {
  const count = new Map<number, number>();
  for (const p of packs) if (p != null && p >= 1) count.set(p, (count.get(p) ?? 0) + 1);
  let best: number | null = null;
  let top = 0;
  for (const [p, n] of count) {
    if (n > top || (n === top && p > (best ?? 0))) {
      best = p;
      top = n;
    }
  }
  return best;
}

export function comparisonLines(
  sales: readonly ComparisonSale[],
  plots: readonly PlotUnit[],
  minBuyers: number,
): PriceHistoryComparisonLine[] {
  return plots.map((p) => comparisonFor(sales, p, minBuyers));
}
