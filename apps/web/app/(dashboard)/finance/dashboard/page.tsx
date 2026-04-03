"use client";

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePageTitle } from "@/lib/page-title-context";
import { useFinanceDashboard } from "@/lib/api/finance";
import {
  TrendingDown, DollarSign,
  BarChart2, ArrowRight, RefreshCw, AlertCircle
} from "lucide-react";
import { cn } from "@routeflow/ui/web";
import { fmt, fmtShort } from "@/lib/formatting";

const CHART_COLORS = ["#1e3a5f", "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"];

// Simple bar chart using CSS
function BarChart({ data }: { data: Array<{ month: string; sales: number; receipts: number; expenses: number }> }) {
  const maxVal = Math.max(...data.flatMap(d => [d.sales, d.receipts, d.expenses]));
  if (maxVal === 0) return <div className="flex h-48 items-center justify-center text-sm text-navy/40">No data for this period</div>;

  return (
    <div className="flex h-48 items-end gap-1">
      {data.map((d, i) => (
        <div key={i} className="flex flex-1 flex-col items-center gap-0.5">
          <div className="flex w-full items-end gap-px" style={{ height: "160px" }}>
            <div className="flex-1 rounded-t bg-navy/80 transition-all" style={{ height: `${(d.sales / maxVal) * 100}%` }} title={`Sales: ${fmt(d.sales)}`} />
            <div className="flex-1 rounded-t bg-brand-500/70 transition-all" style={{ height: `${(d.receipts / maxVal) * 100}%` }} title={`Receipts: ${fmt(d.receipts)}`} />
            <div className="flex-1 rounded-t bg-danger/60 transition-all" style={{ height: `${(d.expenses / maxVal) * 100}%` }} title={`Expenses: ${fmt(d.expenses)}`} />
          </div>
          <span className="text-[9px] text-navy/40">{d.month}</span>
        </div>
      ))}
    </div>
  );
}

// Donut chart using SVG
function DonutChart({ data }: { data: Array<{ name: string; amount: number }> }) {
  const total = data.reduce((s, d) => s + d.amount, 0);
  if (total === 0) return <div className="flex h-32 items-center justify-center text-sm text-navy/40">No expenses</div>;

  let offset = 0;
  const slices = data.map((d, i) => {
    const pct = d.amount / total;
    const slice = { ...d, pct, color: CHART_COLORS[i % CHART_COLORS.length], offset };
    offset += pct;
    return slice;
  });

  const circumference = 2 * Math.PI * 40;

  return (
    <div className="flex flex-col items-center gap-3">
      <svg width="100" height="100" viewBox="0 0 100 100">
        {slices.map((s, i) => (
          <circle
            key={i}
            cx="50" cy="50" r="40"
            fill="none"
            stroke={s.color}
            strokeWidth="18"
            strokeDasharray={`${s.pct * circumference} ${circumference}`}
            strokeDashoffset={-s.offset * circumference}
            transform="rotate(-90 50 50)"
          />
        ))}
        <circle cx="50" cy="50" r="31" fill="white" />
      </svg>
      <div className="w-full space-y-1.5">
        {slices.slice(0, 5).map((s, i) => (
          <div key={i} className="flex items-center gap-1.5 text-xs">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: s.color }} />
            <span className="min-w-0 flex-1 truncate text-navy/70">{s.name}</span>
            <span className="shrink-0 font-medium text-navy">{fmtShort(s.amount)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function FinanceDashboardPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => { setTitle("Finance Dashboard"); }, [setTitle]);
  const router = useRouter();
  const { data, isLoading, refetch } = useFinanceDashboard();

  const summaryRows = [
    { label: "Today", key: "today" as const },
    { label: "This Week", key: "thisWeek" as const },
    { label: "This Month", key: "thisMonth" as const },
    { label: "This Quarter", key: "thisQuarter" as const },
    { label: "This Year", key: "thisYear" as const },
  ];

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" />
      </div>
    );
  }

  const ar = data?.arAging;
  const sales = data?.monthlySales;
  const table = data?.summaryTable;
  const totalAr = ar?.total ?? 0;

  // AR aging bar percentages
  const arPcts = totalAr > 0 ? {
    current:  ((ar?.current ?? 0) / totalAr) * 100,
    d1_15:    ((ar?.days1_15 ?? 0) / totalAr) * 100,
    d16_30:   ((ar?.days16_30 ?? 0) / totalAr) * 100,
    d31_45:   ((ar?.days31_45 ?? 0) / totalAr) * 100,
    d45plus:  ((ar?.days45plus ?? 0) / totalAr) * 100,
  } : { current: 0, d1_15: 0, d16_30: 0, d31_45: 0, d45plus: 0 };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-navy">Finance Overview</h1>
          <p className="text-sm text-navy/60">Your business financial summary</p>
        </div>
        <button onClick={() => refetch()} className="flex items-center gap-2 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-sm text-navy/60 hover:text-navy transition-colors">
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {/* Total Receivables */}
      <div className="rounded-xl border border-surface-border bg-white p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-navy/40">Total Receivables</p>
            <p className="mt-1 text-3xl font-bold text-navy">{fmt(totalAr)}</p>
          </div>
          <Link href="/finance/reports?report=ar-aging" className="flex items-center gap-1 text-sm text-brand-500 hover:underline">
            View Report <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        {/* AR Aging stacked bar */}
        {totalAr > 0 && (
          <>
            <div className="flex h-4 overflow-hidden rounded-full">
              {arPcts.current > 0 && <div onClick={() => router.push("/invoices?status=SENT")} style={{ width: `${arPcts.current}%` }} className="cursor-pointer bg-brand-500 hover:brightness-90 transition-all" title={`Current: ${fmt(ar?.current ?? 0)} — click to view`} />}
              {arPcts.d1_15 > 0 && <div onClick={() => router.push("/invoices?status=OVERDUE")} style={{ width: `${arPcts.d1_15}%` }} className="cursor-pointer bg-yellow-400 hover:brightness-90 transition-all" title={`1-15 days overdue: ${fmt(ar?.days1_15 ?? 0)} — click to view`} />}
              {arPcts.d16_30 > 0 && <div onClick={() => router.push("/invoices?status=OVERDUE")} style={{ width: `${arPcts.d16_30}%` }} className="cursor-pointer bg-orange-400 hover:brightness-90 transition-all" title={`16-30 days overdue: ${fmt(ar?.days16_30 ?? 0)} — click to view`} />}
              {arPcts.d31_45 > 0 && <div onClick={() => router.push("/invoices?status=OVERDUE")} style={{ width: `${arPcts.d31_45}%` }} className="cursor-pointer bg-red-400 hover:brightness-90 transition-all" title={`31-45 days overdue: ${fmt(ar?.days31_45 ?? 0)} — click to view`} />}
              {arPcts.d45plus > 0 && <div onClick={() => router.push("/invoices?status=OVERDUE")} style={{ width: `${arPcts.d45plus}%` }} className="cursor-pointer bg-red-700 hover:brightness-90 transition-all" title={`45+ days overdue: ${fmt(ar?.days45plus ?? 0)} — click to view`} />}
            </div>
            <div className="mt-3 grid grid-cols-5 gap-3">
              {[
                { label: "CURRENT", value: ar?.current ?? 0, color: "text-brand-500", href: "/invoices?status=SENT" },
                { label: "1-15 DAYS", value: ar?.days1_15 ?? 0, color: "text-yellow-500", href: "/invoices?status=OVERDUE" },
                { label: "16-30 DAYS", value: ar?.days16_30 ?? 0, color: "text-orange-500", href: "/invoices?status=OVERDUE" },
                { label: "31-45 DAYS", value: ar?.days31_45 ?? 0, color: "text-red-500", href: "/invoices?status=OVERDUE" },
                { label: "ABOVE 45", value: ar?.days45plus ?? 0, color: "text-red-700", href: "/invoices?status=OVERDUE" },
              ].map((b) => (
                <button key={b.label} onClick={() => router.push(b.href)} className="text-center hover:opacity-75 transition-opacity">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-navy/40">{b.label}</p>
                  <p className={cn("mt-0.5 text-sm font-bold", b.color)}>{fmt(b.value)}</p>
                </button>
              ))}
            </div>
          </>
        )}
        {totalAr === 0 && <p className="text-sm text-navy/40">No outstanding receivables</p>}
      </div>

      {/* Sales and Expenses + Top Expenses row */}
      <div className="grid grid-cols-3 gap-6">
        {/* Sales Bar Chart - takes 2/3 */}
        <div className="col-span-2 rounded-xl border border-surface-border bg-white p-5">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <p className="text-sm font-semibold text-navy">Sales and Expenses</p>
              <p className="text-xs text-navy/40">This Fiscal Year</p>
            </div>
            <div className="flex gap-4 text-xs">
              <div className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-navy/80" /><span className="text-navy/60">Total Sales</span><span className="font-semibold text-navy">{fmt(sales?.totalSales ?? 0)}</span></div>
              <div className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-brand-500/70" /><span className="text-navy/60">Receipts</span><span className="font-semibold text-navy">{fmt(sales?.totalReceipts ?? 0)}</span></div>
              <div className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-danger/60" /><span className="text-navy/60">Expenses</span><span className="font-semibold text-navy">{fmt(sales?.totalExpenses ?? 0)}</span></div>
            </div>
          </div>
          <BarChart data={sales?.data ?? []} />
        </div>

        {/* Top Expenses donut - takes 1/3 */}
        <div className="rounded-xl border border-surface-border bg-white p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-navy">Top Expenses</p>
              <p className="text-xs text-navy/40">This Year</p>
            </div>
            <Link href="/finance/expenses" className="text-xs text-brand-500 hover:underline">View all</Link>
          </div>
          <DonutChart data={data?.topExpenses ?? []} />
        </div>
      </div>

      {/* Sales, Receipts & Dues Table */}
      <div className="rounded-xl border border-surface-border bg-white">
        <div className="border-b border-surface-border px-5 py-4">
          <p className="text-sm font-semibold text-navy">Sales, Receipts &amp; Dues</p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-border bg-surface-raised">
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-navy/40">Period</th>
              <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wide text-navy/40">Sales</th>
              <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wide text-navy/40">Receipts</th>
              <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wide text-navy/40">Due</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {summaryRows.map((row) => {
              const d = table?.[row.key];
              return (
                <tr key={row.key} className="hover:bg-surface-raised/50 transition-colors">
                  <td className="px-5 py-3 font-medium text-navy">{row.label}</td>
                  <td className="px-5 py-3 text-right text-navy">{fmt(d?.sales ?? 0)}</td>
                  <td className="px-5 py-3 text-right text-success">{fmt(d?.receipts ?? 0)}</td>
                  <td className={cn("px-5 py-3 text-right font-medium", (d?.due ?? 0) > 0 ? "text-danger" : "text-navy/40")}>{fmt(d?.due ?? 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Action Stats */}
      <div className="grid grid-cols-4 gap-4">
        <Link href="/finance/reports?report=ar-aging" className="group rounded-xl border border-surface-border bg-white p-4 hover:shadow-sm transition-all hover:border-orange-200">
          <div className="flex items-center justify-between">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg text-orange-500 bg-orange-50">
              <AlertCircle className="h-4 w-4" />
            </span>
            <ArrowRight className="h-4 w-4 text-navy/20 transition-transform group-hover:translate-x-0.5" />
          </div>
          <p className="mt-3 text-lg font-bold text-navy">{fmt((ar?.days31_45 ?? 0) + (ar?.days45plus ?? 0))}</p>
          <p className="text-xs text-navy/50">Overdue ({">"}30 days)</p>
        </Link>

        <Link href="/finance/payments" className="group rounded-xl border border-surface-border bg-white p-4 hover:shadow-sm transition-all hover:border-green-200">
          <div className="flex items-center justify-between">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg text-success bg-success-bg">
              <DollarSign className="h-4 w-4" />
            </span>
            <ArrowRight className="h-4 w-4 text-navy/20 transition-transform group-hover:translate-x-0.5" />
          </div>
          <p className="mt-3 text-lg font-bold text-navy">{fmt(table?.thisWeek?.receipts ?? 0)}</p>
          <p className="text-xs text-navy/50">Received this week</p>
        </Link>

        <Link href="/purchases?tab=expenses" className="group rounded-xl border border-surface-border bg-white p-4 hover:shadow-sm transition-all hover:border-red-200">
          <div className="flex items-center justify-between">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg text-danger bg-danger-bg">
              <TrendingDown className="h-4 w-4" />
            </span>
            <ArrowRight className="h-4 w-4 text-navy/20 transition-transform group-hover:translate-x-0.5" />
          </div>
          <p className="mt-3 text-lg font-bold text-navy">{fmt(sales?.totalExpenses ?? 0)}</p>
          <p className="text-xs text-navy/50">Total expenses YTD</p>
        </Link>

        <Link href="/invoices?status=OVERDUE" className="group rounded-xl border border-surface-border bg-white p-4 hover:shadow-sm transition-all hover:border-brand-200">
          <div className="flex items-center justify-between">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg text-brand-500 bg-brand-50">
              <BarChart2 className="h-4 w-4" />
            </span>
            <ArrowRight className="h-4 w-4 text-navy/20 transition-transform group-hover:translate-x-0.5" />
          </div>
          <p className="mt-3 text-lg font-bold text-navy">{fmt((table?.thisMonth?.sales ?? 0) - (table?.thisMonth?.receipts ?? 0))}</p>
          <p className="text-xs text-navy/50">Net outstanding this month</p>
        </Link>
      </div>
    </div>
  );
}
