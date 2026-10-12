import { roundMoney } from "@routeflow/pricing";

/**
 * The Receivable Summary footer's balance total. OWNER RULING 2026-10-11: the report's invoice ROWS
 * show an overpayment as a negative balance, but the footer stays a receivables total (what is owed):
 * each row contributes max(0, balance), so an overpaid invoice never nets against what other invoices
 * owe. Same clamp as every other receivables total (row 310). Rounded to cents; never -0.
 */
export function receivableSummaryBalanceTotal(rows: ReadonlyArray<{ balance: number }>): number {
  return roundMoney(rows.reduce((sum, r) => sum + Math.max(0, r.balance), 0));
}
