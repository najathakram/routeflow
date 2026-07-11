/**
 * Pure display helpers for the buyer Finances screen (mirrors web's buyer
 * finances page — plain stat/list UI, no chart library). The money figures come
 * from the server (`GET /buyer/analytics`) and are shown VERBATIM — never
 * re-derived here (the home screen's ad-hoc outstanding sum is a separate,
 * pre-existing computation; this screen trusts `summary.unpaidInvoiceTotal`).
 * Screen-free so __tests__/*.test.ts can lock the percentage + bar math.
 */

export interface InvoiceBreakdown {
  paid: number;
  unpaid: number;
  overdue: number;
}

export interface BreakdownRow {
  key: "paid" | "unpaid" | "overdue";
  label: string;
  count: number;
  /** Percentage of the total invoice count, rounded (0 when there are none). */
  pct: number;
}

/** The three status rows with their share of the total, for the plain % bars. */
export function invoiceBreakdownRows(b: InvoiceBreakdown): BreakdownRow[] {
  const total = b.paid + b.unpaid + b.overdue;
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
  return [
    { key: "paid", label: "Paid", count: b.paid, pct: pct(b.paid) },
    { key: "unpaid", label: "Unpaid", count: b.unpaid, pct: pct(b.unpaid) },
    { key: "overdue", label: "Overdue", count: b.overdue, pct: pct(b.overdue) },
  ];
}

/** Bar height fraction (0–1) for a monthly-spend row, normalized to the max month. */
export function monthlySpendFraction(spend: number, maxSpend: number): number {
  if (!(maxSpend > 0)) return 0;
  const f = spend / maxSpend;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** The largest monthly spend (for normalizing the bars); 0 for an empty series. */
export function maxMonthlySpend(months: Array<{ spend: number }>): number {
  return months.reduce((m, x) => (x.spend > m ? x.spend : m), 0);
}
