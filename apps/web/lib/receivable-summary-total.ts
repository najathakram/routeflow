import { roundMoney } from "@routeflow/pricing";

/**
 * The Receivable Summary footer's balance total: owed + unused credit-note credit, with overpayments
 * NOT netted. OWNER RULING 2026-10-11: the report's invoice ROWS show an overpayment as a negative
 * balance, but each row contributes max(0, balance) here, so an overpaid invoice (clamped to 0) never
 * nets against what other invoices owe. CREDIT_NOTE rows carry their unused credit as a positive
 * balance (bookkeeping.service.ts getReceivableSummary, pre-existing) and are summed into the same
 * footer. This reproduces the pre-ruling footer figure exactly (row 310 clamp). Rounded to cents; never -0.
 */
export function receivableSummaryBalanceTotal(rows: ReadonlyArray<{ balance: number }>): number {
  return roundMoney(rows.reduce((sum, r) => sum + Math.max(0, r.balance), 0));
}

/**
 * UX guide B7: the footer's three lines. `total` IS `receivableSummaryBalanceTotal(rows)` (not re-added), so the bottom
 * line cannot drift from today's figure; `openInvoices` (clamped invoice balances, the number AR aging shows) and
 * `unusedCredit` (open CREDIT_NOTE balances) only say what it is made of.
 */
export function receivableSummaryBreakdown(
  rows: ReadonlyArray<{ type: string; balance: number }>,
): {
  openInvoices: number;
  unusedCredit: number;
  total: number;
} {
  const sum = (type: string) =>
    roundMoney(
      rows.filter((r) => r.type === type).reduce((acc, r) => acc + Math.max(0, r.balance), 0),
    );
  return {
    openInvoices: sum("INVOICE"),
    unusedCredit: sum("CREDIT_NOTE"),
    total: receivableSummaryBalanceTotal(rows),
  };
}
