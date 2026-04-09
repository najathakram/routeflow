"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { superAdminClient } from "../../layout";

interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: string;
  plan: string;
  businessName: string | null;
  counts: { users: number; customers: number; orders: number } | null;
  createdAt: string;
}

interface TenantsResponse {
  data: Tenant[];
  meta: { total: number; page: number; limit: number; pages: number };
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "bg-green-900/40 text-green-400 ring-green-600/30",
  TRIAL: "bg-yellow-900/40 text-yellow-400 ring-yellow-600/30",
  SUSPENDED: "bg-red-900/40 text-red-400 ring-red-600/30",
  CANCELLED: "bg-slate-700 text-slate-400 ring-slate-600/30",
};

export default function AdminTenantsPage() {
  const router = useRouter();
  const [data, setData] = React.useState<TenantsResponse | null>(null);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [actionLoading, setActionLoading] = React.useState<string | null>(null);

  // Filter state
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");

  const fetchTenants = React.useCallback((p: number) => {
    setLoading(true);
    setError(null);
    superAdminClient
      .get<TenantsResponse>(`/platform-admin/tenants?page=${p}&limit=200`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err?.response?.data?.message ?? "Failed to load tenants"))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    fetchTenants(page);
  }, [page, fetchTenants]);

  const toggleStatus = async (tenant: Tenant) => {
    const newStatus = tenant.status === "SUSPENDED" ? "ACTIVE" : "SUSPENDED";
    if (newStatus === "SUSPENDED") {
      if (!window.confirm(`Suspend "${tenant.businessName ?? tenant.slug}"? This will block their access.`)) return;
    }
    setActionLoading(tenant.id);
    try {
      await superAdminClient.patch(`/platform-admin/tenants/${tenant.id}/status`, { status: newStatus });
      fetchTenants(page);
    } catch (err: unknown) {
      alert((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Action failed");
    } finally {
      setActionLoading(null);
    }
  };

  const impersonate = async (tenant: Tenant) => {
    setActionLoading(tenant.id + "-imp");
    try {
      const res = await superAdminClient.post(`/platform-admin/tenants/${tenant.id}/impersonate`);
      localStorage.setItem("impersonationToken", res.data.accessToken);
      localStorage.setItem("impersonationTenantSlug", tenant.slug);
      router.push("/dashboard");
    } catch (err: unknown) {
      alert((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Impersonation failed");
    } finally {
      setActionLoading(null);
    }
  };

  // Client-side filtering
  const filteredRows = React.useMemo(() => {
    if (!data) return [];
    const q = search.toLowerCase();
    return data.data.filter((t) => {
      const matchSearch =
        !q ||
        t.slug.toLowerCase().includes(q) ||
        (t.businessName ?? t.name).toLowerCase().includes(q);
      const matchStatus = !statusFilter || t.status === statusFilter;
      return matchSearch && matchStatus;
    });
  }, [data, search, statusFilter]);

  const filtersActive = search !== "" || statusFilter !== "";

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Tenants</h1>
          <p className="mt-1 text-sm text-slate-400">
            {data ? `${data.meta.total} total tenant${data.meta.total !== 1 ? "s" : ""}` : ""}
          </p>
        </div>
        <Link
          href="/admin/tenants/new"
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-500"
        >
          + Create New Tenant
        </Link>
      </div>

      {/* Search & Filter */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search by slug or name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 w-64 rounded-lg border border-slate-600 bg-slate-800 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 rounded-lg border border-slate-600 bg-slate-800 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
        >
          <option value="">All Statuses</option>
          <option value="ACTIVE">ACTIVE</option>
          <option value="TRIAL">TRIAL</option>
          <option value="SUSPENDED">SUSPENDED</option>
          <option value="CANCELLED">CANCELLED</option>
        </select>
        {filtersActive && (
          <span className="text-sm text-slate-400">
            {filteredRows.length} result{filteredRows.length !== 1 ? "s" : ""}
          </span>
        )}
        {filtersActive && (
          <button
            onClick={() => { setSearch(""); setStatusFilter(""); }}
            className="text-xs text-slate-500 hover:text-slate-300"
          >
            Clear filters
          </button>
        )}
      </div>

      {loading && <div className="text-center text-slate-500 py-12">Loading tenants…</div>}

      {error && (
        <div className="rounded-lg bg-red-900/40 px-4 py-3 text-sm text-red-400 ring-1 ring-red-700 mb-4">
          {error}
        </div>
      )}

      {data && (
        <>
          <div className="rounded-xl bg-slate-800 ring-1 ring-white/5 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-500">
                    <th className="px-4 py-3 text-left">Slug</th>
                    <th className="px-4 py-3 text-left">Business Name</th>
                    <th className="px-4 py-3 text-left">Status</th>
                    <th className="px-4 py-3 text-left">Plan</th>
                    <th className="px-4 py-3 text-right">Users</th>
                    <th className="px-4 py-3 text-left">Created</th>
                    <th className="px-4 py-3 text-left">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/50">
                  {filteredRows.map((t) => (
                    <tr key={t.id} className="hover:bg-slate-700/30 transition-colors">
                      <td className="px-4 py-3 font-mono text-slate-300">{t.slug}</td>
                      <td className="px-4 py-3 text-white">{t.businessName ?? t.name}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${STATUS_COLORS[t.status] ?? "bg-slate-700 text-slate-400"}`}>
                          {t.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-400">{t.plan}</td>
                      <td className="px-4 py-3 text-right text-slate-400">{t.counts?.users ?? 0}</td>
                      <td className="px-4 py-3 text-slate-500">{new Date(t.createdAt).toLocaleDateString()}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/admin/tenants/${t.id}`}
                            className="rounded px-2 py-1 text-xs font-medium text-indigo-400 hover:bg-indigo-900/30 hover:text-indigo-300"
                          >
                            View
                          </Link>
                          {t.status !== "CANCELLED" && (
                            <button
                              disabled={actionLoading === t.id}
                              onClick={() => toggleStatus(t)}
                              className={`rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                                t.status === "SUSPENDED"
                                  ? "text-green-400 hover:bg-green-900/30"
                                  : "text-yellow-400 hover:bg-yellow-900/30"
                              }`}
                            >
                              {t.status === "SUSPENDED" ? "Reactivate" : "Suspend"}
                            </button>
                          )}
                          {t.status !== "CANCELLED" && (
                            <button
                              disabled={actionLoading === t.id + "-imp"}
                              onClick={() => impersonate(t)}
                              className="rounded px-2 py-1 text-xs font-medium text-slate-400 hover:bg-slate-700 hover:text-white disabled:opacity-50"
                            >
                              Impersonate
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filteredRows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                        {filtersActive ? "No tenants match your filters." : (
                          <>No tenants yet.{" "}<Link href="/admin/tenants/new" className="text-indigo-400 hover:underline">Create one</Link></>
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          {data.meta.pages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800 disabled:opacity-40"
              >
                ← Prev
              </button>
              <span className="text-sm text-slate-500">
                Page {data.meta.page} of {data.meta.pages}
              </span>
              <button
                disabled={page >= data.meta.pages}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800 disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
