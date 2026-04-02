"use client";

import React from "react";
import { usePageTitle } from "@/lib/page-title-context";
import { useSearchParams, useRouter } from "next/navigation";
import {
  useArAgingInvoices, useSalesByCustomer, useSalesByItem,
  useCustomerBalanceSummary, useInvoiceDetailsReport, useBadDebtsReport,
  usePaymentsReceivedReport, useTimeToGetPaid, useExpenseDetailsReport,
  useExpensesByCategoryReport, useProfitAndLoss, useCashFlow,
  useSalesByDriver, useArAgingDetails, useEstimateDetails,
  useRefundHistory, useReceivableSummary, useExpensesByCustomer,
} from "@/lib/api/finance";
import { ReportToolbar } from "@/components/ReportToolbar";
import { exportReportCSV, printReport } from "@/lib/report-export";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, PieChart, Pie, Cell,
} from "recharts";
import { BarChart2, FileText, DollarSign, TrendingDown, Filter, BookOpen, Download, Printer } from "lucide-react";
import { cn, useToast, type ToastVariant } from "@routeflow/ui/web";
import Link from "next/link";
import { useTransactions, useRecordPayment, type Transaction } from "@/lib/api/bookkeeping";
import { fmt, fmtDate } from "@/lib/formatting";

const CHART_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1"];

const chartTooltipStyle = {
  contentStyle: {
    backgroundColor: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: "8px",
    fontSize: "13px",
    boxShadow: "0 4px 6px -1px rgba(0,0,0,0.1)",
  },
};

const REPORT_GROUPS = [
  {
    id: "sales", label: "Sales", icon: BarChart2, color: "text-brand-500 bg-brand-50",
    reports: [
      { id: "sales-by-customer", label: "Sales by Customer", description: "Total sales grouped by customer for a period" },
      { id: "sales-by-item", label: "Sales by Item", description: "Total sales grouped by product or service" },
      { id: "sales-by-driver", label: "Sales by Driver", description: "Total sales grouped by delivery driver" },
    ],
  },
  {
    id: "receivables", label: "Receivables", icon: DollarSign, color: "text-orange-500 bg-orange-50",
    reports: [
      { id: "ar-aging", label: "AR Aging Summary", description: "Outstanding invoices categorized by how long they've been due" },
      { id: "ar-aging-details", label: "AR Aging Details", description: "Line-by-line aging of unpaid invoices" },
      { id: "invoice-details", label: "Invoice Details", description: "Detailed list of invoices for a selected period" },
      { id: "bad-debts", label: "Bad Debts", description: "Invoices that have been written off as uncollectable" },
      { id: "customer-balance", label: "Customer Balance Summary", description: "Outstanding balance per customer" },
      { id: "estimate-details", label: "Estimate Details", description: "Detailed list of all estimates/quotes" },
      { id: "receivable-summary", label: "Receivable Summary", description: "All receivable transactions in date order" },
    ],
  },
  {
    id: "payments", label: "Payments Received", icon: FileText, color: "text-success bg-success-bg",
    reports: [
      { id: "payments-received", label: "Payments Received", description: "All payments received within a date range" },
      { id: "time-to-get-paid", label: "Time to Get Paid", description: "Average days from invoice date to payment" },
      { id: "refund-history", label: "Refund History", description: "History of voided payments and credit note refunds" },
    ],
  },
  {
    id: "expenses", label: "Purchases & Expenses", icon: TrendingDown, color: "text-danger bg-danger-bg",
    reports: [
      { id: "expense-details", label: "Expense Details", description: "Itemized list of all expenses" },
      { id: "expenses-by-category", label: "Expenses by Category", description: "Total expenses grouped by category" },
      { id: "expenses-by-customer", label: "Expenses by Customer", description: "Total expenses grouped by customer" },
    ],
  },
  {
    id: "pnl", label: "Profit & Loss", icon: TrendingDown, color: "text-purple-500 bg-purple-50",
    reports: [
      { id: "pl", label: "Profit & Loss", description: "Revenue, COGS, and expenses for a period" },
      { id: "cashflow", label: "Cash Flow", description: "Cash inflows and outflows for a period" },
    ],
  },
  {
    id: "ledger", label: "Transaction Ledger", icon: BookOpen, color: "text-navy bg-navy/10",
    reports: [
      { id: "ledger", label: "Transactions Ledger", description: "View and manage all financial transactions with payment recording" },
    ],
  },
];

// ─── Individual Report Renderers ─────────────────────────────────────────────

function ArAgingReport({ onSelectReport }: { onSelectReport?: (id: string) => void }) {
  const { data, isLoading } = useArAgingInvoices();
  if (isLoading) return <Spinner />;
  const buckets = data?.buckets ?? { current: [], days1_30: [], days31_60: [], days61_90: [], days90plus: [] };
  const totals = data?.totals ?? { current: 0, days1_30: 0, days31_60: 0, days61_90: 0, days90plus: 0, total: 0 };
  const cols = [
    { key: "current" as const, label: "Current" },
    { key: "days1_30" as const, label: "1-30 days" },
    { key: "days31_60" as const, label: "31-60 days" },
    { key: "days61_90" as const, label: "61-90 days" },
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
              <tr
                key={id}
                className={cn("hover:bg-surface-raised/50", onSelectReport && "cursor-pointer")}
                onClick={() => onSelectReport?.("ar-aging-details")}
              >
                <td className="px-4 py-2.5 font-medium text-brand-600">{c.name}</td>
                {cols.map(col => <td key={col.key} className="px-4 py-2.5 text-right text-navy">{c.buckets[col.key] ? fmt(c.buckets[col.key]) : "\u2014"}</td>)}
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

function SalesByCustomerReport({ from, to, onSelectReport }: { from?: string; to?: string; onSelectReport?: (id: string) => void }) {
  const { data, isLoading } = useSalesByCustomer(from, to);
  if (isLoading) return <Spinner />;
  const rows: Array<{ customerId: string; businessName: string; invoiceCount: number; salesAmount: number }> = data?.data ?? [];
  const grandTotal = rows.reduce((s, r) => s + r.salesAmount, 0);

  const chartData = rows
    .sort((a, b) => b.salesAmount - a.salesAmount)
    .slice(0, 10)
    .map(r => ({ name: r.businessName, salesAmount: r.salesAmount }));

  return (
    <div>
      {chartData.length > 0 && (
        <div className="mb-4 rounded-lg border border-surface-border bg-white p-4">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis type="number" tick={{ fontSize: 12, fill: "#64748b" }} tickFormatter={(v: number) => fmt(v)} />
              <YAxis dataKey="name" type="category" tick={{ fontSize: 12, fill: "#64748b" }} width={140} />
              <Tooltip {...chartTooltipStyle} formatter={(value: number) => fmt(value)} />
              <Bar dataKey="salesAmount" fill={CHART_COLORS[0]} radius={[0, 4, 4, 0]} name="Sales Amount" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <table className="w-full text-sm">
        <thead><tr className="border-b border-surface-border bg-navy text-white">
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Customer</th>
          <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Invoices</th>
          <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Sales Amount</th>
        </tr></thead>
        <tbody className="divide-y divide-surface-border">
          {rows.length === 0 && <tr><td colSpan={3} className="px-4 py-8 text-center text-navy/40">No sales in this period</td></tr>}
          {rows.map((r) => (
            <tr
              key={r.customerId}
              className={cn("hover:bg-surface-raised/50", onSelectReport && "cursor-pointer")}
              onClick={() => onSelectReport?.("customer-balance")}
            >
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
    </div>
  );
}

function SalesByItemReport({ from, to }: { from?: string; to?: string }) {
  const { data, isLoading } = useSalesByItem(from, to);
  if (isLoading) return <Spinner />;
  const rows: Array<{ name: string; qty: number; amount: number }> = data?.data ?? [];
  const grandTotal = rows.reduce((s, r) => s + r.amount, 0);

  const chartData = rows
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10)
    .map(r => ({ name: r.name, amount: r.amount }));

  return (
    <div>
      {chartData.length > 0 && (
        <div className="mb-4 rounded-lg border border-surface-border bg-white p-4">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#64748b" }} interval={0} angle={-30} textAnchor="end" height={70} />
              <YAxis tick={{ fontSize: 12, fill: "#64748b" }} tickFormatter={(v: number) => fmt(v)} />
              <Tooltip {...chartTooltipStyle} formatter={(value: number) => fmt(value)} />
              <Bar dataKey="amount" fill={CHART_COLORS[1]} radius={[4, 4, 0, 0]} name="Sales Amount" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
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
    </div>
  );
}

function SalesByDriverReport({ from, to }: { from?: string; to?: string }) {
  const { data, isLoading } = useSalesByDriver(from, to);
  if (isLoading) return <Spinner />;
  const rows: Array<{ driverName: string; invoiceCount: number; sales: number; salesWithTax: number }> = data?.data ?? [];
  const grandTotal = rows.reduce((s, r) => s + r.sales, 0);

  const chartData = rows
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 10)
    .map(r => ({ name: r.driverName, sales: r.sales }));

  return (
    <div>
      {chartData.length > 0 && (
        <div className="mb-4 rounded-lg border border-surface-border bg-white p-4">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis type="number" tick={{ fontSize: 12, fill: "#64748b" }} tickFormatter={(v: number) => fmt(v)} />
              <YAxis dataKey="name" type="category" tick={{ fontSize: 12, fill: "#64748b" }} width={140} />
              <Tooltip {...chartTooltipStyle} formatter={(value: number) => fmt(value)} />
              <Bar dataKey="sales" fill={CHART_COLORS[4]} radius={[0, 4, 4, 0]} name="Sales" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <table className="w-full text-sm">
        <thead><tr className="border-b border-surface-border bg-navy text-white">
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Driver Name</th>
          <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Invoice Count</th>
          <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Sales</th>
          <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Sales w/ Tax</th>
        </tr></thead>
        <tbody className="divide-y divide-surface-border">
          {rows.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-navy/40">No sales by driver in this period</td></tr>}
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-surface-raised/50">
              <td className="px-4 py-2.5 font-medium text-navy">{r.driverName}</td>
              <td className="px-4 py-2.5 text-right text-navy">{r.invoiceCount}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(r.sales)}</td>
              <td className="px-4 py-2.5 text-right text-navy">{fmt(r.salesWithTax)}</td>
            </tr>
          ))}
        </tbody>
        {rows.length > 0 && <tfoot><tr className="border-t-2 border-navy bg-surface-raised">
          <td className="px-4 py-2.5 font-semibold text-navy" colSpan={2}>Total</td>
          <td className="px-4 py-2.5 text-right font-bold text-navy">{fmt(grandTotal)}</td>
          <td className="px-4 py-2.5 text-right font-bold text-navy">{fmt(rows.reduce((s, r) => s + r.salesWithTax, 0))}</td>
        </tr></tfoot>}
      </table>
    </div>
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
            <td className="px-4 py-2.5 text-navy/60 max-w-xs truncate">{r.writeOffReason ?? "\u2014"}</td>
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

function CustomerBalanceReport({ onSelectReport }: { onSelectReport?: (id: string) => void }) {
  const { data, isLoading } = useCustomerBalanceSummary();
  if (isLoading) return <Spinner />;
  const rows = data?.data ?? [];

  const chartData = rows
    .filter(r => r.balance > 0 || r.overdue > 0)
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 10)
    .map(r => ({ name: r.businessName, outstanding: r.balance, overdue: r.overdue }));

  return (
    <div>
      {chartData.length > 0 && (
        <div className="mb-4 rounded-lg border border-surface-border bg-white p-4">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis type="number" tick={{ fontSize: 12, fill: "#64748b" }} tickFormatter={(v: number) => fmt(v)} />
              <YAxis dataKey="name" type="category" tick={{ fontSize: 12, fill: "#64748b" }} width={140} />
              <Tooltip {...chartTooltipStyle} formatter={(value: number) => fmt(value)} />
              <Legend />
              <Bar dataKey="outstanding" fill={CHART_COLORS[0]} radius={[0, 4, 4, 0]} name="Outstanding" />
              <Bar dataKey="overdue" fill={CHART_COLORS[3]} radius={[0, 4, 4, 0]} name="Overdue" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
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
            <tr
              key={r.customerId}
              className={cn("hover:bg-surface-raised/50", onSelectReport && "cursor-pointer")}
              onClick={() => onSelectReport?.("ar-aging-details")}
            >
              <td className="px-4 py-2.5 font-medium text-brand-600">{r.businessName}</td>
              <td className="px-4 py-2.5 text-right text-navy">{r.invoiceCount}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(r.balance)}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-danger">{r.overdue > 0 ? fmt(r.overdue) : "\u2014"}</td>
            </tr>
          ))}
        </tbody>
        {rows.length > 0 && <tfoot><tr className="border-t-2 border-navy bg-surface-raised">
          <td colSpan={2} className="px-4 py-2.5 font-semibold text-navy">Total</td>
          <td className="px-4 py-2.5 text-right font-bold text-navy">{fmt(rows.reduce((s, r) => s + r.balance, 0))}</td>
          <td className="px-4 py-2.5 text-right font-bold text-danger">{fmt(rows.reduce((s, r) => s + r.overdue, 0))}</td>
        </tr></tfoot>}
      </table>
    </div>
  );
}

function ArAgingDetailsReport({ from, to }: { from?: string; to?: string }) {
  const { data, isLoading } = useArAgingDetails(from, to);
  if (isLoading) return <Spinner />;
  const rows: Array<{
    id: string; date: string; dueDate: string; invoiceNumber: string; status: string;
    customer: { businessName: string }; ageDays: number; amount: number; balance: number;
  }> = data?.data ?? [];
  return (
    <table className="w-full text-sm">
      <thead><tr className="border-b border-surface-border bg-navy text-white">
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Date</th>
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Due Date</th>
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Invoice #</th>
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Status</th>
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Customer</th>
        <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Age (days)</th>
        <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Amount</th>
        <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Balance</th>
      </tr></thead>
      <tbody className="divide-y divide-surface-border">
        {rows.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-navy/40">No aging details in this period</td></tr>}
        {rows.map((r) => (
          <tr key={r.id} className="cursor-pointer hover:bg-surface-raised/50">
            <td className="px-4 py-2.5 text-navy/70">{fmtDate(r.date)}</td>
            <td className="px-4 py-2.5 text-navy/70">{fmtDate(r.dueDate)}</td>
            <td className="px-4 py-2.5">
              <Link href={`/invoices/${r.id}`} className="font-medium text-brand-600 hover:underline">{r.invoiceNumber}</Link>
            </td>
            <td className="px-4 py-2.5"><span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-navy/60">{r.status}</span></td>
            <td className="px-4 py-2.5 text-navy">{r.customer?.businessName}</td>
            <td className="px-4 py-2.5 text-right text-navy">{r.ageDays}</td>
            <td className="px-4 py-2.5 text-right text-navy">{fmt(r.amount)}</td>
            <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(r.balance)}</td>
          </tr>
        ))}
      </tbody>
      {rows.length > 0 && <tfoot><tr className="border-t-2 border-navy bg-surface-raised">
        <td colSpan={6} className="px-4 py-2.5 font-semibold text-navy">Total</td>
        <td className="px-4 py-2.5 text-right font-bold text-navy">{fmt(rows.reduce((s, r) => s + r.amount, 0))}</td>
        <td className="px-4 py-2.5 text-right font-bold text-navy">{fmt(rows.reduce((s, r) => s + r.balance, 0))}</td>
      </tr></tfoot>}
    </table>
  );
}

function EstimateDetailsReport({ from, to }: { from?: string; to?: string }) {
  const { data, isLoading } = useEstimateDetails(from, to);
  if (isLoading) return <Spinner />;
  const rows: Array<{
    id: string; status: string; date: string; expiryDate: string;
    estimateNumber: string; customer: { businessName: string }; total: number;
  }> = data?.data ?? [];
  return (
    <table className="w-full text-sm">
      <thead><tr className="border-b border-surface-border bg-navy text-white">
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Status</th>
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Date</th>
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Expiry</th>
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Estimate #</th>
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Customer</th>
        <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Total</th>
      </tr></thead>
      <tbody className="divide-y divide-surface-border">
        {rows.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-navy/40">No estimates in this period</td></tr>}
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-surface-raised/50">
            <td className="px-4 py-2.5"><span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-navy/60">{r.status}</span></td>
            <td className="px-4 py-2.5 text-navy/70">{fmtDate(r.date)}</td>
            <td className="px-4 py-2.5 text-navy/70">{fmtDate(r.expiryDate)}</td>
            <td className="px-4 py-2.5 font-medium text-brand-600">{r.estimateNumber}</td>
            <td className="px-4 py-2.5 text-navy">{r.customer?.businessName}</td>
            <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(r.total)}</td>
          </tr>
        ))}
      </tbody>
      {rows.length > 0 && <tfoot><tr className="border-t-2 border-navy bg-surface-raised">
        <td colSpan={5} className="px-4 py-2.5 font-semibold text-navy">Total</td>
        <td className="px-4 py-2.5 text-right font-bold text-navy">{fmt(rows.reduce((s, r) => s + r.total, 0))}</td>
      </tr></tfoot>}
    </table>
  );
}

function RefundHistoryReport({ from, to }: { from?: string; to?: string }) {
  const { data, isLoading } = useRefundHistory(from, to);
  if (isLoading) return <Spinner />;
  const rows: Array<{
    id: string; date: string; reference: string; customer: { businessName: string };
    method: string; amount: number; type: string;
  }> = data?.data ?? [];
  const grandTotal = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <div>
      {grandTotal > 0 && (
        <div className="mb-4 rounded-lg bg-danger-bg px-4 py-3 text-sm font-medium text-danger">Total Refunds: {fmt(grandTotal)}</div>
      )}
      <table className="w-full text-sm">
        <thead><tr className="border-b border-surface-border bg-navy text-white">
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Date</th>
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Reference</th>
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Customer</th>
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Method</th>
          <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Amount</th>
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Type</th>
        </tr></thead>
        <tbody className="divide-y divide-surface-border">
          {rows.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-navy/40">No refunds in this period</td></tr>}
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-surface-raised/50">
              <td className="px-4 py-2.5 text-navy/70">{fmtDate(r.date)}</td>
              <td className="px-4 py-2.5 font-medium text-navy">{r.reference}</td>
              <td className="px-4 py-2.5 text-navy">{r.customer?.businessName}</td>
              <td className="px-4 py-2.5 text-navy/60">{r.method}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-danger">{fmt(r.amount)}</td>
              <td className="px-4 py-2.5"><span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-navy/60">{r.type}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReceivableSummaryReport({ from, to }: { from?: string; to?: string }) {
  const { data, isLoading } = useReceivableSummary(from, to);
  if (isLoading) return <Spinner />;
  const rows: Array<{
    id: string; customer: { businessName: string }; date: string; txnNumber: string;
    type: string; status: string; total: number; balance: number;
  }> = data?.data ?? [];
  return (
    <table className="w-full text-sm">
      <thead><tr className="border-b border-surface-border bg-navy text-white">
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Customer</th>
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Date</th>
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Txn #</th>
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Type</th>
        <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Status</th>
        <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Total</th>
        <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Balance</th>
      </tr></thead>
      <tbody className="divide-y divide-surface-border">
        {rows.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-navy/40">No receivables in this period</td></tr>}
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-surface-raised/50">
            <td className="px-4 py-2.5 font-medium text-brand-600">{r.customer?.businessName}</td>
            <td className="px-4 py-2.5 text-navy/70">{fmtDate(r.date)}</td>
            <td className="px-4 py-2.5 font-medium text-navy">{r.txnNumber}</td>
            <td className="px-4 py-2.5"><span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-navy/60">{r.type}</span></td>
            <td className="px-4 py-2.5"><span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-navy/60">{r.status}</span></td>
            <td className="px-4 py-2.5 text-right text-navy">{fmt(r.total)}</td>
            <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(r.balance)}</td>
          </tr>
        ))}
      </tbody>
      {rows.length > 0 && <tfoot><tr className="border-t-2 border-navy bg-surface-raised">
        <td colSpan={5} className="px-4 py-2.5 font-semibold text-navy">Total</td>
        <td className="px-4 py-2.5 text-right font-bold text-navy">{fmt(rows.reduce((s, r) => s + r.total, 0))}</td>
        <td className="px-4 py-2.5 text-right font-bold text-navy">{fmt(rows.reduce((s, r) => s + r.balance, 0))}</td>
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
              <td className="px-4 py-2.5 text-navy/60">{r.reference ?? "\u2014"}</td>
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

  // Build bucket distribution chart data
  const buckets = { "0-15d": 0, "16-30d": 0, "31-45d": 0, ">45d": 0 };
  for (const r of rows) {
    const d = r.daysToPayment ?? 0;
    if (d <= 15) buckets["0-15d"]++;
    else if (d <= 30) buckets["16-30d"]++;
    else if (d <= 45) buckets["31-45d"]++;
    else buckets[">45d"]++;
  }
  const bucketData = Object.entries(buckets).map(([name, count]) => ({ name, count }));

  return (
    <div>
      <div className="mb-4 rounded-lg bg-brand-50 px-4 py-3">
        <p className="text-xs text-navy/60">Average Days to Get Paid</p>
        <p className="text-3xl font-bold text-brand-600">{averageDays} days</p>
      </div>
      {rows.length > 0 && (
        <div className="mb-4 rounded-lg border border-surface-border bg-white p-4">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={bucketData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: "#64748b" }} />
              <YAxis tick={{ fontSize: 12, fill: "#64748b" }} allowDecimals={false} />
              <Tooltip {...chartTooltipStyle} />
              <Bar dataKey="count" fill={CHART_COLORS[6]} radius={[4, 4, 0, 0]} name="Invoice Count" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
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
              <td className="px-4 py-2.5 text-right text-navy">{r.daysToPayment ?? "\u2014"}</td>
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
              <td className="px-4 py-2.5 text-navy/60">{r.supplier?.name ?? "\u2014"}</td>
              <td className="px-4 py-2.5 text-navy/60 max-w-xs truncate">{r.description ?? "\u2014"}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(r.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExpensesByCategoryReport({ from, to, onSelectReport }: { from?: string; to?: string; onSelectReport?: (id: string) => void }) {
  const { data, isLoading } = useExpensesByCategoryReport(from, to);
  if (isLoading) return <Spinner />;
  const rows: Array<{ categoryId: string; categoryName: string; count: number; total: number }> = data?.data ?? [];
  const grandTotal = (data as { grandTotal?: number })?.grandTotal ?? 0;

  const chartData = rows
    .sort((a, b) => b.total - a.total)
    .map(r => ({ name: r.categoryName, total: r.total }));

  return (
    <div>
      {chartData.length > 0 && (
        <div className="mb-4 rounded-lg border border-surface-border bg-white p-4">
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={chartData}
                cx="50%"
                cy="50%"
                outerRadius={100}
                dataKey="total"
                nameKey="name"
                label={({ name, percent }: { name: string; percent: number }) => `${name} ${(percent * 100).toFixed(0)}%`}
                labelLine={false}
              >
                {chartData.map((_, idx) => (
                  <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip {...chartTooltipStyle} formatter={(value: number) => fmt(value)} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}
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
            <tr
              key={r.categoryId}
              className={cn("hover:bg-surface-raised/50", onSelectReport && "cursor-pointer")}
              onClick={() => onSelectReport?.("expense-details")}
            >
              <td className="px-4 py-2.5 font-medium text-navy">{r.categoryName}</td>
              <td className="px-4 py-2.5 text-right text-navy">{r.count}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(r.total)}</td>
              <td className="px-4 py-2.5 text-right text-navy/60">{grandTotal > 0 ? `${((r.total / grandTotal) * 100).toFixed(1)}%` : "\u2014"}</td>
            </tr>
          ))}
        </tbody>
        {rows.length > 0 && <tfoot><tr className="border-t-2 border-navy bg-surface-raised">
          <td colSpan={2} className="px-4 py-2.5 font-semibold text-navy">Total</td>
          <td className="px-4 py-2.5 text-right font-bold text-navy">{fmt(grandTotal)}</td>
          <td />
        </tr></tfoot>}
      </table>
    </div>
  );
}

function ExpensesByCustomerReport({ from, to }: { from?: string; to?: string }) {
  const { data, isLoading } = useExpensesByCustomer(from, to);
  if (isLoading) return <Spinner />;
  const rows: Array<{ customerName: string; count: number; totalAmount: number }> = data?.data ?? [];
  const grandTotal = rows.reduce((s, r) => s + r.totalAmount, 0);

  const chartData = rows
    .sort((a, b) => b.totalAmount - a.totalAmount)
    .slice(0, 10)
    .map(r => ({ name: r.customerName, totalAmount: r.totalAmount }));

  return (
    <div>
      {chartData.length > 0 && (
        <div className="mb-4 rounded-lg border border-surface-border bg-white p-4">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis type="number" tick={{ fontSize: 12, fill: "#64748b" }} tickFormatter={(v: number) => fmt(v)} />
              <YAxis dataKey="name" type="category" tick={{ fontSize: 12, fill: "#64748b" }} width={140} />
              <Tooltip {...chartTooltipStyle} formatter={(value: number) => fmt(value)} />
              <Bar dataKey="totalAmount" fill={CHART_COLORS[3]} radius={[0, 4, 4, 0]} name="Total Amount" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <table className="w-full text-sm">
        <thead><tr className="border-b border-surface-border bg-navy text-white">
          <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Customer</th>
          <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Count</th>
          <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Total Amount</th>
        </tr></thead>
        <tbody className="divide-y divide-surface-border">
          {rows.length === 0 && <tr><td colSpan={3} className="px-4 py-8 text-center text-navy/40">No expenses by customer in this period</td></tr>}
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-surface-raised/50">
              <td className="px-4 py-2.5 font-medium text-brand-600">{r.customerName}</td>
              <td className="px-4 py-2.5 text-right text-navy">{r.count}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(r.totalAmount)}</td>
            </tr>
          ))}
        </tbody>
        {rows.length > 0 && <tfoot><tr className="border-t-2 border-navy bg-surface-raised">
          <td className="px-4 py-2.5 font-semibold text-navy" colSpan={2}>Total</td>
          <td className="px-4 py-2.5 text-right font-bold text-navy">{fmt(grandTotal)}</td>
        </tr></tfoot>}
      </table>
    </div>
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

// ─── Ledger Report ────────────────────────────────────────────────────────────

const TX_STATUS_COLORS: Record<string, string> = {
  PAID: "bg-green-100 text-green-700",
  PARTIAL: "bg-yellow-100 text-yellow-700",
  UNPAID: "bg-gray-100 text-gray-600",
};

function LedgerReport() {
  const [statusFilter, setStatusFilter] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [paymentModal, setPaymentModal] = React.useState<Transaction | null>(null);
  const [payAmount, setPayAmount] = React.useState("");
  const [payMethod, setPayMethod] = React.useState<"CASH" | "CHECK" | "ACH" | "OTHER">("CASH");
  const [payRef, setPayRef] = React.useState("");
  const recordPayment = useRecordPayment();
  const { toast } = React.useContext(ToastContext);

  const { data, isLoading } = useTransactions({
    status: statusFilter || undefined,
    page,
  });

  const transactions = data?.data ?? [];
  const meta = data?.meta;

  const openPayment = (tx: Transaction) => {
    setPaymentModal(tx);
    setPayAmount(String(Math.max(0, tx.totalOwed - tx.totalPaid).toFixed(2)));
    setPayMethod("CASH");
    setPayRef("");
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!paymentModal) return;
    try {
      await recordPayment.mutateAsync({
        id: paymentModal.id,
        amount: parseFloat(payAmount),
        method: payMethod,
        reference: payRef || undefined,
      });
      toast({ title: "Payment recorded", variant: "success" });
      setPaymentModal(null);
    } catch {
      toast({ title: "Failed to record payment", variant: "error" });
    }
  };

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex items-center gap-3 border-b border-surface-border px-4 py-3">
        <Filter className="h-4 w-4 text-navy/40" />
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-surface-border px-3 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">All Statuses</option>
          <option value="UNPAID">Unpaid</option>
          <option value="PARTIAL">Partial</option>
          <option value="PAID">Paid</option>
        </select>
        {statusFilter && (
          <button onClick={() => { setStatusFilter(""); setPage(1); }} className="text-xs text-navy/40 hover:text-danger transition-colors">
            Clear
          </button>
        )}
        {!isLoading && meta && <span className="ml-auto text-sm text-navy/60">{meta.total} transactions</span>}
      </div>

      {/* Table */}
      {isLoading ? (
        <Spinner />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-border bg-navy text-white">
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Invoice #</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Customer</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Date</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Total</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Paid</th>
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Balance</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Status</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {transactions.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-navy/40">No transactions found</td></tr>
            )}
            {transactions.map((tx) => {
              const balance = Math.max(0, tx.totalOwed - tx.totalPaid);
              return (
                <tr key={tx.id} className="hover:bg-surface-raised/50">
                  <td className="px-4 py-2.5">
                    <span className="font-mono text-xs font-semibold text-navy">
                      {tx.order?.orderNumber ?? tx.id.slice(0, 8)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-medium text-brand-600">
                    {tx.customer?.businessName ?? "\u2014"}
                  </td>
                  <td className="px-4 py-2.5 text-navy/60">{fmtDate(tx.createdAt)}</td>
                  <td className="px-4 py-2.5 text-right font-medium text-navy">{fmt(tx.totalOwed)}</td>
                  <td className="px-4 py-2.5 text-right text-navy/60">{fmt(tx.totalPaid)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <span className={cn("font-medium", balance > 0 ? "text-danger" : "text-navy/40")}>{fmt(balance)}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold", TX_STATUS_COLORS[tx.status] ?? "bg-gray-100 text-gray-600")}>
                      {tx.status.charAt(0) + tx.status.slice(1).toLowerCase()}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {tx.status !== "PAID" && (
                      <button
                        onClick={() => openPayment(tx)}
                        className="rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-600 hover:bg-brand-100 transition-colors"
                      >
                        Record Payment
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between px-4 pb-3">
          <p className="text-sm text-navy/60">Page {meta.page} of {meta.totalPages}</p>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
              className="rounded-lg border border-surface-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-surface-raised">
              Previous
            </button>
            <button onClick={() => setPage(p => Math.min(meta.totalPages, p + 1))} disabled={page === meta.totalPages}
              className="rounded-lg border border-surface-border px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-surface-raised">
              Next
            </button>
          </div>
        </div>
      )}

      {/* Payment Modal */}
      {paymentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-base font-semibold text-navy mb-1">Record Payment</h3>
            <p className="text-sm text-navy/60 mb-4">
              {paymentModal.customer?.businessName} &middot; Balance: {fmt(Math.max(0, paymentModal.totalOwed - paymentModal.totalPaid))}
            </p>
            <form onSubmit={handleRecordPayment} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-navy/70">Amount</label>
                <input type="number" min="0.01" step="0.01" value={payAmount} onChange={e => setPayAmount(e.target.value)}
                  className="h-9 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-navy/70">Method</label>
                <select value={payMethod} onChange={e => setPayMethod(e.target.value as "CASH" | "CHECK" | "ACH" | "OTHER")}
                  className="h-9 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500">
                  <option value="CASH">Cash</option>
                  <option value="CHECK">Check</option>
                  <option value="ACH">ACH</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-navy/70">Reference <span className="text-navy/40">(optional)</span></label>
                <input type="text" value={payRef} onChange={e => setPayRef(e.target.value)} placeholder="Check #, transaction ID..."
                  className="h-9 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setPaymentModal(null)}
                  className="flex-1 rounded-lg border border-surface-border py-2 text-sm font-medium text-navy hover:bg-surface-raised transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={recordPayment.isPending}
                  className="flex-1 rounded-lg bg-brand-500 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50 transition-colors">
                  {recordPayment.isPending ? "Saving..." : "Record"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Toast context shim ───────────────────────────────────────────────────────

const ToastContext = React.createContext<{ toast: (opts: { title: string; variant?: ToastVariant }) => void }>({
  toast: () => {},
});

// ─── Export helpers per report ────────────────────────────────────────────────

function getExportDataForReport(
  reportId: string,
  data: {
    salesByCustomer?: { data?: Array<{ businessName: string; invoiceCount: number; salesAmount: number }> };
    salesByItem?: { data?: Array<{ name: string; qty: number; amount: number }> };
    salesByDriver?: { data?: Array<{ driverName: string; invoiceCount: number; sales: number; salesWithTax: number }> };
    invoiceDetails?: { data?: Array<{ issueDate: string; invoiceNumber: string; customer: { businessName: string }; status: string; total: number; balance: number }> };
    badDebts?: { data?: Array<{ invoiceNumber: string; customer: { businessName: string }; writtenOffAt: string; writeOffReason?: string; balance: number }> };
    customerBalance?: { data?: Array<{ businessName: string; invoiceCount: number; balance: number; overdue: number }> };
    paymentsReceived?: { data?: Array<{ createdAt: string; invoiceNumber: string; customer: { businessName: string }; method: string; reference?: string; amount: number }> };
    timeToGetPaid?: { data?: Array<{ invoiceNumber: string; customer: { businessName: string }; issueDate: string; paidAt: string; daysToPayment?: number; total: number }> };
    expenseDetails?: { data?: Array<{ date: string; category: { name: string }; supplier?: { name: string }; description?: string; amount: number }> };
    expensesByCategory?: { data?: Array<{ categoryName: string; count: number; total: number }> };
    expensesByCustomer?: { data?: Array<{ customerName: string; count: number; totalAmount: number }> };
    arAgingDetails?: { data?: Array<{ date: string; dueDate: string; invoiceNumber: string; status: string; customer: { businessName: string }; ageDays: number; amount: number; balance: number }> };
    estimateDetails?: { data?: Array<{ status: string; date: string; expiryDate: string; estimateNumber: string; customer: { businessName: string }; total: number }> };
    refundHistory?: { data?: Array<{ date: string; reference: string; customer: { businessName: string }; method: string; amount: number; type: string }> };
    receivableSummary?: { data?: Array<{ customer: { businessName: string }; date: string; txnNumber: string; type: string; status: string; total: number; balance: number }> };
    profitLoss?: { revenue: number; cogs: number; grossProfit: number; operatingExpenses: number; netProfit: number };
    cashFlow?: { totalIn: number; totalOut: number; netCashFlow: number };
  },
): { filename: string; headers: string[]; rows: (string | number | null | undefined)[][] } | null {
  switch (reportId) {
    case "sales-by-customer": {
      const rows = data.salesByCustomer?.data ?? [];
      return { filename: "sales-by-customer", headers: ["Customer", "Invoices", "Sales Amount"], rows: rows.map(r => [r.businessName, r.invoiceCount, r.salesAmount]) };
    }
    case "sales-by-item": {
      const rows = data.salesByItem?.data ?? [];
      return { filename: "sales-by-item", headers: ["Item", "Qty Sold", "Sales Amount"], rows: rows.map(r => [r.name, r.qty, r.amount]) };
    }
    case "sales-by-driver": {
      const rows = data.salesByDriver?.data ?? [];
      return { filename: "sales-by-driver", headers: ["Driver", "Invoice Count", "Sales", "Sales w/ Tax"], rows: rows.map(r => [r.driverName, r.invoiceCount, r.sales, r.salesWithTax]) };
    }
    case "invoice-details": {
      const rows = data.invoiceDetails?.data ?? [];
      return { filename: "invoice-details", headers: ["Date", "Invoice #", "Customer", "Status", "Total", "Balance"], rows: rows.map(r => [r.issueDate, r.invoiceNumber, r.customer?.businessName, r.status, r.total, r.balance]) };
    }
    case "bad-debts": {
      const rows = data.badDebts?.data ?? [];
      return { filename: "bad-debts", headers: ["Invoice #", "Customer", "Written Off", "Reason", "Amount"], rows: rows.map(r => [r.invoiceNumber, r.customer?.businessName, r.writtenOffAt, r.writeOffReason ?? "", r.balance]) };
    }
    case "customer-balance": {
      const rows = data.customerBalance?.data ?? [];
      return { filename: "customer-balance", headers: ["Customer", "Open Invoices", "Outstanding", "Overdue"], rows: rows.map(r => [r.businessName, r.invoiceCount, r.balance, r.overdue]) };
    }
    case "payments-received": {
      const rows = data.paymentsReceived?.data ?? [];
      return { filename: "payments-received", headers: ["Date", "Invoice #", "Customer", "Method", "Reference", "Amount"], rows: rows.map(r => [r.createdAt, r.invoiceNumber, r.customer?.businessName, r.method, r.reference ?? "", r.amount]) };
    }
    case "time-to-get-paid": {
      const rows = data.timeToGetPaid?.data ?? [];
      return { filename: "time-to-get-paid", headers: ["Invoice #", "Customer", "Issued", "Paid", "Days", "Amount"], rows: rows.map(r => [r.invoiceNumber, r.customer?.businessName, r.issueDate, r.paidAt, r.daysToPayment ?? "", r.total]) };
    }
    case "expense-details": {
      const rows = data.expenseDetails?.data ?? [];
      return { filename: "expense-details", headers: ["Date", "Category", "Supplier", "Description", "Amount"], rows: rows.map(r => [r.date, r.category?.name, r.supplier?.name ?? "", r.description ?? "", r.amount]) };
    }
    case "expenses-by-category": {
      const rows = data.expensesByCategory?.data ?? [];
      return { filename: "expenses-by-category", headers: ["Category", "Count", "Total"], rows: rows.map(r => [r.categoryName, r.count, r.total]) };
    }
    case "expenses-by-customer": {
      const rows = data.expensesByCustomer?.data ?? [];
      return { filename: "expenses-by-customer", headers: ["Customer", "Count", "Total Amount"], rows: rows.map(r => [r.customerName, r.count, r.totalAmount]) };
    }
    case "ar-aging-details": {
      const rows = data.arAgingDetails?.data ?? [];
      return { filename: "ar-aging-details", headers: ["Date", "Due Date", "Invoice #", "Status", "Customer", "Age (days)", "Amount", "Balance"], rows: rows.map(r => [r.date, r.dueDate, r.invoiceNumber, r.status, r.customer?.businessName, r.ageDays, r.amount, r.balance]) };
    }
    case "estimate-details": {
      const rows = data.estimateDetails?.data ?? [];
      return { filename: "estimate-details", headers: ["Status", "Date", "Expiry", "Estimate #", "Customer", "Total"], rows: rows.map(r => [r.status, r.date, r.expiryDate, r.estimateNumber, r.customer?.businessName, r.total]) };
    }
    case "refund-history": {
      const rows = data.refundHistory?.data ?? [];
      return { filename: "refund-history", headers: ["Date", "Reference", "Customer", "Method", "Amount", "Type"], rows: rows.map(r => [r.date, r.reference, r.customer?.businessName, r.method, r.amount, r.type]) };
    }
    case "receivable-summary": {
      const rows = data.receivableSummary?.data ?? [];
      return { filename: "receivable-summary", headers: ["Customer", "Date", "Txn #", "Type", "Status", "Total", "Balance"], rows: rows.map(r => [r.customer?.businessName, r.date, r.txnNumber, r.type, r.status, r.total, r.balance]) };
    }
    case "pl": {
      const d = data.profitLoss;
      if (!d) return null;
      return { filename: "profit-and-loss", headers: ["Line Item", "Amount"], rows: [["Revenue", d.revenue], ["COGS", d.cogs], ["Gross Profit", d.grossProfit], ["Operating Expenses", d.operatingExpenses], ["Net Profit", d.netProfit]] };
    }
    case "cashflow": {
      const d = data.cashFlow;
      if (!d) return null;
      return { filename: "cash-flow", headers: ["Line Item", "Amount"], rows: [["Cash In", d.totalIn], ["Cash Out", d.totalOut], ["Net Cash Flow", d.netCashFlow]] };
    }
    default:
      return null;
  }
}

// ─── Report Viewer ────────────────────────────────────────────────────────────

function ReportViewer({ reportId, from, to, onSelectReport }: { reportId: string; from?: string; to?: string; onSelectReport?: (id: string) => void }) {
  switch (reportId) {
    case "ar-aging": return <ArAgingReport onSelectReport={onSelectReport} />;
    case "ar-aging-details": return <ArAgingDetailsReport from={from} to={to} />;
    case "sales-by-customer": return <SalesByCustomerReport from={from} to={to} onSelectReport={onSelectReport} />;
    case "sales-by-item": return <SalesByItemReport from={from} to={to} />;
    case "sales-by-driver": return <SalesByDriverReport from={from} to={to} />;
    case "invoice-details": return <InvoiceDetailsReport from={from} to={to} />;
    case "bad-debts": return <BadDebtsReport />;
    case "customer-balance": return <CustomerBalanceReport onSelectReport={onSelectReport} />;
    case "estimate-details": return <EstimateDetailsReport from={from} to={to} />;
    case "receivable-summary": return <ReceivableSummaryReport from={from} to={to} />;
    case "payments-received": return <PaymentsReceivedReport from={from} to={to} />;
    case "time-to-get-paid": return <TimeToGetPaidReport from={from} to={to} />;
    case "refund-history": return <RefundHistoryReport from={from} to={to} />;
    case "expense-details": return <ExpenseDetailsReport from={from} to={to} />;
    case "expenses-by-category": return <ExpensesByCategoryReport from={from} to={to} onSelectReport={onSelectReport} />;
    case "expenses-by-customer": return <ExpensesByCustomerReport from={from} to={to} />;
    case "pl": return <ProfitLossReport from={from} to={to} />;
    case "cashflow": return <CashFlowReport from={from} to={to} />;
    case "ledger": return <LedgerReport />;
    default: return <div className="p-8 text-center text-navy/40">Report not found</div>;
  }
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function FinanceReportsContent() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => { setTitle("Reports"); }, [setTitle]);
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeReport = searchParams.get("report") ?? "";

  const currentYear = new Date().getFullYear();
  const [from, setFrom] = React.useState(`${currentYear}-01-01`);
  const [to, setTo] = React.useState(new Date().toISOString().split("T")[0]);

  const activeInfo = REPORT_GROUPS.flatMap(g => g.reports).find(r => r.id === activeReport);
  const needsDates = !["ar-aging", "bad-debts", "customer-balance", "ledger"].includes(activeReport);

  const selectReport = (id: string) => {
    router.push(`/finance/reports?report=${id}`);
  };

  // ── Export helper using cached report data from React Query ──
  const handleExport = React.useCallback(() => {
    // We read directly from the React Query cache. For simplicity, we pull the
    // data objects that match each report from the hooks' queryKey conventions.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qc = (window as any).__REACT_QUERY_DEVTOOLS_GLOBAL_CACHE__;
    // Since accessing the query cache from outside is fragile, we instead use a
    // simpler approach: find all visible table elements and export them.
    const container = document.getElementById("report-content-area");
    if (!container) return;
    const table = container.querySelector("table");
    if (!table) {
      toast({ title: "No tabular data to export", variant: "error" });
      return;
    }
    // Extract headers
    const thEls = table.querySelectorAll("thead th");
    const headers: string[] = [];
    thEls.forEach(th => headers.push(th.textContent?.trim() ?? ""));
    // Extract body rows
    const bodyRows = table.querySelectorAll("tbody tr");
    const rows: string[][] = [];
    bodyRows.forEach(tr => {
      const cells: string[] = [];
      tr.querySelectorAll("td").forEach(td => cells.push(td.textContent?.trim() ?? ""));
      if (cells.length > 0 && cells.some(c => c !== "")) rows.push(cells);
    });
    if (rows.length === 0) {
      toast({ title: "No data to export", variant: "error" });
      return;
    }
    const filename = activeInfo?.id ?? "report";
    exportReportCSV(filename, headers, rows);
    toast({ title: "CSV exported", variant: "success" });
  }, [activeInfo, toast]);

  return (
    <ToastContext.Provider value={{ toast }}>
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
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-navy">{activeInfo?.label ?? activeReport}</h2>
                <p className="text-sm text-navy/60">{activeInfo?.description}</p>
              </div>
              {activeReport !== "ledger" && (
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={handleExport}
                    className="flex items-center gap-1.5 rounded border border-surface-border px-3 py-1.5 text-sm font-medium text-navy/70 hover:bg-surface-raised"
                  >
                    <Download className="h-4 w-4" /> Export CSV
                  </button>
                  <button
                    onClick={() => printReport()}
                    className="flex items-center gap-1.5 rounded border border-surface-border px-3 py-1.5 text-sm font-medium text-navy/70 hover:bg-surface-raised"
                  >
                    <Printer className="h-4 w-4" /> Print
                  </button>
                </div>
              )}
            </div>
            {/* Date toolbar */}
            {needsDates && (
              <ReportToolbar
                from={from}
                to={to}
                onFromChange={setFrom}
                onToChange={setTo}
                onExportCSV={handleExport}
                onPrint={() => printReport()}
              />
            )}
            {/* Report content */}
            <div id="report-content-area" className="rounded-xl border border-surface-border bg-white overflow-hidden">
              <ReportViewer reportId={activeReport} from={needsDates ? from : undefined} to={needsDates ? to : undefined} onSelectReport={selectReport} />
            </div>
          </div>
        )}
      </div>
    </div>
    </ToastContext.Provider>
  );
}

export default function FinanceReportsPage() {
  return (
    <React.Suspense fallback={<div className="flex h-64 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" /></div>}>
      <FinanceReportsContent />
    </React.Suspense>
  );
}
