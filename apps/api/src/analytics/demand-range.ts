/**
 * Bucket windows for the per-product demand series (`GET /analytics/demand/:productId`).
 *
 * UTC-based throughout, like `regulated/period.ts` — a bucket boundary must not drift
 * with the server's local timezone, or the same invoice lands in different buckets on
 * a developer laptop and in CI. `analytics.service.ts getRevenueTrend` was the cautionary
 * tale: it keyed months from `getFullYear()/getMonth()` (LOCAL) but days from
 * `toISOString()` (UTC), so on a UTC-5 host one invoice at 2026-01-01T02:00Z bucketed
 * into month "2025-12" and day "2026-01-01" simultaneously. Both branches are UTC now
 * (see `analytics.service.calendar.spec.ts`) — do not reintroduce a local-time key.
 *
 * Known trade-off: an operator invoicing at 7pm CT on the 31st books into the next UTC
 * day. Every other analytics surface (revenue, sales-by-category, tobacco monthly)
 * already behaves this way, so this endpoint is consistent with them. If per-tenant
 * timezones ever land, `demandWindow` takes its inputs explicitly and is the seam.
 *
 * `demandWindow` NEVER reads the clock — `now` is always injected. That is what makes
 * the bucket math deterministically testable; this repo uses no fake timers anywhere.
 */

import { parseCalendarDay } from "../common/calendar-date";

export const DEMAND_RANGES = ["30d", "6m", "1y", "5y"] as const;
export type DemandRange = (typeof DEMAND_RANGES)[number];

export type DemandGranularity = "day" | "week" | "month";

/**
 * #2118: the insights grains. The API's runtime copy of `INSIGHT_GRAIN_VALUES`
 * (`@routeflow/types`, which the API may only `import type` from — see
 * `no-runtime-workspace-imports.spec.ts`); `sales-facts.contract.spec.ts` pins the two
 * set-equal, together with the two limits below.
 */
export const INSIGHT_GRAINS = ["day", "week", "month", "quarter"] as const;
export type InsightGrain = (typeof INSIGHT_GRAINS)[number];
export const INSIGHT_MAX_WINDOW_MONTHS = 36;
export const INSIGHT_MAX_BUCKETS = 400;

type BucketGranularity = DemandGranularity | "quarter";

interface DemandBucketBounds {
  /** UTC-midnight start as "YYYY-MM-DD". The series key the client renders. */
  date: string;
  /** UTC-midnight EXCLUSIVE end. Equals the next bucket's `date`. */
  end: string;
}

/** What `bucketIndexOf` needs: period-aligned buckets over [from, to). */
export interface BucketedWindow {
  granularity: BucketGranularity;
  /** Inclusive lower bound — `buckets[0].date` at 00:00:00.000Z. */
  from: Date;
  /** EXCLUSIVE upper bound — the last bucket's end at 00:00:00.000Z. */
  to: Date;
  buckets: DemandBucketBounds[];
}

export interface DemandWindow extends BucketedWindow {
  range: DemandRange;
  granularity: DemandGranularity;
}

/**
 * #2118: an explicit calendar-day window. The buckets are period-aligned, so the first and
 * last may extend past the window; the DATA bounds are the exact days. Reads filter a
 * UTC-midnight stamp column (`issueDate`) on `{ gte: dataFrom, lt: dataTo }`.
 */
export interface RangeWindow extends BucketedWindow {
  granularity: InsightGrain;
  /** First calendar day, inclusive ("YYYY-MM-DD"). */
  fromDay: string;
  /** Last calendar day, inclusive ("YYYY-MM-DD"). */
  toDay: string;
  /** `fromDay` at 00:00:00.000Z — inclusive. */
  dataFrom: Date;
  /** The day after `toDay` at 00:00:00.000Z — EXCLUSIVE. */
  dataTo: Date;
}

/** A window request the API refuses (the controllers map it to 400). */
export class InsightWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsightWindowError";
  }
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
export function bucketIndexOf(win: BucketedWindow, date: Date): number {
  const t = utcMidnightMs(date);
  if (t < win.from.getTime() || t >= win.to.getTime()) return -1;

  if (win.granularity === "month" || win.granularity === "quarter") {
    const fromY = win.from.getUTCFullYear();
    const fromM = win.from.getUTCMonth();
    const months = (date.getUTCFullYear() - fromY) * 12 + (date.getUTCMonth() - fromM);
    const idx = win.granularity === "quarter" ? Math.floor(months / 3) : months;
    return idx >= 0 && idx < win.buckets.length ? idx : -1;
  }

  const step = win.granularity === "week" ? MS_PER_WEEK : MS_PER_DAY;
  const idx = Math.floor((t - win.from.getTime()) / step);
  return idx >= 0 && idx < win.buckets.length ? idx : -1;
}

// ─── #2118: the from/to form (insights endpoints) ───────────────────────────
//
// Same conventions as `demandWindow`: every day is a UTC-midnight symbolic stamp (the storage
// convention of `issueDate`), the clock is never read (the caller passes `today`), and every
// bucket is materialized so empty periods stay explicit zeros.

/** A real "YYYY-MM-DD" calendar day (never a timestamp, never an impossible day). */
export function isCalendarDay(value: unknown): value is string {
  return typeof value === "string" && parseCalendarDay(value) != null;
}

function dayMs(day: string): number {
  const p = parseCalendarDay(day);
  if (!p) throw new InsightWindowError(`not a calendar day (YYYY-MM-DD): ${JSON.stringify(day)}`);
  return Date.UTC(p.year, p.month - 1, p.day);
}

/** `day` shifted by `n` calendar days ("YYYY-MM-DD" in, "YYYY-MM-DD" out). */
export function addCalendarDays(day: string, n: number): string {
  return isoDay(dayMs(day) + n * MS_PER_DAY);
}

/** Inclusive day count of [fromDay, toDay]. */
function spanDays(fromDay: string, toDay: string): number {
  return Math.round((dayMs(toDay) - dayMs(fromDay)) / MS_PER_DAY) + 1;
}

/**
 * The grain a window gets when the caller names none: daily up to ~2 months, weekly up to
 * ~6 months (26 points, the same density `demandWindow`'s 6m range chose), monthly beyond.
 */
export function defaultInsightGrain(fromDay: string, toDay: string): InsightGrain {
  const days = spanDays(fromDay, toDay);
  if (days <= 62) return "day";
  if (days <= 184) return "week";
  return "month";
}

/** Start (epoch ms, UTC midnight) of the `grain` period containing `ms`. */
function periodStartMs(ms: number, grain: InsightGrain): number {
  const d = new Date(ms);
  if (grain === "day") return ms;
  if (grain === "week") return ms - ((d.getUTCDay() + 6) % 7) * MS_PER_DAY;
  const month = grain === "quarter" ? d.getUTCMonth() - (d.getUTCMonth() % 3) : d.getUTCMonth();
  return Date.UTC(d.getUTCFullYear(), month, 1);
}

/** Start (epoch ms) of the period `n` periods after the one starting at `startMs`. */
function periodShiftMs(startMs: number, grain: InsightGrain, n: number): number {
  if (grain === "day") return startMs + n * MS_PER_DAY;
  if (grain === "week") return startMs + n * MS_PER_WEEK;
  const d = new Date(startMs);
  const months = grain === "quarter" ? 3 * n : n;
  // Date.UTC normalizes month overflow (never setMonth, see demandWindow).
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1);
}

/** Number of `grain` periods from the one starting at `firstMs` to the one at `lastMs`. */
function periodCount(firstMs: number, lastMs: number, grain: InsightGrain): number {
  if (grain === "day") return Math.round((lastMs - firstMs) / MS_PER_DAY) + 1;
  if (grain === "week") return Math.round((lastMs - firstMs) / MS_PER_WEEK) + 1;
  const a = new Date(firstMs);
  const b = new Date(lastMs);
  const months =
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  return (grain === "quarter" ? months / 3 : months) + 1;
}

/**
 * The bucketed window for [fromDay, toDay] (both inclusive) at `grain`. Refuses (throws
 * `InsightWindowError`) a malformed/impossible day, `toDay` before `fromDay`, a span of more
 * than `INSIGHT_MAX_WINDOW_MONTHS` months, and more than `INSIGHT_MAX_BUCKETS` buckets — the
 * last two are the read budget of plan A4.
 */
export function rangeWindow(fromDay: string, toDay: string, grain: InsightGrain): RangeWindow {
  if (!(INSIGHT_GRAINS as readonly string[]).includes(grain)) {
    throw new InsightWindowError(`grain must be one of: ${INSIGHT_GRAINS.join(", ")}`);
  }
  const fromMs = dayMs(fromDay);
  const toMs = dayMs(toDay);
  if (toMs < fromMs) throw new InsightWindowError(`to (${toDay}) is before from (${fromDay})`);

  const f = new Date(fromMs);
  const limitMs = Date.UTC(
    f.getUTCFullYear(),
    f.getUTCMonth() + INSIGHT_MAX_WINDOW_MONTHS,
    f.getUTCDate(),
  );
  if (toMs >= limitMs) {
    throw new InsightWindowError(`a window may span at most ${INSIGHT_MAX_WINDOW_MONTHS} months`);
  }

  const firstMs = periodStartMs(fromMs, grain);
  const lastMs = periodStartMs(toMs, grain);
  const count = periodCount(firstMs, lastMs, grain);
  if (count > INSIGHT_MAX_BUCKETS) {
    throw new InsightWindowError(
      `${count} ${grain} buckets exceed the ${INSIGHT_MAX_BUCKETS}-bucket limit — use a coarser grain`,
    );
  }

  const buckets: DemandBucketBounds[] = [];
  for (let i = 0; i < count; i++) {
    buckets.push({
      date: isoDay(periodShiftMs(firstMs, grain, i)),
      end: isoDay(periodShiftMs(firstMs, grain, i + 1)),
    });
  }

  return {
    granularity: grain,
    fromDay: isoDay(fromMs),
    toDay: isoDay(toMs),
    dataFrom: new Date(fromMs),
    dataTo: new Date(toMs + MS_PER_DAY),
    from: new Date(firstMs),
    to: new Date(periodShiftMs(firstMs, grain, count)),
    buckets,
  };
}

/**
 * Fills the defaults of an insights query and validates the result: `to` = `today` (the
 * tenant's calendar day, supplied by the caller), `from` = the 1st of the month eleven months
 * before `to` (twelve calendar months), `grain` = `defaultInsightGrain`. Blank params count as
 * absent. Throws `InsightWindowError` for anything `rangeWindow` would refuse.
 */
export function resolveInsightRange(
  params: { from?: string | null; to?: string | null; grain?: string | null },
  today: string,
): { fromDay: string; toDay: string; grain: InsightGrain } {
  const blank = (v: string | null | undefined) => (v == null || v.trim() === "" ? null : v.trim());
  const toDay = blank(params.to) ?? today;
  if (!isCalendarDay(toDay)) {
    throw new InsightWindowError(
      `to must be a calendar day (YYYY-MM-DD), got ${JSON.stringify(toDay)}`,
    );
  }
  const t = new Date(dayMs(toDay));
  const fromDay =
    blank(params.from) ?? isoDay(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 11, 1));
  if (!isCalendarDay(fromDay)) {
    throw new InsightWindowError(
      `from must be a calendar day (YYYY-MM-DD), got ${JSON.stringify(fromDay)}`,
    );
  }
  const rawGrain = blank(params.grain);
  if (rawGrain != null && !(INSIGHT_GRAINS as readonly string[]).includes(rawGrain)) {
    throw new InsightWindowError(`grain must be one of: ${INSIGHT_GRAINS.join(", ")}`);
  }
  const grain = (rawGrain as InsightGrain | null) ?? defaultInsightGrain(fromDay, toDay);
  rangeWindow(fromDay, toDay, grain); // validates span/limits; throws InsightWindowError
  return { fromDay, toDay, grain };
}
