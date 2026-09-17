import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";

/**
 * P10-PAR-6 — mobile Finance Reports parity (operator, READ-ONLY).
 *
 * Mirrors the report hooks in `apps/web/lib/api/finance.ts` (the golden
 * reference) for the v1 subset: P&L, Cash Flow, Sales by Customer, Sales by
 * Item, and AR Aging. Every value is **server-computed** — screens render what
 * the server returns via `fmtCurrency` and NEVER re-derive a total client-side,
 * so there is no `pricing.ts` write-path (this is a display surface only).
 *
 * queryKeys mirror web exactly (`["reports", <name>, from, to]`) so the two
 * clients share the cache contract.
 */

// ─── Types (mirror the bookkeeping report responses) ────────────────────────────

export interface ProfitAndLoss {
  revenue: number;
  cogs: number;
  grossProfit: number;
  operatingExpenses: number;
  /** B456: unpaid pre-tax share of invoices WRITTEN_OFF in the window. */
  badDebtExpense?: number;
  netProfit: number;
  netMarginPct?: number;
  expensesByCategory?: Record<string, number>;
}

export interface CashFlow {
  totalIn: number;
  totalOut: number;
  netCashFlow: number;
}

/** Wave E / imp-10b R2: renamed from `SalesByCustomerRow` — collided in name
 *  (with a genuinely different field set) with `./admin.ts`'s report row of
 *  the same name; disambiguated rather than shared. */
export interface ReportSalesByCustomerRow {
  customerId: string;
  businessName: string;
  invoiceCount: number;
  salesAmount: number;
}

/** Wave E / imp-10b R2: renamed from `SalesByItemRow` — see `ReportSalesByCustomerRow`. */
export interface ReportSalesByItemRow {
  productId: string | null;
  name: string;
  qty: number;
  amount: number;
}

export interface ArAgingEntry {
  id: string;
  invoiceNumber: string;
  customer: { id: string; businessName: string };
  total: number;
  balance: number;
  dueDate?: string;
  status: string;
}

export interface ArAgingReportData {
  /** Bucket keys are interval-dependent — see `arAgingColumns()` in reports-logic. */
  buckets: Record<string, ArAgingEntry[]>;
  totals: Record<string, number> & { total: number };
  intervalDays: number;
}

// ─── Queries ────────────────────────────────────────────────────────────────────

export function useProfitAndLoss(from?: string, to?: string) {
  return useQuery<ProfitAndLoss>({
    queryKey: ["reports", "pl", from, to],
    queryFn: () =>
      apiClient.get("/bookkeeping/reports/pl", { params: { from, to } }).then((r) => r.data),
  });
}

export function useCashFlow(from?: string, to?: string) {
  return useQuery<CashFlow>({
    queryKey: ["reports", "cashflow", from, to],
    queryFn: () =>
      apiClient.get("/bookkeeping/reports/cashflow", { params: { from, to } }).then((r) => r.data),
  });
}

export function useSalesByCustomer(from?: string, to?: string) {
  return useQuery<{ data: ReportSalesByCustomerRow[] }>({
    queryKey: ["reports", "sales-by-customer", from, to],
    queryFn: () =>
      apiClient
        .get("/bookkeeping/reports/sales-by-customer", { params: { from, to } })
        .then((r) => r.data),
  });
}

export function useSalesByItem(from?: string, to?: string) {
  return useQuery<{ data: ReportSalesByItemRow[] }>({
    queryKey: ["reports", "sales-by-item", from, to],
    queryFn: () =>
      apiClient
        .get("/bookkeeping/reports/sales-by-item", { params: { from, to } })
        .then((r) => r.data),
  });
}

/** AR Aging is interval-driven (`intervalDays`), NOT a date range — see the web
 * `needsDates=false` bucket. Server defaults to 30 when the param is omitted. */
export function useArAgingInvoices(intervalDays: number) {
  return useQuery<ArAgingReportData>({
    queryKey: ["reports", "ar-aging-invoices", intervalDays],
    queryFn: () =>
      apiClient
        .get("/bookkeeping/reports/ar-aging-invoices", { params: { intervalDays } })
        .then((r) => r.data),
  });
}
