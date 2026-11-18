import { roundMoney } from "@routeflow/pricing";
import { OPEN_INVOICE_STATUS_VALUES, type InvoiceStatus } from "@routeflow/types";

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
 * UX guide B7: the footer's lines. `total` IS `receivableSummaryBalanceTotal(rows)` (not re-added), so the bottom
 * line cannot drift from today's figure; the other three say what it is made of: open invoices issued in the period
 * (clamped balances, statuses in OPEN_INVOICE_STATUS_VALUES; AR aging covers every open invoice regardless of date),
 * written-off invoices (the report keeps their unpaid balance, a write-off records no payment) and unused credit
 * (open CREDIT_NOTE balances). Every row is one of these or a PAYMENT row (0), so total = the three lines added.
 */
export function receivableSummaryBreakdown(
  rows: ReadonlyArray<{ type: string; status: string; balance: number }>,
): {
  openInvoices: number;
  writtenOff: number;
  unusedCredit: number;
  total: number;
} {
  const open: readonly string[] = OPEN_INVOICE_STATUS_VALUES;
  const writtenOffStatus: InvoiceStatus = "WRITTEN_OFF";
  const sum = (keep: (r: { type: string; status: string }) => boolean) =>
    roundMoney(rows.filter(keep).reduce((acc, r) => acc + Math.max(0, r.balance), 0));
  return {
    openInvoices: sum((r) => r.type === "INVOICE" && open.includes(r.status)),
    writtenOff: sum((r) => r.type === "INVOICE" && r.status === writtenOffStatus),
    unusedCredit: sum((r) => r.type === "CREDIT_NOTE"),
    total: receivableSummaryBalanceTotal(rows),
  };
}
