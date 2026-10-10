import type { ArAgingBucket } from "./api/finance";

export interface ArAgingCustomerRow {
  name: string;
  /** Σ balance per bucket key — unchanged by the deposit marker. */
  buckets: Record<string, number>;
  /** #1529: any of this customer's invoices has an overdue deposit (API per-row `depositOverdue`). */
  depositOverdue: boolean;
}

/**
 * The AR Aging Summary's per-customer rows: each customer's balance summed per bucket, plus
 * (#1529 / SA-517 PR-B) whether any of its invoices carries an overdue deposit. An older API
 * response without the deposit fields marks nobody.
 */
export function groupArAgingByCustomer(
  buckets: Record<string, ArAgingBucket[] | undefined>,
): Record<string, ArAgingCustomerRow> {
  const out: Record<string, ArAgingCustomerRow> = {};
  for (const [bucketKey, items] of Object.entries(buckets)) {
    for (const item of items ?? []) {
      const row = (out[item.customer.id] ??= {
        name: item.customer.businessName,
        buckets: {},
        depositOverdue: false,
      });
      row.buckets[bucketKey] = (row.buckets[bucketKey] ?? 0) + item.balance;
      if (item.depositOverdue === true) row.depositOverdue = true;
    }
  }
  return out;
}

/** #1529: the one summary line for the API's top-level `depositOverdue`, or null when there is none. */
export function depositOverdueLine(
  summary: { count: number; outstanding: number } | undefined | null,
  fmt: (n: number) => string,
): string | null {
  if (!summary || summary.count <= 0) return null;
  const noun = summary.count === 1 ? "deposit" : "deposits";
  return `${summary.count} ${noun} overdue · ${fmt(summary.outstanding)} outstanding`;
}
