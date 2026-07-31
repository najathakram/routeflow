/**
 * Bucket windows for the per-product demand series (`GET /analytics/demand/:productId`).
 *
 * UTC-based throughout, like `regulated/period.ts` — a bucket boundary must not drift
 * with the server's local timezone, or the same invoice lands in different buckets on
 * a developer laptop and in CI. `analytics.service.ts getRevenueTrend` is the cautionary
 * tale: it keys months from `getFullYear()/getMonth()` (LOCAL) but days from
 * `toISOString()` (UTC), so on a UTC-5 host one invoice at 2026-01-01T02:00Z buckets
 * into month "2025-12" and day "2026-01-01" simultaneously. Do not copy that.
 *
 * Known trade-off: an operator invoicing at 7pm CT on the 31st books into the next UTC
 * day. Every other analytics surface (revenue, sales-by-category, tobacco monthly)
 * already behaves this way, so this endpoint is consistent with them. If per-tenant
 * timezones ever land, `demandWindow` takes its inputs explicitly and is the seam.
 *
 * `demandWindow` NEVER reads the clock — `now` is always injected. That is what makes
 * the bucket math deterministically testable; this repo uses no fake timers anywhere.
 */

export const DEMAND_RANGES = ["30d", "6m", "1y", "5y"] as const;
export type DemandRange = (typeof DEMAND_RANGES)[number];

export type DemandGranularity = "day" | "week" | "month";

export interface DemandBucketBounds {
  /** UTC-midnight start as "YYYY-MM-DD". The series key the client renders. */
  date: string;
  /** UTC-midnight EXCLUSIVE end. Equals the next bucket's `date`. */
  end: string;
}

export interface DemandWindow {
  range: DemandRange;
  granularity: DemandGranularity;
  /** Inclusive lower bound — `buckets[0].date` at 00:00:00.000Z. */
  from: Date;
  /** EXCLUSIVE upper bound — the last bucket's end at 00:00:00.000Z. */
  to: Date;
  buckets: DemandBucketBounds[];
}

/** Per-range shape. 30d/6m stay dense enough to read a trend; 1y/5y roll up to months. */
const RANGE_SHAPE: Record<DemandRange, { granularity: DemandGranularity; count: number }> = {
  "30d": { granularity: "day", count: 30 },
  // Weekly, not monthly: 6 bars is not a trend, and daily over 6 months is ~183 mostly
  // empty points for a single product.
  "6m": { granularity: "week", count: 26 },
  "1y": { granularity: "month", count: 12 },
  // Monthly, not quarterly: quarterly would give 20 bars, and with the tenant's history
  // still short that makes the 5y view carry LESS information than the 1y view.
  "5y": { granularity: "month", count: 60 },
};

const MS_PER_DAY = 86_400_000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

export function isDemandRange(value: unknown): value is DemandRange {
  return typeof value === "string" && (DEMAND_RANGES as readonly string[]).includes(value);
}

/** UTC midnight of `d`'s calendar day, as epoch ms. */
function utcMidnightMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** "YYYY-MM-DD" for a UTC-midnight instant. */
function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The bucket series ending on the period containing `now`, inclusive.
 *
 * Half-open [from, to) throughout — `to` is the exclusive end, so the Prisma filter is
 * `{ gte: from, lt: to }` with no lost-millisecond `23:59:59.999` fudge.
 */
export function demandWindow(now: Date, range: DemandRange): DemandWindow {
  const { granularity, count } = RANGE_SHAPE[range];
  const buckets: DemandBucketBounds[] = [];
  let from: Date;
  let to: Date;

  if (granularity === "month") {
    // Month math via Date.UTC, NEVER setMonth(): setMonth on a day-31 date skids into
    // the following month (Mar 31 -> "Feb 31" -> Mar 3), silently shifting the window.
    // Date.UTC normalizes out-of-range month indices natively, including negatives.
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    for (let i = 0; i < count; i++) {
      const offset = m - (count - 1 - i);
      buckets.push({
        date: isoDay(Date.UTC(y, offset, 1)),
        end: isoDay(Date.UTC(y, offset + 1, 1)),
      });
    }
    from = new Date(Date.UTC(y, m - (count - 1), 1));
    to = new Date(Date.UTC(y, m + 1, 1));
  } else {
    const step = granularity === "week" ? MS_PER_WEEK : MS_PER_DAY;
    // Weeks anchor to Monday (ISO-8601). getUTCDay() is 0=Sun, so Sunday steps back 6.
    const today = utcMidnightMs(now);
    const anchor =
      granularity === "week" ? today - ((new Date(today).getUTCDay() + 6) % 7) * MS_PER_DAY : today;
    const start = anchor - (count - 1) * step;
    for (let i = 0; i < count; i++) {
      buckets.push({ date: isoDay(start + i * step), end: isoDay(start + (i + 1) * step) });
    }
    from = new Date(start);
    to = new Date(anchor + step);
  }

  return { range, granularity, from, to, buckets };
}

/**
 * Index of the bucket containing `date`, or -1 when it falls outside [from, to).
 * O(1) — keeps the service O(rows) rather than O(rows x buckets).
 */
export function bucketIndexOf(win: DemandWindow, date: Date): number {
  const t = utcMidnightMs(date);
  if (t < win.from.getTime() || t >= win.to.getTime()) return -1;

  if (win.granularity === "month") {
    const fromY = win.from.getUTCFullYear();
    const fromM = win.from.getUTCMonth();
    const idx = (date.getUTCFullYear() - fromY) * 12 + (date.getUTCMonth() - fromM);
    return idx >= 0 && idx < win.buckets.length ? idx : -1;
  }

  const step = win.granularity === "week" ? MS_PER_WEEK : MS_PER_DAY;
  const idx = Math.floor((t - win.from.getTime()) / step);
  return idx >= 0 && idx < win.buckets.length ? idx : -1;
}
