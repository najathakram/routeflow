"use client";

import * as React from "react";
import Link from "next/link";
import { superAdminClient } from "@/lib/admin-api";
import { AdminStatCard } from "../../_components/AdminStatCard";
import { AdminBadge, planLabel } from "../../_components/AdminBadge";
import { AdminCard } from "../../_components/AdminCard";
import { CreditCard, Users, AlertTriangle, TrendingUp, Download } from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface SubscriptionRow {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  tenantStatus: string;
  currentPlan: string;
  cycle: "Annual" | "Monthly" | null;
  baseMonthly: number;
  addonMonthly: number;
  mrr: number;
  periodEnd: string | null;
  nextChargeAt: string | null;
  cancelAtPeriodEnd: boolean;
  pastDue: boolean;
  stripeCustomerId: string | null;
}

interface BillingOverview {
  estMrr: number;
  baseMrr: number;
  addonRevenue: number;
  addonSubs: number;
  payingTenants: number;
  trialTenants: number;
  pastDue: { count: number; amount: number };
  subscriptions: SubscriptionRow[];
  meta: { total: number; page: number; limit: number; pages: number };
}

const PLANS = ["STARTER", "PROFESSIONAL", "ENTERPRISE"];

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function BillingPage() {
  const [data, setData] = React.useState<BillingOverview | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(1);
  const [planFilter, setPlanFilter] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");
  const reqSeqRef = React.useRef(0);

  React.useEffect(() => {
    setPage(1);
  }, [planFilter, statusFilter]);

  const fetchOverview = React.useCallback(
    (p: number) => {
      const seq = ++reqSeqRef.current;
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({ page: String(p), limit: "20" });
      if (planFilter) params.set("plan", planFilter);
      if (statusFilter) params.set("status", statusFilter);
      superAdminClient
        .get<BillingOverview>(`/platform-admin/billing/overview?${params}`)
        .then((res) => {
          if (seq === reqSeqRef.current) setData(res.data);
        })
        .catch((err) => {
          if (seq === reqSeqRef.current)
            setError(err?.response?.data?.message ?? "Failed to load billing data");
        })
        .finally(() => {
          if (seq === reqSeqRef.current) setLoading(false);
        });
    },
    [planFilter, statusFilter],
  );

  React.useEffect(() => {
    fetchOverview(page);
  }, [page, fetchOverview]);

  const exportCsv = () => {
    if (!data) return;
    const header = [
      "Tenant",
      "Slug",
      "Plan",
      "Cycle",
      "Base",
      "Addons",
      "MRR",
      "NextCharge",
      "Status",
    ];
    const lines = data.subscriptions.map((s) => [
      s.tenantName,
      s.tenantSlug,
      s.currentPlan,
      s.cycle ?? "",
      s.baseMonthly,
      s.addonMonthly,
      s.mrr,
      s.nextChargeAt ? new Date(s.nextChargeAt).toISOString().slice(0, 10) : "",
      s.tenantStatus,
    ]);
    const csv = [header, ...lines]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `billing-subscriptions-page-${data.meta.page}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading && !data)
    return <div className="p-6 py-12 text-center text-slate-500">Loading billing data...</div>;
  if (error)
    return (
      <div className="p-6">
        <div className="rounded-lg bg-red-900/40 px-4 py-3 text-sm text-red-400 ring-1 ring-red-700">
          {error}
        </div>
      </div>
    );
  if (!data) return null;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Billing</h1>
          <p className="mt-1 text-sm text-slate-400">Subscription revenue across all tenants.</p>
        </div>
        <button
          onClick={exportCsv}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800"
        >
          <Download className="h-4 w-4" /> Export
        </button>
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <AdminStatCard
          label="Est. MRR"
          value={usd(data.estMrr)}
          sub="base + add-ons (est.)"
          icon={<TrendingUp className="h-5 w-5" />}
        />
        <AdminStatCard
          label="Paying Tenants"
          value={data.payingTenants}
          sub={`+ ${data.trialTenants} in trial`}
          icon={<CreditCard className="h-5 w-5" />}
        />
        <AdminStatCard
          label="Addon Revenue"
          value={usd(data.addonRevenue)}
          sub={`${data.addonSubs} subscriptions`}
          icon={<Users className="h-5 w-5" />}
        />
        <AdminStatCard
          label="Past Due"
          value={data.pastDue.count}
          accent="danger"
          sub={`${usd(data.pastDue.amount)} at risk`}
          icon={<AlertTriangle className="h-5 w-5" />}
        />
      </div>

      {/* Subscriptions */}
      <AdminCard
        title="Subscriptions"
        actions={
          <div className="flex gap-2">
            <select
              value={planFilter}
              onChange={(e) => setPlanFilter(e.target.value)}
              className="h-8 rounded-lg border border-slate-600 bg-slate-700 px-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
            >
              <option value="">All plans</option>
              {PLANS.map((p) => (
                <option key={p} value={p}>
                  {planLabel(p)}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-8 rounded-lg border border-slate-600 bg-slate-700 px-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
            >
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="TRIAL">Trial</option>
              <option value="SUSPENDED">Suspended</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>
        }
        noPadding
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3 text-left">Tenant</th>
                <th className="px-4 py-3 text-left">Plan</th>
                <th className="px-4 py-3 text-left">Cycle</th>
                <th className="px-4 py-3 text-right">Base</th>
                <th className="px-4 py-3 text-right">Addons</th>
                <th className="px-4 py-3 text-right">MRR</th>
                <th className="px-4 py-3 text-left">Next Charge</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {data.subscriptions.map((s) => (
                <tr
                  key={s.tenantId}
                  className={`transition-colors hover:bg-slate-700/20 ${s.pastDue ? "bg-red-900/10" : ""}`}
                >
                  <td className="px-4 py-3">
                    <span className="text-white">{s.tenantName ?? s.tenantSlug}</span>
                    <span className="block font-mono text-xs text-slate-500">{s.tenantSlug}</span>
                  </td>
                  <td className="px-4 py-3">
                    <AdminBadge variant="plan">{s.currentPlan}</AdminBadge>
                  </td>
                  <td className="px-4 py-3 text-slate-400">{s.cycle ?? "—"}</td>
                  <td className="px-4 py-3 text-right text-slate-300">
                    {s.baseMonthly ? usd(s.baseMonthly) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-300">
                    {s.addonMonthly ? usd(s.addonMonthly) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-white">{usd(s.mrr)}</td>
                  <td className="px-4 py-3 text-slate-400">
                    {s.pastDue ? (
                      <span className="font-medium text-red-400">Overdue</span>
                    ) : s.tenantStatus === "TRIAL" ? (
                      <span className="text-slate-500">
                        {s.nextChargeAt
                          ? `converts ${new Date(s.nextChargeAt).toLocaleDateString()}`
                          : "trial"}
                      </span>
                    ) : s.nextChargeAt ? (
                      new Date(s.nextChargeAt).toLocaleDateString()
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <AdminBadge>{s.tenantStatus}</AdminBadge>
                    {s.cancelAtPeriodEnd && (
                      <span className="ml-1.5 text-xs text-red-400">cancel pending</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/tenants/${s.tenantId}`}
                      className="text-xs text-indigo-400 hover:text-indigo-300"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
              {data.subscriptions.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-slate-500">
                    No subscriptions match this view.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center border-t border-slate-700 px-4 py-3">
          <span className="text-xs text-slate-500">
            Showing {data.subscriptions.length} of {data.meta.total} subscriptions
          </span>
          <div className="ml-auto flex gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="rounded-lg px-3 py-1 text-sm text-slate-400 hover:bg-slate-700 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              disabled={page >= data.meta.pages}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-lg px-3 py-1 text-sm text-slate-400 hover:bg-slate-700 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </AdminCard>
    </div>
  );
}
