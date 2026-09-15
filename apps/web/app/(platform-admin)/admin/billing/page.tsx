"use client";

import * as React from "react";
import Link from "next/link";
import { superAdminClient } from "@/lib/admin-api";
import { AdminStatCard } from "../../_components/AdminStatCard";
import { AdminBadge } from "../../_components/AdminBadge";
import { AdminCard } from "../../_components/AdminCard";
import { CreditCard, Users, AlertTriangle, TrendingUp, Download, Search } from "lucide-react";

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

type Subscription = BillingOverview["subscriptions"][number];

// Fallback per-plan monthly prices, used only if the server MRR rollup is unavailable.
// Keyed on the live TenantPlan enum values (STARTER | TEAM | BUSINESS | ENTERPRISE);
// ENTERPRISE is custom-priced so it is intentionally omitted from the degraded estimate.
const PLAN_PRICES: Record<string, number> = {
  STARTER: 59,
  TEAM: 149,
  BUSINESS: 349,
};

/** Format a dollar amount with a fixed 2 decimals (locale-grouped), e.g. 339.05 → "339.05". */
function fmtMoney(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * A subscription is "past due" when it is on an active paid plan (not pending
 * cancellation) yet its current billing period has already elapsed — a real,
 * money-neutral signal derived purely from status + periodEnd (no price data).
 */
function isPastDue(s: Subscription, now: number): boolean {
  return (
    s.tenantStatus === "ACTIVE" &&
    !s.cancelAtPeriodEnd &&
    !!s.periodEnd &&
    new Date(s.periodEnd).getTime() < now
  );
}

/** Shape returned by GET /billing/admin/mrr (MrrService.computeOverview). */
interface MrrOverview {
  mrr: number;
  momDelta: number;
  payingTenants: number;
  /** REG-743-N5/F2: ACTIVE PRODUCTION tenants priced $0 for visibility, not a bug signal. */
  unpricedActiveTenants: number;
  /** REG-743-N5/F2: has a real price snapshot, but a full discount nets it to $0. */
  zeroPricedActiveTenants: number;
  /** REG-743-N5/F3: no subscription row, or one with no planKey backfilled — nothing billable. */
  activeWithoutSubscription: number;
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function BillingPage() {
  const [data, setData] = React.useState<BillingOverview | null>(null);
  const [mrrData, setMrrData] = React.useState<MrrOverview | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Client-side view controls (no backend round-trip — filters the loaded list).
  const [search, setSearch] = React.useState("");
  const [planFilter, setPlanFilter] = React.useState("all");
  const [statusFilter, setStatusFilter] = React.useState("all");

  React.useEffect(() => {
    superAdminClient
      .get<BillingOverview>("/platform-admin/billing/overview")
      .then((res) => setData(res.data))
      .catch((err) => setError(err?.response?.data?.message ?? "Failed to load billing data"))
      .finally(() => setLoading(false));
    // Server-side MRR rollup (price-snapshot accurate). Best-effort: the page still
    // renders a client-side estimate if this endpoint is unavailable.
    superAdminClient
      .get<MrrOverview>("/billing/admin/mrr")
      .then((res) => setMrrData(res.data))
      .catch(() => setMrrData(null));
  }, []);

  if (loading)
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

  // Prefer the server-side rollup (price-snapshot accurate); fall back to a client
  // estimate from active subscriptions if the endpoint is unavailable.
  const clientMrrEstimate = data.subscriptions
    .filter((s) => s.tenantStatus === "ACTIVE" && !s.cancelAtPeriodEnd)
    .reduce((sum, s) => sum + (PLAN_PRICES[s.currentPlan] ?? 0), 0);
  const mrr = mrrData?.mrr ?? clientMrrEstimate;
  const momDelta = mrrData?.momDelta ?? 0;

  const conversionRate =
    data.totalTenants > 0
      ? Math.round(((data.totalTenants - data.trialTenants) / data.totalTenants) * 100)
      : 0;

  // ─── Derived view state (filters + past-due) ────────────────────────────────
  const now = Date.now();
  const planOptions = Array.from(new Set(data.subscriptions.map((s) => s.currentPlan))).sort();
  const statusOptions = Array.from(new Set(data.subscriptions.map((s) => s.tenantStatus))).sort();

  const q = search.trim().toLowerCase();
  const filtered = data.subscriptions.filter((s) => {
    if (planFilter !== "all" && s.currentPlan !== planFilter) return false;
    if (statusFilter !== "all" && s.tenantStatus !== statusFilter) return false;
    if (q && !`${s.tenantName ?? ""} ${s.tenantSlug}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const pastDueCount = data.subscriptions.filter((s) => isPastDue(s, now)).length;
  const filtersActive = planFilter !== "all" || statusFilter !== "all" || q !== "";

  // ─── CSV export (of the current filtered view) ──────────────────────────────
  const exportCsv = () => {
    const header = [
      "Tenant",
      "Slug",
      "Status",
      "Plan",
      "Period End",
      "Cancel Pending",
      "Past Due",
      "Stripe Customer ID",
    ];
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = filtered.map((s) =>
      [
        s.tenantName ?? s.tenantSlug,
        s.tenantSlug,
        s.tenantStatus,
        s.currentPlan,
        s.periodEnd ? new Date(s.periodEnd).toISOString().slice(0, 10) : "",
        s.cancelAtPeriodEnd ? "yes" : "no",
        isPastDue(s, now) ? "yes" : "no",
        s.stripeCustomerId ?? "",
      ]
        .map((c) => escape(String(c)))
        .join(","),
    );
    const csv = [header.map(escape).join(","), ...rows].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `subscriptions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const selectClass =
    "rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Billing Overview</h1>
          <p className="mt-1 text-sm text-slate-400">Subscription and revenue management</p>
        </div>
        <button
          onClick={exportCsv}
          disabled={filtered.length === 0}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Download className="h-4 w-4" />
          Export CSV
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <AdminStatCard
          label={mrrData ? "MRR" : "Est. MRR"}
          value={`$${fmtMoney(mrr)}`}
          sub={
            mrrData
              ? `${momDelta >= 0 ? "+" : "−"}$${fmtMoney(Math.abs(momDelta))} last 30d`
              : undefined
          }
          icon={<TrendingUp className="h-5 w-5" />}
        />
        <AdminStatCard
          label="Active Subscriptions"
          value={data.activeSubscriptions}
          icon={<CreditCard className="h-5 w-5" />}
        />
        <AdminStatCard
          label="Cancel Pending"
          value={data.cancelPending}
          icon={<AlertTriangle className="h-5 w-5" />}
        />
        <AdminStatCard
          label="Trial Conversion"
          value={`${conversionRate}%`}
          sub={`${data.trialTenants} still in trial`}
          icon={<Users className="h-5 w-5" />}
        />
      </div>

      {/* REG-743-N5/F2: visibility only — $0 is the correct MRR contribution for these
          tenants, this just makes sure that figure is never silent. */}
      {mrrData &&
        (mrrData.unpricedActiveTenants > 0 ||
          mrrData.zeroPricedActiveTenants > 0 ||
          mrrData.activeWithoutSubscription > 0) && (
          <div className="flex flex-wrap items-center gap-2">
            {mrrData.unpricedActiveTenants > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-950/60 px-2 py-0.5 text-xs font-medium text-amber-400">
                <AlertTriangle className="h-3 w-3" />
                {mrrData.unpricedActiveTenants} active tenant
                {mrrData.unpricedActiveTenants === 1 ? "" : "s"} missing a price snapshot
              </span>
            )}
            {mrrData.zeroPricedActiveTenants > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-950/60 px-2 py-0.5 text-xs font-medium text-amber-400">
                <AlertTriangle className="h-3 w-3" />
                {mrrData.zeroPricedActiveTenants} active tenant
                {mrrData.zeroPricedActiveTenants === 1 ? "" : "s"} priced $0 (full discount)
              </span>
            )}
            {mrrData.activeWithoutSubscription > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-950/60 px-2 py-0.5 text-xs font-medium text-amber-400">
                <AlertTriangle className="h-3 w-3" />
                {mrrData.activeWithoutSubscription} active tenant
                {mrrData.activeWithoutSubscription === 1 ? "" : "s"} with nothing billable on file
              </span>
            )}
          </div>
        )}

      {/* Subscription Table */}
      <AdminCard
        title="All Subscriptions"
        noPadding
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tenant…"
                className="w-40 rounded-lg border border-slate-700 bg-slate-800 py-1.5 pl-8 pr-2.5 text-xs text-slate-200 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
            <select
              value={planFilter}
              onChange={(e) => setPlanFilter(e.target.value)}
              className={selectClass}
              aria-label="Filter by plan"
            >
              <option value="all">All plans</option>
              {planOptions.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className={selectClass}
              aria-label="Filter by status"
            >
              <option value="all">All statuses</option>
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </>
        }
      >
        {(filtersActive || pastDueCount > 0) && (
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-700/60 px-4 py-2.5 text-xs text-slate-400">
            {filtersActive && (
              <span>
                Showing <span className="font-medium text-slate-200">{filtered.length}</span> of{" "}
                {data.subscriptions.length}
              </span>
            )}
            {pastDueCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-950/60 px-2 py-0.5 font-medium text-amber-400">
                <AlertTriangle className="h-3 w-3" />
                {pastDueCount} past due
              </span>
            )}
          </div>
        )}
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
              {filtered.map((s) => {
                const pastDue = isPastDue(s, now);
                return (
                  <tr
                    key={s.tenantId}
                    className={`transition-colors hover:bg-slate-700/20 ${
                      pastDue ? "bg-amber-950/10" : ""
                    }`}
                  >
                    <td className="px-4 py-3">
                      <div>
                        <span className="text-white">{s.tenantName ?? s.tenantSlug}</span>
                        <span className="block text-xs font-mono text-slate-500">
                          {s.tenantSlug}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <AdminBadge>{s.tenantStatus}</AdminBadge>
                    </td>
                    <td className="px-4 py-3">
                      <AdminBadge variant="plan">{s.currentPlan}</AdminBadge>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-slate-400">
                        {s.periodEnd ? new Date(s.periodEnd).toLocaleDateString() : "—"}
                      </span>
                      {pastDue && (
                        <span className="ml-2 rounded bg-amber-950/60 px-1.5 py-0.5 text-xs font-medium text-amber-400">
                          Past due
                        </span>
                      )}
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
                      <Link
                        href={`/admin/tenants/${s.tenantId}`}
                        className="text-xs text-indigo-400 hover:text-indigo-300"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                    {data.subscriptions.length === 0
                      ? "No subscription records found."
                      : "No subscriptions match your filters."}
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
