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
  ResponsiveContainer, Legend, PieChart, Pie, Cell, LabelList,
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
      { id: "profit-loss", label: "Profit & Loss", description: "Revenue, COGS, and expenses for a period" },
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

function ArAgingReport({ onSelectReport }: { onSelectReport?: (id: string, context?: Record<string, string>) => void }) {
  const [interval, setInterval] = React.useState<15 | 30 | 60>(30);
  const { data, isLoading, isFetching, isError, refetch } = useArAgingInvoices(interval);
  if (isError) return <ErrorState onRetry={() => refetch()} />;
  const buckets = data?.buckets ?? {};
  const totals = data?.totals ?? { total: 0 };
  const colDefs = [
    { key: "current",                                     label: "Current" },
    { key: `days1_${interval}`,                           label: `1–${interval} days` },
    { key: `days${interval + 1}_${interval * 2}`,         label: `${interval + 1}–${interval * 2} days` },
    { key: `days${interval * 2 + 1}_${interval * 3}`,     label: `${interval * 2 + 1}–${interval * 3} days` },
    { key: `days${interval * 3}plus`,                     label: `${interval * 3 + 1}+ days` },
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
      <div className="mb-3 flex items-center gap-2 px-4 pt-4">
        <span className="text-xs font-medium text-navy/60">Aging interval:</span>
        {([15, 30, 60] as const).map(d => (
          <button key={d} onClick={() => setInterval(d)}
            className={cn("rounded px-2.5 py-1 text-xs font-medium transition-colors",
              interval === d ? "bg-brand-500 text-white" : "bg-surface-raised text-navy/70 hover:bg-surface-border")}>
            {d} days
          </button>
        ))}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-surface-border bg-navy text-white">
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase">Customer</th>
            {colDefs.map(c => <th key={c.key} className="px-4 py-3 text-right text-xs font-semibold uppercase">{c.label}</th>)}
            <th className="px-4 py-3 text-right text-xs font-semibold uppercase">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-border">
          {(isLoading || isFetching) ? <SkeletonRows cols={7} /> : Object.keys(customerMap).length === 0 ? (
            <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-navy/40">No outstanding invoices</td></tr>
          ) : Object.entries(customerMap).map(([customerId, c]) => {
            const rowTotal = colDefs.reduce((s, col) => s + (c.buckets[col.key] ?? 0), 0);
            return (
              <tr
                key={customerId}
                className={cn("hover:bg-surface-raised/50", onSelectReport && "cursor-pointer")}
                onClick={() => onSelectReport?.("ar-aging-details", { customerId })}
              >
                <td className="px-4 py-2.5 font-medium text-brand-600">{c.name}</td>
                {colDefs.map(col => <td key={col.key} className="px-4 py-2.5 text-right text-navy">{c.buckets[col.key] ? fmt(c.buckets[col.key]) : "\u2014"}</td>)}
                <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(rowTotal)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-navy/20 bg-surface-raised font-semibold text-navy">
            <td className="px-4 py-2.5 font-semibold text-navy">Total</td>
            {colDefs.map(col => <td key={col.key} className="px-4 py-2.5 text-right font-semibold text-navy">{fmt((totals as Record<string, number>)[col.key] ?? 0)}</td>)}
            <td className="px-4 py-2.5 text-right font-bold text-navy">{fmt(totals.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function SalesByCustomerReport({ from, to, onSelectReport }: { from?: string; to?: string; onSelectReport?: (id: string, context?: Record<string, string>) => void }) {
  const { data, isLoading, isFetching, isError, refetch } = useSalesByCustomer(from, to);
  if (isError) return <ErrorState onRetry={() => refetch()} />;
  const rows: Array<{ customerId: string; businessName: string; invoiceCount: number; salesAmount: number }> = data?.data ?? [];
  const grandTotal = rows.reduce((s, r) => s + r.salesAmount, 0);

  const chartData = rows
    .sort((a, b) => b.salesAmount - a.salesAmount)
    .slice(0, 10)
    .map(r => ({ name: r.businessName, salesAmount: r.salesAmount }));
  const chartHeight = Math.max(280, chartData.length * 44 + 60);

  return (
    <div>
      {chartData.length > 0 && (
        <div className={cn("mb-4 rounded-lg border border-surface-border bg-white p-4", isFetching && "opacity-40 pointer-events-none transition-opacity duration-200")}>
          <ResponsiveContainer width="100%" height={chartHeight}>
            <BarChart data={chartData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis type="number" tick={{ fontSize: 12, fill: "#64748b" }} tickFormatter={(v: number) => fmt(v)} />
              <YAxis dataKey="name" type="category" width={160}
                tick={({ x, y, payload }: any) => (
                  <text x={x} y={y} dy={4} textAnchor="end" fill="#64748b" fontSize={12}>
                    {String(payload.value ?? "").length > 20 ? `${String(payload.value).slice(0, 19)}\u2026` : payload.value}
                  </text>
                )} />
              <Tooltip {...chartTooltipStyle} formatter={(value) => fmt(Number(value))} />
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
          {(isLoading || isFetching) ? <SkeletonRows cols={3} /> : rows.length === 0 ? (
            <tr><td colSpan={3} className="px-4 py-10 text-center text-sm text-navy/40">No sales in this period</td></tr>
          ) : rows.map((r) => (
            <tr
              key={r.customerId}
              className={cn("hover:bg-surface-raised/50", onSelectReport && "cursor-pointer")}
              onClick={() => onSelectReport?.("customer-balance", { customerId: r.customerId })}
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
  const { data, isLoading, isFetching, isError, refetch } = useSalesByItem(from, to);
  if (isError) return <ErrorState onRetry={() => refetch()} />;
  const rows: Array<{ name: string; qty: number; amount: number }> = data?.data ?? [];
  const grandTotal = rows.reduce((s, r) => s + r.amount, 0);

  const chartData = rows
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10)
    .map(r => ({ name: r.name, amount: r.amount }));

  return (
    <div>
      {chartData.length > 0 && (
        <div className={cn("mb-4 rounded-lg border border-surface-border bg-white p-4", isFetching && "opacity-40 pointer-events-none transition-opacity duration-200")}>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="name" angle={-35} textAnchor="end" height={80} interval="preserveStartEnd" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 12, fill: "#64748b" }} tickFormatter={(v: number) => fmt(v)} />
              <Tooltip {...chartTooltipStyle} formatter={(value) => fmt(Number(value))} />
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
          {(isLoading || isFetching) ? <SkeletonRows cols={3} /> : rows.length === 0 ? (
            <tr><td colSpan={3} className="px-4 py-10 text-center text-sm text-navy/40">No sales in this period</td></tr>
          ) : rows.map((r, i) => (
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
  const { data, isLoading, isFetching, isError, refetch } = useSalesByDriver(from, to);
  if (isError) return <ErrorState onRetry={() => refetch()} />;
  const rows: Array<{ driverName: string; invoiceCount: number; salesTotal: number; salesWithTax: number }> = data?.data ?? [];
  const grandTotal = rows.reduce((s, r) => s + r.salesTotal, 0);

  const chartData = rows
    .sort((a, b) => b.salesTotal - a.salesTotal)
    .slice(0, 10)
    .map(r => ({ name: r.driverName, salesTotal: r.salesTotal }));
  const chartHeight = Math.max(280, chartData.length * 44 + 60);

  return (
    <div>
      {chartData.length > 0 && (
        <div className={cn("mb-4 rounded-lg border border-surface-border bg-white p-4", isFetching && "opacity-40 pointer-events-none transition-opacity duration-200")}>
          <ResponsiveContainer width="100%" height={chartHeight}>
            <BarChart data={chartData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis type="number" tick={{ fontSize: 12, fill: "#64748b" }} tickFormatter={(v: number) => fmt(v)} />
              <YAxis dataKey="name" type="category" width={160}
                tick={({ x, y, payload }: any) => (
                  <text x={x} y={y} dy={4} textAnchor="end" fill="#64748b" fontSize={12}>
                    {String(payload.value ?? "").length > 20 ? `${String(payload.value).slice(0, 19)}\u2026` : payload.value}
                  </text>
                )} />
              <Tooltip {...chartTooltipStyle} formatter={(value) => fmt(Number(value))} />
              <Bar dataKey="salesTotal" fill={CHART_COLORS[4]} radius={[0, 4, 4, 0]} name="Sales" />
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
          {(isLoading || isFetching) ? <SkeletonRows cols={4} /> : rows.length === 0 ? (
            <tr><td colSpan={4} className="px-4 py-10 text-center text-sm text-navy/40">No sales by driver in this period</td></tr>
          ) : rows.map((r, i) => (
            <tr key={i} className="hover:bg-surface-raised/50">
              <td className="px-4 py-2.5 font-medium text-navy">{r.driverName}</td>
              <td className="px-4 py-2.5 text-right text-navy">{r.invoiceCount}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(r.salesTotal)}</td>
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

function InvoiceDetailsReport({ from, to, contextCustomerId, onSelectReport }: { from?: string; to?: string; contextCustomerId?: string; onSelectReport?: (id: string, context?: Record<string, string>) => void }) {
  const [statusFilter, setStatusFilter] = React.useState("");
  const { data, isLoading, isFetching, isError, refetch } = useInvoiceDetailsReport(from, to, statusFilter || undefined, contextCustomerId);
  if (isError) return <ErrorState onRetry={() => refetch()} />;
  const rows: Array<{ id: string; invoiceNumber: string; issueDate: string; customer: { businessName: string }; status: string; total: number; balance: number }> = data?.data ?? [];
  return (
    <div>
      {contextCustomerId && (
        <div className="mb-3 flex items-center justify-between rounded-lg bg-brand-50 px-4 py-2 text-sm text-brand-700">
          <span>Filtered to selected customer</span>
          <button onClick={() => onSelectReport?.("invoice-details")} className="text-xs underline">Clear filter</button>
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-1.5 px-4 pt-4">
        {["", "DRAFT", "SENT", "PAID", "OVERDUE", "PARTIAL", "VOID"].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)}
            className={cn("rounded px-2.5 py-1 text-xs font-medium transition-colors",
              statusFilter === s ? "bg-brand-500 text-white" : "bg-surface-raised text-navy/70 hover:bg-surface-border")}>
            {s === "" ? "All" : s.charAt(0) + s.slice(1).toLowerCase()}
          </button>
        ))}
      </div>
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
          {(isLoading || isFetching) ? <SkeletonRows cols={6} /> : rows.length === 0 ? (
            <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-navy/40">No invoices in this period</td></tr>
          ) : rows.map((r) => (
            <tr key={r.id} className="hover:bg-surface-raised/50">
              <td className="px-4 py-2.5 text-navy/70">{fmtDate(r.issueDate)}</td>
              <td className="px-4 py-2.5"><Link href={`/invoices/${r.id}`} className="font-medium text-brand-600 hover:underline">{r.invoiceNumber}</Link></td>
              <td className="px-4 py-2.5 text-navy">{r.customer?.businessName}</td>
              <td className="px-4 py-2.5"><StatusBadge status={r.status} /></td>
              <td className="px-4 py-2.5 text-right text-navy">{fmt(r.total)}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(r.balance)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BadDebtsReport() {
  const { data, isLoading, isFetching, isError, refetch } = useBadDebtsReport();
  if (isError) return <ErrorState onRetry={() => refetch()} />;
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
        {(isLoading || isFetching) ? <SkeletonRows cols={5} /> : rows.length === 0 ? (
          <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-navy/40">No bad debts recorded</td></tr>
        ) : rows.map((r) => (
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

function CustomerBalanceReport({ onSelectReport, contextCustomerId }: { onSelectReport?: (id: string, context?: Record<string, string>) => void; contextCustomerId?: string }) {
  const { data, isLoading, isFetching, isError, refetch } = useCustomerBalanceSummary();
  if (isError) return <ErrorState onRetry={() => refetch()} />;
  const rows = data?.data ?? [];

  const displayRows = (contextCustomerId
    ? rows.filter(r => r.customerId === contextCustomerId)
    : rows).filter(r => (r.balance ?? 0) > 0 || (r.overdue ?? 0) > 0);

  const chartData = displayRows
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 10)
    .map(r => ({ name: r.businessName, outstanding: r.balance, overdue: r.overdue }));
  const chartHeight = Math.max(280, chartData.length * 44 + 60);

  return (
    <div>
      {contextCustomerId && (
        <div className="mb-3 flex items-center justify-between rounded-lg bg-brand-50 px-4 py-2 text-sm text-brand-700">
          <span>Filtered to selected customer</span>
          <button onClick={() => onSelectReport?.("customer-balance")} className="text-xs underline">Clear filter</button>
        </div>
      )}
      {chartData.length > 0 && (
        <div className={cn("mb-4 rounded-lg border border-surface-border bg-white p-4", isFetching && "opacity-40 pointer-events-none transition-opacity duration-200")}>
          <ResponsiveContainer width="100%" height={chartHeight}>
            <BarChart data={chartData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis type="number" tick={{ fontSize: 12, fill: "#64748b" }} tickFormatter={(v: number) => fmt(v)} />
              <YAxis dataKey="name" type="category" width={160}
                tick={({ x, y, payload }: any) => (
                  <text x={x} y={y} dy={4} textAnchor="end" fill="#64748b" fontSize={12}>
                    {String(payload.value ?? "").length > 20 ? `${String(payload.value).slice(0, 19)}\u2026` : payload.value}
                  </text>
                )} />
              <Tooltip {...chartTooltipStyle} formatter={(value) => fmt(Number(value))} />
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
          {(isLoading || isFetching) ? <SkeletonRows cols={4} /> : displayRows.length === 0 ? (
            <tr><td colSpan={4} className="px-4 py-10 text-center text-sm text-navy/40">No outstanding balances</td></tr>
          ) : displayRows.map((r) => (
            <tr
              key={r.customerId}
              className={cn("hover:bg-surface-raised/50", onSelectReport && "cursor-pointer")}
              onClick={() => onSelectReport?.("invoice-details", { customerId: r.customerId })}
            >
              <td className="px-4 py-2.5 font-medium text-brand-600">{r.businessName}</td>
              <td className="px-4 py-2.5 text-right text-navy">{r.invoiceCount}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(r.balance)}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-danger">{r.overdue > 0 ? fmt(r.overdue) : "\u2014"}</td>
            </tr>
          ))}
        </tbody>
        {displayRows.length > 0 && <tfoot><tr className="border-t-2 border-navy bg-surface-raised">
          <td colSpan={2} className="px-4 py-2.5 font-semibold text-navy">Total</td>
          <td className="px-4 py-2.5 text-right font-bold text-navy">{fmt(displayRows.reduce((s, r) => s + r.balance, 0))}</td>
          <td className="px-4 py-2.5 text-right font-bold text-danger">{fmt(displayRows.reduce((s, r) => s + r.overdue, 0))}</td>
        </tr></tfoot>}
      </table>
    </div>
  );
}

function ArAgingDetailsReport({ from, to, contextCustomerId }: { from?: string; to?: string; contextCustomerId?: string }) {
  const { data, isLoading, isFetching, isError, refetch } = useArAgingDetails(from, to, contextCustomerId);
  if (isError) return <ErrorState onRetry={() => refetch()} />;
  const rows: Array<{
    id: string; date: string; dueDate: string; invoiceNumber: string; status: string;
    customerName: string; ageDays: number; amount: number; balance: number;
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
        {(isLoading || isFetching) ? <SkeletonRows cols={8} /> : rows.length === 0 ? (
          <tr><td colSpan={8} className="px-4 py-10 text-center text-sm text-navy/40">No aging details in this period</td></tr>
        ) : rows.map((r) => (
          <tr key={r.id} className="cursor-pointer hover:bg-surface-raised/50">
            <td className="px-4 py-2.5 text-navy/70">{fmtDate(r.date)}</td>
            <td className="px-4 py-2.5 text-navy/70">{fmtDate(r.dueDate)}</td>
            <td className="px-4 py-2.5">
              <Link href={`/invoices/${r.id}`} className="font-medium text-brand-600 hover:underline">{r.invoiceNumber}</Link>
            </td>
            <td className="px-4 py-2.5"><StatusBadge status={r.status} /></td>
            <td className="px-4 py-2.5 text-navy">{r.customerName}</td>
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
  const [statusFilter, setStatusFilter] = React.useState("");
  const { data, isLoading, isFetching, isError, refetch } = useEstimateDetails(from, to, statusFilter || undefined);
  if (isError) return <ErrorState onRetry={() => refetch()} />;
  const rows: Array<{
    id: string; status: string; date: string; expiresAt: string;
    estimateNumber: string; customerName: string; total: number;
  }> = data?.data ?? [];
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-1.5 px-4 pt-4">
        {["", "DRAFT", "SENT", "ACCEPTED", "DECLINED", "EXPIRED"].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)}
            className={cn("rounded px-2.5 py-1 text-xs font-medium transition-colors",
              statusFilter === s ? "bg-brand-500 text-white" : "bg-surface-raised text-navy/70 hover:bg-surface-border")}>
            {s === "" ? "All" : s.charAt(0) + s.slice(1).toLowerCase()}
          </button>
        ))}
      </div>
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
          {(isLoading || isFetching) ? <SkeletonRows cols={6} /> : rows.length === 0 ? (
            <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-navy/40">No estimates in this period</td></tr>
          ) : rows.map((r) => (
            <tr key={r.id} className="hover:bg-surface-raised/50">
              <td className="px-4 py-2.5"><StatusBadge status={r.status} /></td>
              <td className="px-4 py-2.5 text-navy/70">{fmtDate(r.date)}</td>
              <td className={cn("px-4 py-2.5 text-sm",
                r.expiresAt && new Date(r.expiresAt) < new Date() ? "text-danger font-medium" : "text-navy")}>
                {fmtDate(r.expiresAt)}
              </td>
              <td className="px-4 py-2.5 font-medium text-brand-600">{r.estimateNumber}</td>
              <td className="px-4 py-2.5 text-navy">{r.customerName}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-navy">{fmt(r.total)}</td>
            </tr>
          ))}
        </tbody>
        {rows.length > 0 && <tfoot><tr className="border-t-2 border-navy bg-surface-raised">
          <td colSpan={5} className="px-4 py-2.5 font-semibold text-navy">Total</td>
          <td className="px-4 py-2.5 text-right font-bold text-navy">{fmt(rows.reduce((s, r) => s + r.total, 0))}</td>
        </tr></tfoot>}
      </table>
    </div>
  );
}

function RefundHistoryReport({ from, to }: { from?: string; to?: string }) {
  const { data, isLoading, isFetching, isError, refetch } = useRefundHistory(from, to);
  if (isError) return <ErrorState onRetry={() => refetch()} />;
  const rows: Array<{
    date: string; reference: string; customerName: string;
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
          {(isLoading || isFetching) ? <SkeletonRows cols={6} /> : rows.length === 0 ? (
            <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-navy/40">No refunds in this period</td></tr>
          ) : rows.map((r, idx) => (
            <tr key={`${r.reference}-${r.type}-${idx}`} className="hover:bg-surface-raised/50">
              <td className="px-4 py-2.5 text-navy/70">{fmtDate(r.date)}</td>
              <td className="px-4 py-2.5 font-medium text-navy">{r.reference}</td>
              <td className="px-4 py-2.5 text-navy">{r.customerName}</td>
              <td className="px-4 py-2.5 text-navy/60">{r.method}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-danger">{fmt(r.amount)}</td>
              <td className="px-4 py-2.5"><StatusBadge status={r.type} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReceivableSummaryReport({ from, to }: { from?: string; to?: string }) {
  const { data, isLoading, isFetching, isError, refetch } = useReceivableSummary(from, to);
  if (isError) return <ErrorState onRetry={() => refetch()} />;
  const rows: Array<{
    customerName: string; date: string; transactionNumber: string;
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
        {(isLoading || isFetching) ? <SkeletonRows cols={7} /> : rows.length === 0 ? (
          <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-navy/40">No receivables in this period</td></tr>
        ) : rows.map((r, idx) => (
          <tr key={`${r.transactionNumber}-${r.type}-${idx}`} className="hover:bg-surface-raised/50">
            <td className="px-4 py-2.5 font-medium text-brand-600">{r.customerName}</td>
            <td className="px-4 py-2.5 text-navy/70">{fmtDate(r.date)}</td>
            <td className="px-4 py-2.5 font-medium text-navy">{r.transactionNumber}</td>
            <td className="px-4 py-2.5"><StatusBadge status={r.type} /></td>
            <td className="px-4 py-2.5"><StatusBadge status={r.status} /></td>
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
  const { data, isLoading, isFetching, isError, refetch } = usePaymentsReceivedReport(from, to);
  if (isError) return <ErrorState onRetry={() => refetch()} />;
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
          {(isLoading || isFetching) ? <SkeletonRows cols={6} /> : rows.length === 0 ? (
            <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-navy/40">No payments in this period</td></tr>
          ) : rows.map((r) => (
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
  const { data, isLoading, isFetching, isError, refetch } = useTimeToGetPaid(from, to);
  if (isError) return <ErrorState onRetry={() => refetch()} />;
  const rows: Array<{ id: string; invoiceNumber: string; customer: { businessName: string }; issueDate: string; paidAt: string; daysToPayment?: number; total: number }> = data?.data ?? [];
  const averageDays = (data as { averageDays?: number })?.averageDays ?? 0;

  // Build bucket distribution chart data with percentages
  const dist: Record<string, number> = { "0-15d": 0, "16-30d": 0, "31-45d": 0, ">45d": 0 };
  for (const r of rows) {
    const d = r.daysToPayment ?? 0;
    if (d <= 15) dist["0-15d"]++;
    else if (d <= 30) dist["16-30d"]++;
    else if (d <= 45) dist["31-45d"]++;
    else dist[">45d"]++;
  }
  const total = (dist["0-15d"] ?? 0) + (dist["16-30d"] ?? 0) + (dist["31-45d"] ?? 0) + (dist[">45d"] ?? 0);
  const distData = [
    { bucket: "0\u201315d",  count: dist["0-15d"]  ?? 0, pct: total ? (((dist["0-15d"]  ?? 0) / total) * 100).toFixed(1) : "0" },
    { bucket: "16\u201330d", count: dist["16-30d"] ?? 0, pct: total ? (((dist["16-30d"] ?? 0) / total) * 100).toFixed(1) : "0" },
    { bucket: "31\u201345d", count: dist["31-45d"] ?? 0, pct: total ? (((dist["31-45d"] ?? 0) / total) * 100).toFixed(1) : "0" },
    { bucket: ">45d",        count: dist[">45d"]   ?? 0, pct: total ? (((dist[">45d"]   ?? 0) / total) * 100).toFixed(1) : "0" },
  ];

  return (
    <div>
      <div className="mb-4 rounded-lg bg-brand-50 px-4 py-3">
        <p className="text-xs text-navy/60">Average Days to Get Paid</p>
        <p className="text-3xl font-bold text-brand-600">{averageDays} days</p>
      </div>
      {rows.length > 0 && (
        <div className={cn("mb-4 rounded-lg border border-surface-border bg-white p-4", isFetching && "opacity-40 pointer-events-none transition-opacity duration-200")}>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={distData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="bucket" tick={{ fontSize: 12, fill: "#64748b" }} />
              <YAxis tick={{ fontSize: 12, fill: "#64748b" }} allowDecimals={false} />
              <Tooltip {...chartTooltipStyle} />
              <Bar dataKey="count" fill={CHART_COLORS[6]} radius={[4, 4, 0, 0]} name="Invoice Count">
                <LabelList dataKey="pct" position="top" formatter={(v: any) => `${v}%`} />
              </Bar>
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
          {(isLoading || isFetching) ? <SkeletonRows cols={6} /> : rows.length === 0 ? (
            <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-navy/40">No paid invoices in this period</td></tr>
          ) : rows.map((r) => (
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

function ExpenseDetailsReport({ from, to, contextCategoryId }: { from?: string; to?: string; contextCategoryId?: string }) {
  const { data, isLoading, isFetching, isError, refetch } = useExpenseDetailsReport(from, to, contextCategoryId);
  if (isError) return <ErrorState onRetry={() => refetch()} />;
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
          {(isLoading || isFetching) ? <SkeletonRows cols={5} /> : rows.length === 0 ? (
            <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-navy/40">No expenses in this period</td></tr>
          ) : rows.map((r) => (
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

function ExpensesByCategoryReport({ from, to, onSelectReport }: { from?: string; to?: string; onSelectReport?: (id: string, context?: Record<string, string>) => void }) {
  const { data, isLoading, isFetching, isError, refetch } = useExpensesByCategoryReport(from, to);
  if (isError) return <ErrorState onRetry={() => refetch()} />;
  const rows: Array<{ categoryId: string; categoryName: string; count: number; total: number }> = data?.data ?? [];
  const grandTotal = (data as { grandTotal?: number })?.grandTotal ?? 0;

  const chartData = rows
    .sort((a, b) => b.total - a.total)
    .map(r => ({ name: r.categoryName, total: r.total }));

  return (
    <div>
      {chartData.length > 0 && (
        <div className={cn("mb-4 rounded-lg border border-surface-border bg-white p-4", isFetching && "opacity-40 pointer-events-none transition-opacity duration-200")}>
          <ResponsiveContainer width="100%" height={360}>
            <PieChart>
              <Pie
                data={chartData}
                cx="50%"
                cy="50%"
                outerRadius={110}
                dataKey="total"
                nameKey="name"
                label={({ percent }: any) => (percent ?? 0) > 0.06 ? `${((percent ?? 0) * 100).toFixed(0)}%` : ""}
                labelLine={false}
              >
                {chartData.map((_, idx) => (
                  <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip {...chartTooltipStyle} formatter={(value) => fmt(Number(value))} />
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
          {(isLoading || isFetching) ? <SkeletonRows cols={4} /> : rows.length === 0 ? (
            <tr><td colSpan={4} className="px-4 py-10 text-center text-sm text-navy/40">No expenses in this period</td></tr>
          ) : rows.map((r) => (
            <tr
              key={r.categoryId}
              className={cn("hover:bg-surface-raised/50", onSelectReport && "cursor-pointer")}
              onClick={() => onSelectReport?.("expense-details", { categoryId: r.categoryId })}
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
  const { data, isLoading, isFetching, isError, refetch } = useExpensesByCustomer(from, to);
  if (isError) return <ErrorState onRetry={() => refetch()} />;
  const rows: Array<{ customerName: string; count: number; totalAmount: number }> = data?.data ?? [];
  const grandTotal = rows.reduce((s, r) => s + r.totalAmount, 0);

  const chartData = rows
    .sort((a, b) => b.totalAmount - a.totalAmount)
    .slice(0, 10)
    .map(r => ({ name: r.customerName, totalAmount: r.totalAmount }));
  const chartHeight = Math.max(280, chartData.length * 44 + 60);

  return (
    <div>
      {chartData.length > 0 && (
        <div className={cn("mb-4 rounded-lg border border-surface-border bg-white p-4", isFetching && "opacity-40 pointer-events-none transition-opacity duration-200")}>
          <ResponsiveContainer width="100%" height={chartHeight}>
            <BarChart data={chartData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis type="number" tick={{ fontSize: 12, fill: "#64748b" }} tickFormatter={(v: number) => fmt(v)} />
              <YAxis dataKey="name" type="category" width={160}
                tick={({ x, y, payload }: any) => (
                  <text x={x} y={y} dy={4} textAnchor="end" fill="#64748b" fontSize={12}>
                    {String(payload.value ?? "").length > 20 ? `${String(payload.value).slice(0, 19)}\u2026` : payload.value}
                  </text>
                )} />
              <Tooltip {...chartTooltipStyle} formatter={(value) => fmt(Number(value))} />
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
          {(isLoading || isFetching) ? <SkeletonRows cols={3} /> : rows.length === 0 ? (
            <tr><td colSpan={3} className="px-4 py-10 text-center text-sm text-navy/40">No expenses by customer in this period</td></tr>
          ) : rows.map((r, i) => (
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
  const { data, isLoading, isFetching, isError, refetch } = useProfitAndLoss(from, to);
  void isFetching;
  if (isLoading) return <Spinner />;
  if (isError) return <ErrorState onRetry={() => refetch()} />;
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

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <p className="text-sm font-medium text-navy">Failed to load report</p>
      <p className="text-xs text-navy/60">Check your connection and try again.</p>
      <button onClick={onRetry}
        className="mt-1 rounded-lg border border-surface-border px-4 py-2 text-sm font-medium text-navy hover:bg-surface-raised">
        Retry
      </button>
    </div>
  );
}

function SkeletonRows({ cols, rows = 5 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i} className="border-b border-surface-border">
          {Array.from({ length: cols }).map((_, j) => (
            <td key={j} className="px-4 py-2.5">
              <div className="h-4 animate-pulse rounded bg-surface-raised"
                style={{ width: j === 0 ? "60%" : j === cols - 1 ? "30%" : "45%" }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

const STATUS_BADGE_CLASSES: Record<string, string> = {
  DRAFT:       "bg-gray-100   text-gray-600",
  SENT:        "bg-blue-100   text-blue-700",
  PAID:        "bg-green-100  text-green-700",
  OVERDUE:     "bg-red-100    text-red-700",
  PARTIAL:     "bg-amber-100  text-amber-700",
  VOID:        "bg-gray-100   text-gray-400",
  ACCEPTED:    "bg-green-100  text-green-700",
  DECLINED:    "bg-red-100    text-red-700",
  EXPIRED:     "bg-orange-100 text-orange-700",
  INVOICE:     "bg-blue-50    text-blue-600",
  PAYMENT:     "bg-green-50   text-green-600",
  CREDIT_NOTE: "bg-purple-50  text-purple-600",
};
function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_BADGE_CLASSES[status] ?? "bg-gray-100 text-gray-600";
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", cls)}>
      {status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ")}
    </span>
  );
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
    const amount = parseFloat(payAmount);
    if (isNaN(amount) || amount <= 0) {
      toast({ title: "Please enter a valid amount greater than 0", variant: "error" });
      return;
    }
    try {
      await recordPayment.mutateAsync({
        id: paymentModal.id,
        amount,
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
          <button onClick={() => { setStatusFilter(""); setPage(1); }} className="text-xs text-navy/40 hover:text-navy transition-colors">
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

// ─── Report Viewer ────────────────────────────────────────────────────────────

function ReportViewer({
  reportId, from, to, onSelectReport, contextCustomerId, contextCategoryId,
}: {
  reportId: string; from?: string; to?: string;
  onSelectReport?: (id: string, context?: Record<string, string>) => void;
  contextCustomerId?: string; contextCategoryId?: string;
}) {
  switch (reportId) {
    case "ar-aging": return <ArAgingReport onSelectReport={onSelectReport} />;
    case "ar-aging-details": return <ArAgingDetailsReport from={from} to={to} contextCustomerId={contextCustomerId} />;
    case "sales-by-customer": return <SalesByCustomerReport from={from} to={to} onSelectReport={onSelectReport} />;
    case "sales-by-item": return <SalesByItemReport from={from} to={to} />;
    case "sales-by-driver": return <SalesByDriverReport from={from} to={to} />;
    case "invoice-details": return <InvoiceDetailsReport from={from} to={to} contextCustomerId={contextCustomerId} onSelectReport={onSelectReport} />;
    case "bad-debts": return <BadDebtsReport />;
    case "customer-balance": return <CustomerBalanceReport onSelectReport={onSelectReport} contextCustomerId={contextCustomerId} />;
    case "estimate-details": return <EstimateDetailsReport from={from} to={to} />;
    case "receivable-summary": return <ReceivableSummaryReport from={from} to={to} />;
    case "payments-received": return <PaymentsReceivedReport from={from} to={to} />;
    case "time-to-get-paid": return <TimeToGetPaidReport from={from} to={to} />;
    case "refund-history": return <RefundHistoryReport from={from} to={to} />;
    case "expense-details": return <ExpenseDetailsReport from={from} to={to} contextCategoryId={contextCategoryId} />;
    case "expenses-by-category": return <ExpensesByCategoryReport from={from} to={to} onSelectReport={onSelectReport} />;
    case "expenses-by-customer": return <ExpensesByCustomerReport from={from} to={to} />;
    case "profit-loss": return <ProfitLossReport from={from} to={to} />;
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
  const activeReport = searchParams.get("report") ?? "sales-by-customer";
  const contextCustomerId = searchParams.get("customerId") ?? undefined;
  const contextCategoryId = searchParams.get("categoryId") ?? undefined;

  const [from, setFrom] = React.useState(searchParams.get("from") ?? `${new Date().getFullYear()}-01-01`);
  const [to, setTo]   = React.useState(searchParams.get("to")   ?? new Date().toISOString().split("T")[0]);

  const activeInfo = REPORT_GROUPS.flatMap(g => g.reports).find(r => r.id === activeReport);
  const needsDates = !["ar-aging", "bad-debts", "customer-balance", "ledger"].includes(activeReport);

  const selectReport = (id: string, context?: Record<string, string>) => {
    const params = new URLSearchParams({ report: id, from, to });
    if (context) Object.entries(context).forEach(([k, v]) => params.set(k, v));
    router.push(`/finance/reports?${params.toString()}`);
  };

  const handleFromChange = (val: string) => {
    setFrom(val);
    const p = new URLSearchParams(searchParams.toString());
    p.set("from", val);
    router.replace(`/finance/reports?${p.toString()}`);
  };
  const handleToChange = (val: string) => {
    setTo(val);
    const p = new URLSearchParams(searchParams.toString());
    p.set("to", val);
    router.replace(`/finance/reports?${p.toString()}`);
  };

  // ── Export helper using cached report data from React Query ──
  const handleExport = React.useCallback(() => {
    if (activeReport === "cashflow") {
      toast({ title: "Cash Flow report has no table to export", variant: "error" });
      return;
    }
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
        {false ? null : (
          <div className="p-6 space-y-5">
            {/* Report header */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-navy">{activeInfo?.label ?? activeReport}</h2>
                <p className="text-sm text-navy/60">{activeInfo?.description}</p>
              </div>
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
            </div>
            {/* Date toolbar */}
            {needsDates && (
              <ReportToolbar
                from={from}
                to={to}
                onFromChange={handleFromChange}
                onToChange={handleToChange}
              />
            )}
            {/* Report content */}
            <div id="report-content-area" className="rounded-xl border border-surface-border bg-white overflow-hidden">
              <ReportViewer reportId={activeReport} from={needsDates ? from : undefined} to={needsDates ? to : undefined} onSelectReport={selectReport} contextCustomerId={contextCustomerId} contextCategoryId={contextCategoryId} />
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
