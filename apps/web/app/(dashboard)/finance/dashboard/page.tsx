"use client";

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePageTitle } from "@/lib/page-title-context";
import { useFinanceDashboard } from "@/lib/api/finance";
import {
  TrendingDown,
  DollarSign,
  BarChart2,
  ArrowRight,
  RefreshCw,
  AlertCircle,
} from "lucide-react";
import { cn } from "@routeflow/ui/web";
import { fmt, fmtShort } from "@/lib/formatting";

const CHART_COLORS = ["#1e3a5f", "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"];

// Simple bar chart using CSS
function BarChart({
  data,
}: {
  data: Array<{ month: string; sales: number; receipts: number; expenses: number }>;
}) {
  const maxVal = Math.max(...data.flatMap((d) => [d.sales, d.receipts, d.expenses]));
  if (maxVal === 0)
    return (
      <div className="flex h-48 items-center justify-center text-sm text-navy/70">
        No data for this period
      </div>
    );

  return (
    <div className="flex h-48 items-end gap-2 px-0.5 pt-1">
      {data.map((d, i) => (
        <div key={i} className="flex flex-1 flex-col items-center gap-1.5">
          <div className="flex w-full items-end gap-px" style={{ height: "160px" }}>
            <div
              className="flex-1 rounded-t bg-navy/80 transition-all"
              style={{ height: `${(d.sales / maxVal) * 100}%` }}
              title={`Sales: ${fmt(d.sales)}`}
            />
            <div
              className="flex-1 rounded-t bg-brand-500/70 transition-all"
              style={{ height: `${(d.receipts / maxVal) * 100}%` }}
              title={`Receipts: ${fmt(d.receipts)}`}
            />
            <div
              className="flex-1 rounded-t bg-danger/60 transition-all"
              style={{ height: `${(d.expenses / maxVal) * 100}%` }}
              title={`Expenses: ${fmt(d.expenses)}`}
            />
          </div>
          <span className="font-mono text-[10.5px] text-navy/40">{d.month}</span>
        </div>
      ))}
    </div>
  );
}

// Donut chart using SVG
function DonutChart({ data }: { data: Array<{ name: string; amount: number }> }) {
  const total = data.reduce((s, d) => s + d.amount, 0);
  if (total === 0)
    return (
      <div className="flex h-32 items-center justify-center text-sm text-navy/70">No expenses</div>
    );

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
            cx="50"
            cy="50"
            r="40"
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
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: s.color }}
            />
            <span className="min-w-0 flex-1 truncate text-navy/70">{s.name}</span>
            <span className="shrink-0 font-mono tabular-nums font-medium text-navy">
              {fmtShort(s.amount)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function FinanceDashboardPage() {
  const { setTitle } = usePageTitle();
  // Keep the header title in sync with the visible <h1> ("Finance Overview").
  React.useEffect(() => {
    setTitle("Finance Overview");
  }, [setTitle]);
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

  // Derived AR headline figures (all from existing bindings — no re-derivation of money).
  const pastDueTotal =
    (ar?.days1_15 ?? 0) + (ar?.days16_30 ?? 0) + (ar?.days31_45 ?? 0) + (ar?.days45plus ?? 0);
  const collectedThisWeek = table?.thisWeek?.receipts ?? 0;

  // AR aging bar percentages
  const arPcts =
    totalAr > 0
      ? {
          current: ((ar?.current ?? 0) / totalAr) * 100,
          d1_15: ((ar?.days1_15 ?? 0) / totalAr) * 100,
          d16_30: ((ar?.days16_30 ?? 0) / totalAr) * 100,
          d31_45: ((ar?.days31_45 ?? 0) / totalAr) * 100,
          d45plus: ((ar?.days45plus ?? 0) / totalAr) * 100,
        }
      : { current: 0, d1_15: 0, d16_30: 0, d31_45: 0, d45plus: 0 };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="shrink">
          <h2 className="text-2xl font-bold text-navy">Finance Overview</h2>
          <p className="mt-1 text-sm text-navy/70">
            One finance home, AR position, aging and collections.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="inline-flex h-[34px] items-center gap-2 rounded-ctl border border-line-strong bg-paper px-3.5 text-[13px] font-medium text-navy shadow-card transition-colors hover:bg-surface-raised"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {/* KPI stat row */}
      <div className="grid grid-cols-4 gap-3.5">
        <div className="rounded-card border border-line bg-paper p-4 shadow-card">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
            Outstanding AR
          </p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold tracking-[-0.02em] text-navy">
            {fmt(totalAr)}
          </p>
          <p className="mt-1 text-xs text-navy/70">Across all open invoices</p>
        </div>
        <div className="rounded-card border border-danger/40 bg-paper p-4 shadow-card ring-2 ring-danger/10">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
            Overdue
          </p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold tracking-[-0.02em] text-danger">
            {fmt(pastDueTotal)}
          </p>
          <p className="mt-1 text-xs text-navy/70">Past due — all ages</p>
        </div>
        <div className="rounded-card border border-success/40 bg-paper p-4 shadow-card ring-2 ring-success/10">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
            Collected, This Week
          </p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold tracking-[-0.02em] text-navy">
            {fmt(collectedThisWeek)}
          </p>
          <p className="mt-1 text-xs text-navy/70">Payments received</p>
        </div>
        <div className="rounded-card border border-line bg-paper p-4 shadow-card">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
            Collected, This Month
          </p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold tracking-[-0.02em] text-navy">
            {fmt(table?.thisMonth?.receipts ?? 0)}
          </p>
          <p className="mt-1 text-xs text-navy/70">Payments received</p>
        </div>
      </div>

      {/* AR Aging card */}
      <div className="rounded-card border border-line bg-paper shadow-card">
        <div className="flex items-center justify-between border-b border-surface-border px-5 py-3.5">
          <h3 className="text-base font-semibold text-navy">AR Aging</h3>
          <Link
            href="/finance/reports?report=ar-aging"
            className="flex items-center gap-1 text-[12.5px] font-medium text-brand-500 hover:underline"
          >
            Aging report <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
        <div className="p-5">
          <div className="flex items-baseline gap-2">
            <span className="font-mono tabular-nums text-[26px] font-semibold text-navy">
              {fmt(totalAr)}
            </span>
            <span className="text-[12.5px] text-navy/70">total outstanding</span>
          </div>

          {/* AR Aging stacked bar */}
          {totalAr > 0 && (
            <>
              <div className="mt-3.5 mb-4 flex h-4 overflow-hidden rounded-full">
                {arPcts.current > 0 && (
                  <div
                    onClick={() => router.push("/invoices?status=SENT")}
                    style={{ width: `${arPcts.current}%` }}
                    className="cursor-pointer bg-brand-500 hover:brightness-90 transition-all"
                    title={`Current: ${fmt(ar?.current ?? 0)} — click to view`}
                  />
                )}
                {arPcts.d1_15 > 0 && (
                  <div
                    onClick={() => router.push("/invoices?status=OVERDUE")}
                    style={{ width: `${arPcts.d1_15}%` }}
                    className="cursor-pointer bg-info hover:brightness-90 transition-all"
                    title={`1 to 15 days overdue: ${fmt(ar?.days1_15 ?? 0)} — click to view`}
                  />
                )}
                {arPcts.d16_30 > 0 && (
                  <div
                    onClick={() => router.push("/invoices?status=OVERDUE")}
                    style={{ width: `${arPcts.d16_30}%` }}
                    className="cursor-pointer bg-warning hover:brightness-90 transition-all"
                    title={`16 to 30 days overdue: ${fmt(ar?.days16_30 ?? 0)} — click to view`}
                  />
                )}
                {arPcts.d31_45 > 0 && (
                  <div
                    onClick={() => router.push("/invoices?status=OVERDUE")}
                    style={{ width: `${arPcts.d31_45}%` }}
                    className="cursor-pointer bg-[#EA580C] hover:brightness-90 transition-all"
                    title={`31 to 45 days overdue: ${fmt(ar?.days31_45 ?? 0)} — click to view`}
                  />
                )}
                {arPcts.d45plus > 0 && (
                  <div
                    onClick={() => router.push("/invoices?status=OVERDUE")}
                    style={{ width: `${arPcts.d45plus}%` }}
                    className="cursor-pointer bg-danger hover:brightness-90 transition-all"
                    title={`45+ days overdue: ${fmt(ar?.days45plus ?? 0)} — click to view`}
                  />
                )}
              </div>
              <div className="grid grid-cols-5 gap-2">
                {[
                  {
                    label: "Current",
                    value: ar?.current ?? 0,
                    swatch: "bg-brand-500",
                    href: "/invoices?status=SENT",
                  },
                  {
                    label: "1 to 15 days",
                    value: ar?.days1_15 ?? 0,
                    swatch: "bg-info",
                    href: "/invoices?status=OVERDUE",
                  },
                  {
                    label: "16 to 30 days",
                    value: ar?.days16_30 ?? 0,
                    swatch: "bg-warning",
                    href: "/invoices?status=OVERDUE",
                  },
                  {
                    label: "31 to 45 days",
                    value: ar?.days31_45 ?? 0,
                    swatch: "bg-[#EA580C]",
                    href: "/invoices?status=OVERDUE",
                  },
                  {
                    label: "45+ days",
                    value: ar?.days45plus ?? 0,
                    swatch: "bg-danger",
                    href: "/invoices?status=OVERDUE",
                  },
                ].map((b) => (
                  <button
                    key={b.label}
                    onClick={() => router.push(b.href)}
                    className="flex flex-col gap-0.5 text-left transition-opacity hover:opacity-75"
                  >
                    <span className={cn("h-2.5 w-2.5 rounded-sm", b.swatch)} />
                    <span className="text-[11.5px] text-navy/70">{b.label}</span>
                    <span className="font-mono tabular-nums text-xs font-medium text-navy">
                      {fmt(b.value)}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          {totalAr === 0 && <p className="mt-3 text-sm text-navy/70">No outstanding receivables</p>}
        </div>
      </div>

      {/* Sales and Expenses + Top Expenses row */}
      <div className="grid grid-cols-3 gap-4">
        {/* Sales Bar Chart - takes 2/3 */}
        <div className="col-span-2 rounded-card border border-line bg-paper shadow-card">
          <div className="flex items-start justify-between border-b border-surface-border px-5 py-3.5">
            <div>
              <h3 className="text-base font-semibold text-navy">Sales and Expenses</h3>
              <p className="text-xs text-navy/70">This Fiscal Year</p>
            </div>
            <div className="flex gap-4 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-navy/80" />
                <span className="text-navy/70">Total Sales</span>
                <span className="font-mono tabular-nums font-semibold text-navy">
                  {fmt(sales?.totalSales ?? 0)}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-brand-500/70" />
                <span className="text-navy/70">Receipts</span>
                <span className="font-mono tabular-nums font-semibold text-navy">
                  {fmt(sales?.totalReceipts ?? 0)}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-danger/60" />
                <span className="text-navy/70">Expenses</span>
                <span className="font-mono tabular-nums font-semibold text-navy">
                  {fmt(sales?.totalExpenses ?? 0)}
                </span>
              </div>
            </div>
          </div>
          <div className="p-5">
            <BarChart data={sales?.data ?? []} />
          </div>
        </div>

        {/* Top Expenses donut - takes 1/3 */}
        <div className="rounded-card border border-line bg-paper shadow-card">
          <div className="flex items-center justify-between border-b border-surface-border px-5 py-3.5">
            <div>
              <h3 className="text-base font-semibold text-navy">Top Expenses</h3>
              <p className="text-xs text-navy/70">This Year</p>
            </div>
            <Link
              href="/vendor-bills"
              className="text-[12.5px] font-medium text-brand-500 hover:underline"
            >
              View all
            </Link>
          </div>
          <div className="p-5">
            <DonutChart data={data?.topExpenses ?? []} />
          </div>
        </div>
      </div>

      {/* Sales, Receipts & Dues Table */}
      <div className="rounded-card border border-line bg-paper shadow-card">
        <div className="border-b border-surface-border px-5 py-3.5">
          <h3 className="text-base font-semibold text-navy">Sales, Receipts &amp; Dues</h3>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-border bg-surface-raised">
              <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
                Period
              </th>
              <th className="px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
                Sales
              </th>
              <th className="px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
                Receipts
              </th>
              <th className="px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
                Due
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {summaryRows.map((row) => {
              const d = table?.[row.key];
              return (
                <tr key={row.key} className="hover:bg-surface-raised/50 transition-colors">
                  <td className="px-5 py-3 font-medium text-navy">{row.label}</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-navy">
                    {fmt(d?.sales ?? 0)}
                  </td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-success">
                    {fmt(d?.receipts ?? 0)}
                  </td>
                  <td
                    className={cn(
                      "px-5 py-3 text-right font-mono tabular-nums font-medium",
                      (d?.due ?? 0) > 0 ? "text-danger" : "text-navy/70",
                    )}
                  >
                    {fmt(d?.due ?? 0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Action Stats */}
      <div className="grid grid-cols-4 gap-4">
        <Link
          href="/finance/reports?report=ar-aging"
          className="group rounded-card border border-line bg-paper p-4 shadow-card transition-all hover:border-orange-200 hover:shadow-dropdown"
        >
          <div className="flex items-center justify-between">
            <span className="flex h-9 w-9 items-center justify-center rounded-ctl text-orange-500 bg-orange-50">
              <AlertCircle className="h-4 w-4" />
            </span>
            <ArrowRight className="h-4 w-4 text-navy/20 transition-transform group-hover:translate-x-0.5" />
          </div>
          <p className="mt-3 font-mono tabular-nums text-lg font-bold text-navy">
            {fmt((ar?.days31_45 ?? 0) + (ar?.days45plus ?? 0))}
          </p>
          <p className="text-xs text-navy/70">Overdue ({">"}30 days)</p>
        </Link>

        <Link
          href="/finance/payments"
          className="group rounded-card border border-line bg-paper p-4 shadow-card transition-all hover:border-green-200 hover:shadow-dropdown"
        >
          <div className="flex items-center justify-between">
            <span className="flex h-9 w-9 items-center justify-center rounded-ctl text-success bg-success-bg">
              <DollarSign className="h-4 w-4" />
            </span>
            <ArrowRight className="h-4 w-4 text-navy/20 transition-transform group-hover:translate-x-0.5" />
          </div>
          <p className="mt-3 font-mono tabular-nums text-lg font-bold text-navy">
            {fmt(table?.thisWeek?.receipts ?? 0)}
          </p>
          <p className="text-xs text-navy/70">Received this week</p>
        </Link>

        <Link
          href="/vendor-bills?tab=other"
          className="group rounded-card border border-line bg-paper p-4 shadow-card transition-all hover:border-red-200 hover:shadow-dropdown"
        >
          <div className="flex items-center justify-between">
            <span className="flex h-9 w-9 items-center justify-center rounded-ctl text-danger bg-danger-bg">
              <TrendingDown className="h-4 w-4" />
            </span>
            <ArrowRight className="h-4 w-4 text-navy/20 transition-transform group-hover:translate-x-0.5" />
          </div>
          <p className="mt-3 font-mono tabular-nums text-lg font-bold text-navy">
            {fmt(sales?.totalExpenses ?? 0)}
          </p>
          <p className="text-xs text-navy/70">Total expenses YTD</p>
        </Link>

        <Link
          href="/invoices?status=OVERDUE"
          className="group rounded-card border border-line bg-paper p-4 shadow-card transition-all hover:border-brand-200 hover:shadow-dropdown"
        >
          <div className="flex items-center justify-between">
            <span className="flex h-9 w-9 items-center justify-center rounded-ctl text-brand-500 bg-brand-50">
              <BarChart2 className="h-4 w-4" />
            </span>
            <ArrowRight className="h-4 w-4 text-navy/20 transition-transform group-hover:translate-x-0.5" />
          </div>
          <p className="mt-3 font-mono tabular-nums text-lg font-bold text-navy">
            {fmt((table?.thisMonth?.sales ?? 0) - (table?.thisMonth?.receipts ?? 0))}
          </p>
          <p className="text-xs text-navy/70">Net outstanding this month</p>
        </Link>
      </div>
    </div>
  );
}
