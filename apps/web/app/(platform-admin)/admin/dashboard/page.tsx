"use client";

import * as React from "react";
import Link from "next/link";
import { superAdminClient } from "../../layout";

interface PlatformStats {
  tenants: {
    total: number;
    active: number;
    trial: number;
    suspended: number;
  };
  totalUsers: number;
  planBreakdown: Record<string, number>;
  recentTenants: Array<{
    id: string;
    slug: string;
    name: string;
    status: string;
    plan: string;
    createdAt: string;
  }>;
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "bg-green-900/40 text-green-400 ring-green-600/30",
  TRIAL: "bg-yellow-900/40 text-yellow-400 ring-yellow-600/30",
  SUSPENDED: "bg-red-900/40 text-red-400 ring-red-600/30",
  CANCELLED: "bg-slate-700 text-slate-400 ring-slate-600/30",
};

function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="rounded-xl bg-slate-800 p-5 ring-1 ring-white/5">
      <p className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-bold text-white">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

export default function AdminDashboardPage() {
  const [stats, setStats] = React.useState<PlatformStats | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    superAdminClient
      .get<PlatformStats>("/platform-admin/stats")
      .then((res) => setStats(res.data))
      .catch((err) => setError(err?.response?.data?.message ?? "Failed to load stats"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Platform Dashboard</h1>
          <p className="mt-1 text-sm text-slate-400">Overview of all tenants and platform health</p>
        </div>
        <Link
          href="/admin/tenants/new"
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-500"
        >
          + Create Tenant
        </Link>
      </div>

      {loading && (
        <div className="text-center text-slate-500 py-12">Loading stats…</div>
      )}

      {error && (
        <div className="rounded-lg bg-red-900/40 px-4 py-3 text-sm text-red-400 ring-1 ring-red-700">
          {error}
        </div>
      )}

      {stats && (
        <>
          {/* Tenant stat cards */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Total Tenants" value={stats.tenants.total} />
            <StatCard label="Active" value={stats.tenants.active} />
            <StatCard label="Trial" value={stats.tenants.trial} />
            <StatCard label="Suspended" value={stats.tenants.suspended} />
          </div>

          {/* Plan breakdown */}
          <div className="mt-6 rounded-xl bg-slate-800 p-5 ring-1 ring-white/5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">Plan Breakdown</h2>
            <div className="flex flex-wrap gap-4">
              {Object.entries(stats.planBreakdown).map(([plan, count]) => (
                <div key={plan} className="flex items-center gap-2">
                  <span className="rounded-full bg-slate-700 px-3 py-1 text-xs font-medium text-slate-300">{plan}</span>
                  <span className="text-lg font-bold text-white">{count}</span>
                </div>
              ))}
              {Object.keys(stats.planBreakdown).length === 0 && (
                <p className="text-sm text-slate-500">No plan data yet</p>
              )}
            </div>
          </div>

          {/* Recent tenants */}
          <div className="mt-6 rounded-xl bg-slate-800 ring-1 ring-white/5">
            <div className="flex items-center justify-between border-b border-slate-700 px-5 py-4">
              <h2 className="text-sm font-semibold text-white">Recent Tenants</h2>
              <Link href="/admin/tenants" className="text-xs text-indigo-400 hover:text-indigo-300">
                View all →
              </Link>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-500">
                    <th className="px-5 py-3 text-left">Slug</th>
                    <th className="px-5 py-3 text-left">Business Name</th>
                    <th className="px-5 py-3 text-left">Status</th>
                    <th className="px-5 py-3 text-left">Plan</th>
                    <th className="px-5 py-3 text-left">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/50">
                  {stats.recentTenants.map((t) => (
                    <tr key={t.id} className="hover:bg-slate-700/30 transition-colors">
                      <td className="px-5 py-3 font-mono text-slate-300">{t.slug}</td>
                      <td className="px-5 py-3 text-white">{t.name}</td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${STATUS_COLORS[t.status] ?? "bg-slate-700 text-slate-400"}`}>
                          {t.status}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-slate-400">{t.plan}</td>
                      <td className="px-5 py-3 text-slate-500">
                        {new Date(t.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                  {stats.recentTenants.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-5 py-8 text-center text-slate-500">
                        No tenants yet
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
