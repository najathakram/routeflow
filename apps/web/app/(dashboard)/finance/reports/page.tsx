"use client";

import React from "react";
import { usePageTitle } from "@/lib/page-title-context";
import { useSearchParams, useRouter } from "next/navigation";
import {
  useArAgingInvoices, useSalesByCustomer, useSalesByItem,
  useCustomerBalanceSummary, useInvoiceDetailsReport, useBadDebtsReport,
  usePaymentsReceivedReport, useTimeToGetPaid, useExpenseDetailsReport,
  useExpensesByCategoryReport, useProfitAndLoss, useCashFlow,
} from "@/lib/api/finance";
import { BarChart2, FileText, DollarSign, TrendingDown, Filter } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import Link from "next/link";

const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(n);
const fmtDate = (s: string | null | undefined) => s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

const REPORT_GROUPS = [
  {
    id: "sales", label: "Sales", icon: BarChart2, color: "text-brand-500 bg-brand-50",
    reports: [
      { id: "sales-by-customer", label: "Sales by Customer", description: "Total sales grouped by customer for a period" },
      { id: "sales-by-item", label: "Sales by Item", description: "Total sales grouped by product or service" },
    ],
  },
  {
    id: "receivables", label: "Receivables", icon: DollarSign, color: "text-orange-500 bg-orange-50",
    reports: [
      { id: "ar-aging", label: "AR Aging Summary", description: "Outstanding invoices categorized by how long they've been due" },
      { id: "invoice-details", label: "Invoice Details", description: "Detailed list of invoices for a selected period" },
      { id: "bad-debts", label: "Bad Debts", description: "Invoices that have been written off as uncollectable" },
      { id: "customer-balance", label: "Customer Balance Summary", description: "Outstanding balance per customer" },
    ],
  },
  {
    id: "payments", label: "Payments Received", icon: FileText, color: "text-success bg-success-bg",
    reports: [
      { id: "payments-received", label: "Payments Received", description: "All payments received within a date range" },
      { id: "time-to-get-paid", label: "Time to Get Paid", description: "Average days from invoice date to payment" },
    ],
  },
  {
    id: "expenses", label: "Purchases & Expenses", icon: TrendingDown, color: "text-danger bg-danger-bg",
    reports: [
      { id: "expense-details", label: "Expense Details", description: "Itemized list of all expenses" },
      { id: "expenses-by-category", label: "Expenses by Category", description: "Total expenses grouped by category" },
    ],
  },
  {
    id: "pnl", label: "Profit & Loss", icon: TrendingDown, color: "text-purple-500 bg-purple-50",
    reports: [
      { id: "pl", label: "Profit & Loss", description: "Revenue, COGS, and expenses for a period" },
      { id: "cashflow", label: "Cash Flow", description: "Cash inflows and outflows for a period" },
    ],
  },
];

// ─── Individual Report Renderers ─────────────────────────────────────────────

function ArAgingReport() {
  const { data, isLoading } = useArAgingInvoices();
  if (isLoading) return <Spinner />;
  const buckets = data?.buckets ?? { current: [], days1_30: [], days31_60: [], days61_90: [], days90plus: [] };
  const totals = data?.totals ?? { current: 0, days1_30: 0, days31_60: 0, days61_90: 0, days90plus: 0, total: 0 };
  const cols = [
    { key: "current" as const, label: "Current" },
    { key: "days1_30" as const, label: "1–30 days" },
    { key: "days31_60" as const, label: "31–60 days" },
    { key: "days61_90" as const, label: "61–90 days" },
    { key: "days90plus" as const, label: "90+ days" },
  ];
  const customerMap: Record<string, { name: string; buckets: Record<string, number> }> = {};
  for (const [bKey, items] of Object.entries(buckets)) {
    for (const item of items as Array<{ customer: { id: string; businessName: string }; balance: number }>) {
      if (!customerMap[item.customer.id]) customerMap[item.customer.id] = { name: item.customer.businessName, buckets: {} };
      customerMap[item.customer.id].buckets[bKey] = (customerMap[item.customer.id].buckets[bKey] ?? 0) + item.balance;
    }
  }
  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-surface-border bg-navy text-white">
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Customer</th>
            {cols.map(c => <th key={c.key} className="px-4 py-3 text-right text-xs font-semibold uppercase">{c.label}</th>)}
            <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-border">
          {Object.entries(customerMap).map(([id, c]) => {
            const rowTotal = cols.reduce((s, col) => s + (c.buckets[col.key] ?? 0), 0);
            return (
              <tr key={id} className="hover:bg-surface-raised/50">
                <td className="px-4 py-2.5 font-medium text-brand-600">{c.name}</td>
                {cols.map(col => <td key={col.key} className="px-4 py-2.5 text-right text-navy">{c.buckets[col.key] ? fmt(c.buckets[col.key]) : "—"}</td>)}
                <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(rowTotal)}</td>
              </tr>
            );
          })}
          {Object.keys(customerMap).length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-navy/40">No outstanding invoices</td></tr>}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-navy bg-surface-raised">
            <td className="px-4 py-2.5 font-semibold text-navy">Total</td>
            {cols.map(col => <td key={col.key} className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(totals[col.key])}</td>)}
            <td className="px-4 py-2.5 text-right font-bold text-navy">{fmt(totals.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function SalesByCustomerReport({ from, to }: { from?: string; to?: string }) {
  const { data, isLoading } = useSalesByCustomer(from, to);
  if (isLoading) return <Spinner />;
  const rows: Array<{ customerId: string; businessName: string; invoiceCount: number; salesAmount: number }> = data?.data ?? [];
  const grandTotal = rows.reduce((s, r) => s + r.salesAmount, 0);
  return (
    <table className="w-full text-sm">
      <thead><tr className="border-b border-surface-border bg-navy text-white">
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Customer</th>
        <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Invoices</th>
        <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Sales Amount</th>
      </tr></thead>
      <tbody className="divide-y divide-surface-border">
        {rows.length === 0 && <tr><td colSpan={3} className="px-4 py-8 text-center text-navy/40">No sales in this period</td></tr>}
        {rows.map((r) => (
          <tr key={r.customerId} className="hover:bg-surface-raised/50">
            <td className="px-4 py-2.5 font-medium text-brand-600">{r.businessName}</td>
            <td className="px-4 py-2.5 text-right text-navy">{r.invoiceCount}</td>
            <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(r.salesAmount)}</td>
          </tr>
        ))}
      </tbody>
      {rows.length > 0 && <tfoot><tr className="border-t-2 border-navy bg-surface-raised">
        <td className="px-4 py-2.5 font-semibold text-navy" colSpan={2}>Total</td>
        <td className="px-4 py-2.5 text-right font-bold text-navy">{fmt(grandTotal)}</td>
      </tr></tfoot>}
    </table>
  );
}

function SalesByItemReport({ from, to }: { from?: string; to?: string }) {
  const { data, isLoading } = useSalesByItem(from, to);
  if (isLoading) return <Spinner />;
  const rows: Array<{ name: string; qty: number; amount: number }> = data?.data ?? [];
  const grandTotal = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <table className="w-full text-sm">
      <thead><tr className="border-b border-surface-border bg-navy text-white">
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Item / Product</th>
        <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Qty Sold</th>
        <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Sales Amount</th>
      </tr></thead>
      <tbody className="divide-y divide-surface-border">
        {rows.length === 0 && <tr><td colSpan={3} className="px-4 py-8 text-center text-navy/40">No sales in this period</td></tr>}
        {rows.map((r, i) => (
          <tr key={i} className="hover:bg-surface-raised/50">
            <td className="px-4 py-2.5 font-medium text-navy">{r.name}</td>
            <td className="px-4 py-2.5 text-right text-navy">{Number(r.qty).toFixed(2)}</td>
            <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(r.amount)}</td>
          </tr>
        ))}
      </tbody>
      {rows.length > 0 && <tfoot><tr className="border-t-2 border-navy bg-surface-raised">
        <td className="px-4 py-2.5 font-semibold text-navy" colSpan={2}>Total</td>
        <td className="px-4 py-2.5 text-right font-bold text-navy">{fmt(grandTotal)}</td>
      </tr></tfoot>}
    </table>
  );
}

function InvoiceDetailsReport({ from, to }: { from?: string; to?: string }) {
  const { data, isLoading } = useInvoiceDetailsReport(from, to);
  if (isLoading) return <Spinner />;
  const rows: Array<{ id: string; invoiceNumber: string; issueDate: string; customer: { businessName: string }; status: string; total: number; balance: number }> = data?.data ?? [];
  return (
    <table className="w-full text-sm">
      <thead><tr className="border-b border-surface-border bg-navy text-white">
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Date</th>
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Invoice #</th>
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Customer</th>
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Status</th>
        <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Total</th>
        <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Balance</th>
      </tr></thead>
      <tbody className="divide-y divide-surface-border">
        {rows.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-navy/40">No invoices in this period</td></tr>}
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-surface-raised/50">
            <td className="px-4 py-2.5 text-navy/70">{fmtDate(r.issueDate)}</td>
            <td className="px-4 py-2.5"><Link href={`/invoices/${r.id}`} className="font-medium text-brand-600 hover:underline">{r.invoiceNumber}</Link></td>
            <td className="px-4 py-2.5 text-navy">{r.customer?.businessName}</td>
            <td className="px-4 py-2.5"><span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-navy/60">{r.status}</span></td>
            <td className="px-4 py-2.5 text-right text-navy">{fmt(r.total)}</td>
            <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(r.balance)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BadDebtsReport() {
  const { data, isLoading } = useBadDebtsReport();
  if (isLoading) return <Spinner />;
  const rows: Array<{ id: string; invoiceNumber: string; customer: { businessName: string }; writtenOffAt: string; writeOffReason?: string; balance: number }> = data?.data ?? [];
  return (
    <table className="w-full text-sm">
      <thead><tr className="border-b border-surface-border bg-navy text-white">
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Invoice #</th>
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Customer</th>
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Written Off</th>
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Reason</th>
        <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Amount Written Off</th>
      </tr></thead>
      <tbody className="divide-y divide-surface-border">
        {rows.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-navy/40">No bad debts recorded</td></tr>}
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-surface-raised/50">
            <td className="px-4 py-2.5"><Link href={`/invoices/${r.id}`} className="font-medium text-brand-600 hover:underline">{r.invoiceNumber}</Link></td>
            <td className="px-4 py-2.5 text-navy">{r.customer?.businessName}</td>
            <td className="px-4 py-2.5 text-navy/70">{fmtDate(r.writtenOffAt)}</td>
            <td className="px-4 py-2.5 text-navy/60 max-w-xs truncate">{r.writeOffReason ?? "—"}</td>
            <td className="px-4 py-2.5 text-right font-semibold text-danger">{fmt(r.balance)}</td>
          </tr>
        ))}
      </tbody>
      {rows.length > 0 && <tfoot><tr className="border-t-2 border-navy bg-surface-raised">
        <td colSpan={4} className="px-4 py-2.5 font-semibold text-navy">Total Bad Debts</td>
        <td className="px-4 py-2.5 text-right font-bold text-danger">{fmt((data as { total?: number })?.total ?? 0)}</td>
      </tr></tfoot>}
    </table>
  );
}

function CustomerBalanceReport() {
  const { data, isLoading } = useCustomerBalanceSummary();
  if (isLoading) return <Spinner />;
  const rows = data?.data ?? [];
  return (
    <table className="w-full text-sm">
      <thead><tr className="border-b border-surface-border bg-navy text-white">
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Customer</th>
        <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Open Invoices</th>
        <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Outstanding</th>
        <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Overdue</th>
      </tr></thead>
      <tbody className="divide-y divide-surface-border">
        {rows.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-navy/40">No outstanding balances</td></tr>}
        {rows.map((r) => (
          <tr key={r.customerId} className="hover:bg-surface-raised/50">
            <td className="px-4 py-2.5 font-medium text-brand-600">{r.businessName}</td>
            <td className="px-4 py-2.5 text-right text-navy">{r.invoiceCount}</td>
            <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(r.balance)}</td>
            <td className="px-4 py-2.5 text-right font-semibold text-danger">{r.overdue > 0 ? fmt(r.overdue) : "—"}</td>
          </tr>
        ))}
      </tbody>
      {rows.length > 0 && <tfoot><tr className="border-t-2 border-navy bg-surface-raised">
        <td colSpan={2} className="px-4 py-2.5 font-semibold text-navy">Total</td>
        <td className="px-4 py-2.5 text-right font-bold text-navy">{fmt(rows.reduce((s, r) => s + r.balance, 0))}</td>
        <td className="px-4 py-2.5 text-right font-bold text-danger">{fmt(rows.reduce((s, r) => s + r.overdue, 0))}</td>
      </tr></tfoot>}
    </table>
  );
}

function PaymentsReceivedReport({ from, to }: { from?: string; to?: string }) {
  const { data, isLoading } = usePaymentsReceivedReport(from, to);
  if (isLoading) return <Spinner />;
  const rows: Array<{ id: string; createdAt: string; invoiceId: string; invoiceNumber: string; customer: { businessName: string }; method: string; reference?: string; amount: number }> = data?.data ?? [];
  const dataTotal = (data as { total?: number })?.total ?? 0;
  return (
    <div>
      {dataTotal > 0 && <div className="mb-4 rounded-lg bg-success-bg px-4 py-3 text-sm font-medium text-success">Total Received: {fmt(dataTotal)}</div>}
      <table className="w-full text-sm">
        <thead><tr className="border-b border-surface-border bg-navy text-white">
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Date</th>
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Invoice #</th>
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Customer</th>
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Method</th>
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Reference</th>
          <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Amount</th>
        </tr></thead>
        <tbody className="divide-y divide-surface-border">
          {rows.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-navy/40">No payments in this period</td></tr>}
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-surface-raised/50">
              <td className="px-4 py-2.5 text-navy/70">{fmtDate(r.createdAt)}</td>
              <td className="px-4 py-2.5"><Link href={`/invoices/${r.invoiceId}`} className="font-medium text-brand-600 hover:underline">{r.invoiceNumber}</Link></td>
              <td className="px-4 py-2.5 text-navy">{r.customer?.businessName}</td>
              <td className="px-4 py-2.5 text-navy/60">{r.method}</td>
              <td className="px-4 py-2.5 text-navy/60">{r.reference ?? "—"}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-success">{fmt(r.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TimeToGetPaidReport({ from, to }: { from?: string; to?: string }) {
  const { data, isLoading } = useTimeToGetPaid(from, to);
  if (isLoading) return <Spinner />;
  const rows: Array<{ id: string; invoiceNumber: string; customer: { businessName: string }; issueDate: string; paidAt: string; daysToPayment?: number; total: number }> = data?.data ?? [];
  const averageDays = (data as { averageDays?: number })?.averageDays ?? 0;
  return (
    <div>
      <div className="mb-4 rounded-lg bg-brand-50 px-4 py-3">
        <p className="text-xs text-navy/60">Average Days to Get Paid</p>
        <p className="text-3xl font-bold text-brand-600">{averageDays} days</p>
      </div>
      <table className="w-full text-sm">
        <thead><tr className="border-b border-surface-border bg-navy text-white">
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Invoice #</th>
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Customer</th>
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Issued</th>
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Paid</th>
          <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Days</th>
          <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Amount</th>
        </tr></thead>
        <tbody className="divide-y divide-surface-border">
          {rows.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-navy/40">No paid invoices in this period</td></tr>}
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-surface-raised/50">
              <td className="px-4 py-2.5"><Link href={`/invoices/${r.id}`} className="font-medium text-brand-600 hover:underline">{r.invoiceNumber}</Link></td>
              <td className="px-4 py-2.5 text-navy">{r.customer?.businessName}</td>
              <td className="px-4 py-2.5 text-navy/70">{fmtDate(r.issueDate)}</td>
              <td className="px-4 py-2.5 text-navy/70">{fmtDate(r.paidAt)}</td>
              <td className="px-4 py-2.5 text-right text-navy">{r.daysToPayment ?? "—"}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExpenseDetailsReport({ from, to }: { from?: string; to?: string }) {
  const { data, isLoading } = useExpenseDetailsReport(from, to);
  if (isLoading) return <Spinner />;
  const rows: Array<{ id: string; date: string; category: { name: string }; supplier?: { name: string }; description?: string; amount: number }> = data?.data ?? [];
  const dataTotal = (data as { total?: number })?.total ?? 0;
  return (
    <div>
      {dataTotal > 0 && <div className="mb-4 rounded-lg bg-danger-bg px-4 py-3 text-sm font-medium text-danger">Total Expenses: {fmt(dataTotal)}</div>}
      <table className="w-full text-sm">
        <thead><tr className="border-b border-surface-border bg-navy text-white">
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Date</th>
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Category</th>
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Supplier</th>
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Description</th>
          <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Amount</th>
        </tr></thead>
        <tbody className="divide-y divide-surface-border">
          {rows.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-navy/40">No expenses in this period</td></tr>}
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-surface-raised/50">
              <td className="px-4 py-2.5 text-navy/70">{fmtDate(r.date)}</td>
              <td className="px-4 py-2.5 font-medium text-navy">{r.category?.name}</td>
              <td className="px-4 py-2.5 text-navy/60">{r.supplier?.name ?? "—"}</td>
              <td className="px-4 py-2.5 text-navy/60 max-w-xs truncate">{r.description ?? "—"}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(r.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExpensesByCategoryReport({ from, to }: { from?: string; to?: string }) {
  const { data, isLoading } = useExpensesByCategoryReport(from, to);
  if (isLoading) return <Spinner />;
  const rows: Array<{ categoryId: string; categoryName: string; count: number; total: number }> = data?.data ?? [];
  const grandTotal = (data as { grandTotal?: number })?.grandTotal ?? 0;
  return (
    <table className="w-full text-sm">
      <thead><tr className="border-b border-surface-border bg-navy text-white">
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Category</th>
        <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Count</th>
        <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Total</th>
        <th className="px-4 py-3 text-right text-xs font-semibold uppercase">% of Total</th>
      </tr></thead>
      <tbody className="divide-y divide-surface-border">
        {rows.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-navy/40">No expenses in this period</td></tr>}
        {rows.map((r) => (
          <tr key={r.categoryId} className="hover:bg-surface-raised/50">
            <td className="px-4 py-2.5 font-medium text-navy">{r.categoryName}</td>
            <td className="px-4 py-2.5 text-right text-navy">{r.count}</td>
            <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(r.total)}</td>
            <td className="px-4 py-2.5 text-right text-navy/60">{grandTotal > 0 ? `${((r.total / grandTotal) * 100).toFixed(1)}%` : "—"}</td>
          </tr>
        ))}
      </tbody>
      {rows.length > 0 && <tfoot><tr className="border-t-2 border-navy bg-surface-raised">
        <td colSpan={2} className="px-4 py-2.5 font-semibold text-navy">Total</td>
        <td className="px-4 py-2.5 text-right font-bold text-navy">{fmt(grandTotal)}</td>
        <td />
      </tr></tfoot>}
    </table>
  );
}

function ProfitLossReport({ from, to }: { from?: string; to?: string }) {
  const { data, isLoading } = useProfitAndLoss(from, to);
  if (isLoading) return <Spinner />;
  if (!data) return null;
  const d = data as { revenue: number; cogs: number; grossProfit: number; operatingExpenses: number; netProfit: number; expensesByCategory?: Record<string, number> };
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-surface-border bg-white p-4">
          <p className="text-xs text-navy/40 uppercase font-medium">Revenue</p>
          <p className="text-2xl font-bold text-success mt-1">{fmt(d.revenue)}</p>
        </div>
        <div className="rounded-xl border border-surface-border bg-white p-4">
          <p className="text-xs text-navy/40 uppercase font-medium">Operating Expenses</p>
          <p className="text-2xl font-bold text-danger mt-1">{fmt(d.operatingExpenses)}</p>
        </div>
        <div className={cn("rounded-xl border p-4", d.netProfit >= 0 ? "border-success/30 bg-success-bg" : "border-danger/30 bg-danger-bg")}>
          <p className="text-xs text-navy/40 uppercase font-medium">Net Profit</p>
          <p className={cn("text-2xl font-bold mt-1", d.netProfit >= 0 ? "text-success" : "text-danger")}>{fmt(d.netProfit)}</p>
        </div>
      </div>
      <div className="rounded-xl border border-surface-border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-surface-border bg-navy text-white"><th className="px-4 py-3 text-left text-xs font-semibold uppercase" colSpan={2}>Profit &amp; Loss Statement</th></tr></thead>
          <tbody className="divide-y divide-surface-border">
            <tr className="bg-surface-raised/50"><td className="px-4 py-2.5 font-semibold text-navy">Revenue</td><td className="px-4 py-2.5 text-right font-semibold text-success">{fmt(d.revenue)}</td></tr>
            <tr><td className="px-4 py-2.5 pl-8 text-navy/70">Cost of Goods Sold</td><td className="px-4 py-2.5 text-right text-navy">{fmt(d.cogs)}</td></tr>
            <tr className="bg-surface-raised/50"><td className="px-4 py-2.5 font-semibold text-navy">Gross Profit</td><td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(d.grossProfit)}</td></tr>
            {Object.entries(d.expensesByCategory ?? {}).map(([cat, amt]) => (
              <tr key={cat}><td className="px-4 py-2.5 pl-8 text-navy/70">{cat}</td><td className="px-4 py-2.5 text-right text-navy">{fmt(amt as number)}</td></tr>
            ))}
            <tr className="bg-surface-raised/50"><td className="px-4 py-2.5 font-semibold text-navy">Total Operating Expenses</td><td className="px-4 py-2.5 text-right font-semibold text-danger">{fmt(d.operatingExpenses)}</td></tr>
            <tr className="border-t-2 border-navy"><td className="px-4 py-3 font-bold text-navy">Net Profit</td><td className={cn("px-4 py-3 text-right font-bold text-lg", d.netProfit >= 0 ? "text-success" : "text-danger")}>{fmt(d.netProfit)}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CashFlowReport({ from, to }: { from?: string; to?: string }) {
  const { data, isLoading } = useCashFlow(from, to);
  if (isLoading) return <Spinner />;
  if (!data) return null;
  const d = data as { totalIn: number; totalOut: number; netCashFlow: number };
  return (
    <div className="grid grid-cols-3 gap-4">
      <div className="rounded-xl border border-success/30 bg-success-bg p-4">
        <p className="text-xs text-navy/40 uppercase font-medium">Cash In</p>
        <p className="text-2xl font-bold text-success mt-1">{fmt(d.totalIn)}</p>
      </div>
      <div className="rounded-xl border border-danger/30 bg-danger-bg p-4">
        <p className="text-xs text-navy/40 uppercase font-medium">Cash Out</p>
        <p className="text-2xl font-bold text-danger mt-1">{fmt(d.totalOut)}</p>
      </div>
      <div className={cn("rounded-xl border p-4", d.netCashFlow >= 0 ? "border-brand-200 bg-brand-50" : "border-danger/30 bg-danger-bg")}>
        <p className="text-xs text-navy/40 uppercase font-medium">Net Cash Flow</p>
        <p className={cn("text-2xl font-bold mt-1", d.netCashFlow >= 0 ? "text-brand-600" : "text-danger")}>{fmt(d.netCashFlow)}</p>
      </div>
    </div>
  );
}

function Spinner() {
  return <div className="flex h-32 items-center justify-center"><div className="h-6 w-6 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" /></div>;
}

// ─── Report Viewer ────────────────────────────────────────────────────────────

function ReportViewer({ reportId, from, to }: { reportId: string; from?: string; to?: string }) {
  switch (reportId) {
    case "ar-aging": return <ArAgingReport />;
    case "sales-by-customer": return <SalesByCustomerReport from={from} to={to} />;
    case "sales-by-item": return <SalesByItemReport from={from} to={to} />;
    case "invoice-details": return <InvoiceDetailsReport from={from} to={to} />;
    case "bad-debts": return <BadDebtsReport />;
    case "customer-balance": return <CustomerBalanceReport />;
    case "payments-received": return <PaymentsReceivedReport from={from} to={to} />;
    case "time-to-get-paid": return <TimeToGetPaidReport from={from} to={to} />;
    case "expense-details": return <ExpenseDetailsReport from={from} to={to} />;
    case "expenses-by-category": return <ExpensesByCategoryReport from={from} to={to} />;
    case "pl": return <ProfitLossReport from={from} to={to} />;
    case "cashflow": return <CashFlowReport from={from} to={to} />;
    default: return <div className="p-8 text-center text-navy/40">Report not found</div>;
  }
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function FinanceReportsContent() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => { setTitle("Reports"); }, [setTitle]);
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeReport = searchParams.get("report") ?? "";

  const currentYear = new Date().getFullYear();
  const [from, setFrom] = React.useState(`${currentYear}-01-01`);
  const [to, setTo] = React.useState(new Date().toISOString().split("T")[0]);

  const activeInfo = REPORT_GROUPS.flatMap(g => g.reports).find(r => r.id === activeReport);
  const needsDates = !["ar-aging", "bad-debts", "customer-balance"].includes(activeReport);

  const selectReport = (id: string) => {
    router.push(`/finance/reports?report=${id}`);
  };

  return (
    <div className="flex h-full">
      {/* Left: Report catalog */}
      <div className="w-72 shrink-0 overflow-y-auto border-r border-surface-border bg-white">
        <div className="border-b border-surface-border px-4 py-4">
          <h2 className="text-sm font-semibold text-navy">All Reports</h2>
        </div>
        <div className="py-2">
          {REPORT_GROUPS.map((group) => {
            const Icon = group.icon;
            return (
              <div key={group.id} className="mb-1">
                <div className="flex items-center gap-2 px-4 py-2">
                  <span className={cn("flex h-6 w-6 items-center justify-center rounded", group.color)}>
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span className="text-xs font-semibold uppercase tracking-wide text-navy/50">{group.label}</span>
                </div>
                {group.reports.map((report) => (
                  <button
                    key={report.id}
                    onClick={() => selectReport(report.id)}
                    className={cn(
                      "w-full px-4 py-2 pl-12 text-left text-sm transition-colors hover:bg-surface-raised",
                      activeReport === report.id ? "bg-brand-50 text-brand-600 font-medium" : "text-navy/70",
                    )}
                  >
                    {report.label}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* Right: Report viewer */}
      <div className="flex-1 overflow-y-auto">
        {!activeReport ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50">
              <BarChart2 className="h-8 w-8 text-brand-500" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-navy">Select a Report</h3>
              <p className="mt-1 text-sm text-navy/60">Choose a report from the left panel to view your financial data</p>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 w-full max-w-lg">
              {REPORT_GROUPS.flatMap(g => g.reports).slice(0, 4).map((r) => (
                <button key={r.id} onClick={() => selectReport(r.id)} className="rounded-xl border border-surface-border bg-white p-4 text-left hover:shadow-sm transition-shadow">
                  <p className="text-sm font-medium text-navy">{r.label}</p>
                  <p className="mt-0.5 text-xs text-navy/50">{r.description}</p>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="p-6 space-y-5">
            {/* Report header */}
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-navy">{activeInfo?.label ?? activeReport}</h2>
                <p className="text-sm text-navy/60">{activeInfo?.description}</p>
              </div>
              {needsDates && (
                <div className="flex items-center gap-2">
                  <Filter className="h-4 w-4 text-navy/40" />
                  <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="rounded-lg border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
                  <span className="text-navy/40">to</span>
                  <input type="date" value={to} onChange={e => setTo(e.target.value)} className="rounded-lg border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
                </div>
              )}
            </div>
            {/* Report content */}
            <div className="rounded-xl border border-surface-border bg-white overflow-hidden">
              <ReportViewer reportId={activeReport} from={needsDates ? from : undefined} to={needsDates ? to : undefined} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function FinanceReportsPage() {
  return (
    <React.Suspense fallback={<div className="flex h-64 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" /></div>}>
      <FinanceReportsContent />
    </React.Suspense>
  );
}
