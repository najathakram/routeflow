"use client";

import * as React from "react";
import Link from "next/link";
import { superAdminClient } from "@/lib/admin-api";
import { AdminStatCard } from "../../_components/AdminStatCard";
import { AdminBadge } from "../../_components/AdminBadge";
import { AdminCard } from "../../_components/AdminCard";
import { Building2, Users, AlertTriangle, Clock } from "lucide-react";
import {
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface PlatformStats {
  tenants: { total: number; active: number; trial: number; suspended: number };
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
  trialsExpiringSoon: Array<{
    id: string;
    slug: string;
    name: string;
    plan: string;
    trialEndsAt: string;
    createdAt: string;
  }>;
  atRiskTenants: Array<{
    id: string;
    slug: string;
    name: string;
    status: string;
    plan: string;
    trialEndsAt: string | null;
  }>;
}

interface GrowthPoint {
  month: string;
  count: number;
}

const PIE_COLORS = ["#6366f1", "#3b82f6", "#a855f7", "#f59e0b", "#10b981"];

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function AdminDashboardPage() {
  const [stats, setStats] = React.useState<PlatformStats | null>(null);
  const [growth, setGrowth] = React.useState<GrowthPoint[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    Promise.all([
      superAdminClient.get<PlatformStats>("/platform-admin/stats"),
      superAdminClient.get<GrowthPoint[]>("/platform-admin/stats/growth?months=12"),
    ])
      .then(([statsRes, growthRes]) => {
        setStats(statsRes.data);
        setGrowth(growthRes.data);
      })
      .catch((err) => setError(err?.response?.data?.message ?? "Failed to load stats"))
      .finally(() => setLoading(false));
  }, []);

  if (loading)
    return <div className="p-6 text-center text-slate-500 py-12">Loading dashboard...</div>;

  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-lg bg-red-900/40 px-4 py-3 text-sm text-red-400 ring-1 ring-red-700">
          {error}
        </div>
      </div>
    );
  }

  if (!stats) return null;

  const planData = Object.entries(stats.planBreakdown).map(([name, value]) => ({ name, value }));

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
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

      {/* Stat Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <AdminStatCard
          label="Total Tenants"
          value={stats.tenants.total}
          icon={<Building2 className="h-5 w-5" />}
        />
        <AdminStatCard
          label="Active"
          value={stats.tenants.active}
          icon={<Building2 className="h-5 w-5" />}
        />
        <AdminStatCard
          label="Trial"
          value={stats.tenants.trial}
          icon={<Clock className="h-5 w-5" />}
        />
        <AdminStatCard
          label="Total Users"
          value={stats.totalUsers}
          icon={<Users className="h-5 w-5" />}
        />
      </div>

      {/* Charts Row */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Tenant Growth Chart */}
        <AdminCard title="Tenant Growth (12 months)" className="lg:col-span-2">
          {growth.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={growth}>
                <defs>
                  <linearGradient id="growthGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis
                  dataKey="month"
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  tickFormatter={(v: string) => v.slice(5)}
                  stroke="#475569"
                />
                <YAxis
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  stroke="#475569"
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#1e293b",
                    border: "1px solid #334155",
                    borderRadius: 8,
                  }}
                  labelStyle={{ color: "#e2e8f0" }}
                  itemStyle={{ color: "#818cf8" }}
                />
                <Area
                  type="monotone"
                  dataKey="count"
                  stroke="#6366f1"
                  fill="url(#growthGrad)"
                  strokeWidth={2}
                  name="New Tenants"
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <p className="py-8 text-center text-sm text-slate-500">No growth data yet</p>
          )}
        </AdminCard>

        {/* Plan Distribution */}
        <AdminCard title="Plan Distribution">
          {planData.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={planData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={3}
                  dataKey="value"
                  label={({ name, value }: { name?: string; value?: number }) =>
                    `${name ?? ""}: ${value ?? 0}`
                  }
                >
                  {planData.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#1e293b",
                    border: "1px solid #334155",
                    borderRadius: 8,
                  }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 12 }}
                  formatter={(value: string) => <span className="text-slate-300">{value}</span>}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p className="py-8 text-center text-sm text-slate-500">No plan data yet</p>
          )}
        </AdminCard>
      </div>

      {/* Alerts Row */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Trials Expiring Soon */}
        <AdminCard
          title="Trials Expiring Soon"
          actions={
            <span className="flex items-center gap-1 text-xs text-yellow-400">
              <Clock className="h-3 w-3" /> {stats.trialsExpiringSoon.length} within 7 days
            </span>
          }
          noPadding
        >
          {stats.trialsExpiringSoon.length === 0 ? (
            <p className="px-5 py-6 text-sm text-slate-500">No trials expiring within 7 days.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-500">
                    <th className="px-4 py-2.5 text-left">Tenant</th>
                    <th className="px-4 py-2.5 text-left">Plan</th>
                    <th className="px-4 py-2.5 text-left">Expires</th>
                    <th className="px-4 py-2.5 text-left"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/50">
                  {stats.trialsExpiringSoon.map((t) => {
                    const days = Math.ceil(
                      (new Date(t.trialEndsAt!).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
                    );
                    return (
                      <tr key={t.id} className="hover:bg-slate-700/20">
                        <td className="px-4 py-2 text-white">{t.name ?? t.slug}</td>
                        <td className="px-4 py-2">
                          <AdminBadge variant="plan">{t.plan}</AdminBadge>
                        </td>
                        <td className="px-4 py-2">
                          <span className={days <= 2 ? "text-red-400" : "text-yellow-400"}>
                            {days}d left
                          </span>
                        </td>
                        <td className="px-4 py-2">
                          <Link
                            href={`/admin/tenants/${t.id}`}
                            className="text-xs text-indigo-400 hover:text-indigo-300"
                          >
                            View
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </AdminCard>

        {/* At-Risk Tenants */}
        <AdminCard
          title="At-Risk Tenants"
          actions={
            <span className="flex items-center gap-1 text-xs text-red-400">
              <AlertTriangle className="h-3 w-3" /> {stats.atRiskTenants.length} at risk
            </span>
          }
          noPadding
        >
          {stats.atRiskTenants.length === 0 ? (
            <p className="px-5 py-6 text-sm text-slate-500">No at-risk tenants.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-500">
                    <th className="px-4 py-2.5 text-left">Tenant</th>
                    <th className="px-4 py-2.5 text-left">Status</th>
                    <th className="px-4 py-2.5 text-left">Plan</th>
                    <th className="px-4 py-2.5 text-left"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/50">
                  {stats.atRiskTenants.map((t) => (
                    <tr key={t.id} className="hover:bg-slate-700/20">
                      <td className="px-4 py-2 text-white">{t.name ?? t.slug}</td>
                      <td className="px-4 py-2">
                        <AdminBadge>{t.status}</AdminBadge>
                      </td>
                      <td className="px-4 py-2">
                        <AdminBadge variant="plan">{t.plan}</AdminBadge>
                      </td>
                      <td className="px-4 py-2">
                        <Link
                          href={`/admin/tenants/${t.id}`}
                          className="text-xs text-indigo-400 hover:text-indigo-300"
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AdminCard>
      </div>

      {/* Recent Tenants */}
      <AdminCard
        title="Recent Tenants"
        actions={
          <Link href="/admin/tenants" className="text-xs text-indigo-400 hover:text-indigo-300">
            View all
          </Link>
        }
        noPadding
      >
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
                  <td className="px-5 py-3">
                    <Link
                      href={`/admin/tenants/${t.id}`}
                      className="font-mono text-indigo-400 hover:text-indigo-300"
                    >
                      {t.slug}
                    </Link>
                  </td>
                  <td className="px-5 py-3 text-white">{t.name}</td>
                  <td className="px-5 py-3">
                    <AdminBadge>{t.status}</AdminBadge>
                  </td>
                  <td className="px-5 py-3">
                    <AdminBadge variant="plan">{t.plan}</AdminBadge>
                  </td>
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
      </AdminCard>
    </div>
  );
}
