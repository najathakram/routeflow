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
