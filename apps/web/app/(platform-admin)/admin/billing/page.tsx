"use client";

import * as React from "react";
import Link from "next/link";
import { superAdminClient } from "@/lib/admin-api";
import { AdminStatCard } from "../../_components/AdminStatCard";
import { AdminBadge } from "../../_components/AdminBadge";
import { AdminCard } from "../../_components/AdminCard";
import {
  CreditCard,
  Users,
  AlertTriangle,
  TrendingUp,
} from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface BillingOverview {
  activeSubscriptions: number;
  cancelPending: number;
  totalTenants: number;
  trialTenants: number;
  subscriptions: Array<{
    tenantId: string;
    tenantSlug: string;
    tenantName: string;
    tenantStatus: string;
    currentPlan: string;
    periodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    stripeCustomerId: string | null;
  }>;
}

const PLAN_PRICES: Record<string, number> = {
  STARTER: 29,
  PROFESSIONAL: 79,
  ENTERPRISE: 199,
};

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function BillingPage() {
  const [data, setData] = React.useState<BillingOverview | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    superAdminClient
      .get<BillingOverview>("/platform-admin/billing/overview")
      .then((res) => setData(res.data))
      .catch((err) => setError(err?.response?.data?.message ?? "Failed to load billing data"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-6 py-12 text-center text-slate-500">Loading billing data...</div>;
  if (error) return <div className="p-6"><div className="rounded-lg bg-red-900/40 px-4 py-3 text-sm text-red-400 ring-1 ring-red-700">{error}</div></div>;
  if (!data) return null;

  // Estimate MRR from active subscriptions
  const mrr = data.subscriptions
    .filter((s) => s.tenantStatus === "ACTIVE" && !s.cancelAtPeriodEnd)
    .reduce((sum, s) => sum + (PLAN_PRICES[s.currentPlan] ?? 0), 0);

  const conversionRate = data.totalTenants > 0
    ? Math.round(((data.totalTenants - data.trialTenants) / data.totalTenants) * 100)
    : 0;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Billing Overview</h1>
        <p className="mt-1 text-sm text-slate-400">Subscription and revenue management</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <AdminStatCard label="Est. MRR" value={`$${mrr.toLocaleString()}`} icon={<TrendingUp className="h-5 w-5" />} />
        <AdminStatCard label="Active Subscriptions" value={data.activeSubscriptions} icon={<CreditCard className="h-5 w-5" />} />
        <AdminStatCard label="Cancel Pending" value={data.cancelPending} icon={<AlertTriangle className="h-5 w-5" />} />
        <AdminStatCard label="Trial Conversion" value={`${conversionRate}%`} sub={`${data.trialTenants} still in trial`} icon={<Users className="h-5 w-5" />} />
      </div>

      {/* Subscription Table */}
      <AdminCard title="All Subscriptions" noPadding>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3 text-left">Tenant</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Plan</th>
                <th className="px-4 py-3 text-left">Period End</th>
                <th className="px-4 py-3 text-left">Cancel Pending</th>
                <th className="px-4 py-3 text-left">Stripe ID</th>
                <th className="px-4 py-3 text-left"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {data.subscriptions.map((s) => (
                <tr key={s.tenantId} className="hover:bg-slate-700/20 transition-colors">
                  <td className="px-4 py-3">
                    <div>
                      <span className="text-white">{s.tenantName ?? s.tenantSlug}</span>
                      <span className="block text-xs font-mono text-slate-500">{s.tenantSlug}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3"><AdminBadge>{s.tenantStatus}</AdminBadge></td>
                  <td className="px-4 py-3"><AdminBadge variant="plan">{s.currentPlan}</AdminBadge></td>
                  <td className="px-4 py-3 text-slate-400">
                    {s.periodEnd ? new Date(s.periodEnd).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-4 py-3">
                    {s.cancelAtPeriodEnd ? (
                      <span className="text-red-400 text-xs font-medium">Yes</span>
                    ) : (
                      <span className="text-slate-600 text-xs">No</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">
                    {s.stripeCustomerId?.slice(0, 18) ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/admin/tenants/${s.tenantId}`} className="text-xs text-indigo-400 hover:text-indigo-300">
                      View
                    </Link>
                  </td>
                </tr>
              ))}
              {data.subscriptions.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-500">No subscription records found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </AdminCard>
    </div>
  );
}
