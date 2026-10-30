import { tenantTodayDay } from "../common/calendar-date";

/**
 * Phase 4 (W5): the "YYYY-MM" period bucket a regulated sale/reversal books into.
 * UTC-based so it never drifts with the server's local timezone. Single source of
 * truth used both when WRITING ledger rows and when QUERYING by periodBucket.
 */
export function periodBucketOf(date: Date): string {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** UTC [from, to) date range for a "YYYY-MM" bucket (to = first day of next month). */
export function monthRange(bucket: string): { from: Date; to: Date } {
  const [y, m] = bucket.split("-").map(Number);
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
}

export type FilingCadence = "MONTHLY" | "QUARTERLY" | "ANNUAL";

/**
 * The "YYYY-MM" buckets that compose one filing period, plus its canonical label
 * and the UTC [from, to) range (half-open — `to` is exclusive, matching monthRange
 * and periodBucketOf). `index` is the 1-based month (MONTHLY) or quarter
 * (QUARTERLY) within `year`; it is ignored for ANNUAL. This is the ONLY new period
 * math — it composes monthRange so filing boundaries stay identical to how ledger
 * rows bucket.
 */
export function filingPeriod(
  cadence: FilingCadence,
  year: number,
  index: number,
): { periodKey: string; buckets: string[]; from: Date; to: Date } {
  const bucketOf = (m: number) => `${year}-${String(m).padStart(2, "0")}`;

  if (cadence === "QUARTERLY") {
    if (index < 1 || index > 4) throw new RangeError(`quarter must be 1-4, got ${index}`);
    const firstMonth = (index - 1) * 3 + 1;
    const buckets = [firstMonth, firstMonth + 1, firstMonth + 2].map(bucketOf);
    return {
      periodKey: `${year}-Q${index}`,
      buckets,
      from: monthRange(buckets[0]).from,
      to: monthRange(buckets[2]).to,
    };
  }

  if (cadence === "ANNUAL") {
    const buckets = Array.from({ length: 12 }, (_, i) => bucketOf(i + 1));
    return {
      periodKey: `${year}`,
      buckets,
      from: new Date(Date.UTC(year, 0, 1)),
      to: new Date(Date.UTC(year + 1, 0, 1)),
    };
  }

  // MONTHLY
  if (index < 1 || index > 12) throw new RangeError(`month must be 1-12, got ${index}`);
  const bucket = bucketOf(index);
  const { from, to } = monthRange(bucket);
  return { periodKey: bucket, buckets: [bucket], from, to };
}

/**
 * SA-995 §3: has a period ended on the TENANT's clock? True once the tenant's calendar day is on or past the
 * period's exclusive end day. The one reader of "the tenant's today" (`tenantTodayDay`), so a US tenant's
 * 31st is still the 31st when UTC has turned the 1st, with no grace window. `periodEnd` is a UTC-midnight stamp
 * of the first day of the next period (symbolic calendar date, as every period here is).
 */
export function periodEndedForTenant(
  periodEnd: Date,
  zone: string | null | undefined,
  now: Date = new Date(),
): boolean {
  return tenantTodayDay(zone, now) >= periodEnd.toISOString().slice(0, 10);
}
