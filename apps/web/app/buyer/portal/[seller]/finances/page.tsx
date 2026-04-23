"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import {
  TrendingUp,
  DollarSign,
  ShoppingCart,
  AlertCircle,
  Clock,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import { useBuyerAnalytics } from "@/lib/api/buyer";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

function fmtMonth(monthStr: string): string {
  const [year, month] = monthStr.split("-");
  return new Date(Number(year), Number(month) - 1).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
  });
}

function fmtDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatPaymentMethod(method: string): string {
  return method.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-surface-border bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-navy/50">{label}</p>
          <p className="mt-1.5 text-2xl font-bold text-navy">{value}</p>
          {sub && <p className="mt-0.5 text-xs text-navy/50">{sub}</p>}
        </div>
        <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${color}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

// ─── Custom Tooltip ───────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-surface-border bg-white px-3 py-2 shadow-lg text-sm">
      <p className="font-semibold text-navy mb-1">{label}</p>
      <p className="text-buyer-600">{fmt(payload[0].value)}</p>
      {payload[1] && (
        <p className="text-navy/50 text-xs mt-0.5">{payload[1].value} order{payload[1].value !== 1 ? "s" : ""}</p>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function FinancesPage() {
  const { activeSeller } = useBuyerAuth();
  const { data, isLoading, isError } = useBuyerAnalytics();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-buyer-500" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          Failed to load financial data.
        </div>
      </div>
    );
  }

  const { summary, monthlySpend, invoiceBreakdown, recentPayments } = data;
  const chartData = monthlySpend.map((m) => ({
    month: fmtMonth(m.month),
    spend: m.spend,
    orders: m.orderCount,
  }));

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-navy">Finances</h1>
        {activeSeller && (
          <p className="text-sm text-navy/60 mt-1">
            {activeSeller.customer.businessName} at {activeSeller.tenant.name}
          </p>
        )}
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          icon={DollarSign}
          label="Total Spend"
          value={fmt(summary.totalSpend)}
          sub="All time"
          color="bg-buyer-50 text-buyer-600"
        />
        <StatCard
          icon={ShoppingCart}
          label="Total Orders"
          value={String(summary.totalOrders)}
          sub={`Avg ${fmt(summary.avgOrderValue)} / order`}
          color="bg-blue-50 text-blue-600"
        />
        <StatCard
          icon={Clock}
          label="Outstanding"
          value={fmt(summary.unpaidInvoiceTotal)}
          sub={`${summary.unpaidInvoiceCount} invoice${summary.unpaidInvoiceCount !== 1 ? "s" : ""} unpaid`}
          color="bg-warning-bg text-warning"
        />
        <StatCard
          icon={CheckCircle2}
          label="Paid Invoices"
          value={String(invoiceBreakdown.paid)}
          sub={`${invoiceBreakdown.overdue} overdue`}
          color="bg-success-bg text-success"
        />
      </div>

      {/* Monthly spend chart */}
      <div className="rounded-xl border border-surface-border bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-5">
          <TrendingUp className="h-4 w-4 text-buyer-500" />
          <h2 className="text-sm font-semibold text-navy">Monthly Spend (Last 12 Months)</h2>
        </div>
        {chartData.length === 0 ? (
          <div className="py-12 text-center text-sm text-navy/40">No spend data yet</div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 11, fill: "#94a3b8" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "#94a3b8" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `$${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`}
              />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "#f1faf5" }} />
              <Bar dataKey="spend" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={40} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Invoice breakdown + Recent payments */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Invoice breakdown */}
        <div className="rounded-xl border border-surface-border bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-navy mb-4">Invoice Status</h2>
          <div className="space-y-3">
            {[
              { label: "Paid", count: invoiceBreakdown.paid, color: "bg-success", text: "text-success" },
              { label: "Unpaid", count: invoiceBreakdown.unpaid, color: "bg-warning", text: "text-warning" },
              { label: "Overdue", count: invoiceBreakdown.overdue, color: "bg-danger", text: "text-danger" },
            ].map(({ label, count, color, text }) => {
              const total = invoiceBreakdown.paid + invoiceBreakdown.unpaid + invoiceBreakdown.overdue;
              const pct = total > 0 ? Math.round((count / total) * 100) : 0;
              return (
                <div key={label}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-navy/60">{label}</span>
                    <span className={`text-xs font-semibold ${text}`}>{count} ({pct}%)</span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-surface-raised overflow-hidden">
                    <div
                      className={`h-full rounded-full ${color}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Recent payments */}
        <div className="rounded-xl border border-surface-border bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-navy mb-4">Recent Payments</h2>
          {recentPayments.length === 0 ? (
            <p className="py-8 text-center text-xs text-navy/40">No payments recorded yet</p>
          ) : (
            <div className="divide-y divide-surface-border">
              {recentPayments.slice(0, 8).map((p, i) => (
                <div key={i} className="flex items-center justify-between py-2.5">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-navy truncate">
                      Invoice #{p.invoiceNumber}
                    </p>
                    <p className="text-[11px] text-navy/40 mt-0.5">
                      {fmtDate(p.date)} · {formatPaymentMethod(p.method)}
                    </p>
                  </div>
                  <span className="ml-3 flex-shrink-0 text-sm font-semibold text-success">
                    {fmt(p.amount)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
