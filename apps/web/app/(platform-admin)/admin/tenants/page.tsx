"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { superAdminClient } from "@/lib/admin-api";
import { AdminBadge } from "../../_components/AdminBadge";
import { AdminModal } from "../../_components/AdminModal";
import { ChevronUp, ChevronDown } from "lucide-react";

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

type SortKey = "slug" | "name" | "status" | "plan" | "users" | "createdAt";
type SortDir = "asc" | "desc";

export default function AdminTenantsPage() {
  const router = useRouter();
  const [data, setData] = React.useState<TenantsResponse | null>(null);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [actionLoading, setActionLoading] = React.useState<string | null>(null);

  // Filters
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");
  const [planFilter, setPlanFilter] = React.useState("");

  // Sort
  const [sortKey, setSortKey] = React.useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = React.useState<SortDir>("desc");

  // Bulk selection
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = React.useState<string | null>(null);
  const [bulkPlan, setBulkPlan] = React.useState("STARTER");

  const fetchTenants = React.useCallback((p: number) => {
    setLoading(true);
    setError(null);
    superAdminClient
      .get<TenantsResponse>(`/platform-admin/tenants?page=${p}&limit=200`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err?.response?.data?.message ?? "Failed to load tenants"))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => { fetchTenants(page); }, [page, fetchTenants]);

  const [deletingTenant, setDeletingTenant] = React.useState<Tenant | null>(null);
  const [deleteConfirmSlug, setDeleteConfirmSlug] = React.useState("");

  const deleteTenant = async () => {
    if (!deletingTenant || deleteConfirmSlug !== deletingTenant.slug) return;
    setActionLoading(deletingTenant.id + "-del");
    try {
      await superAdminClient.delete(`/platform-admin/tenants/${deletingTenant.id}`);
      setDeletingTenant(null);
      setDeleteConfirmSlug("");
      fetchTenants(page);
    } catch (err: unknown) {
      alert((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Delete failed");
    } finally {
      setActionLoading(null);
    }
  };

  const toggleStatus = async (tenant: Tenant) => {
    const newStatus = tenant.status === "SUSPENDED" ? "ACTIVE" : "SUSPENDED";
    if (newStatus === "SUSPENDED") {
      if (!window.confirm(`Suspend "${tenant.businessName ?? tenant.slug}"?`)) return;
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

  // Filter + sort
  const filteredSorted = React.useMemo(() => {
    if (!data) return [];
    const q = search.toLowerCase();
    let rows = data.data.filter((t) => {
      const matchSearch = !q || t.slug.toLowerCase().includes(q) || (t.businessName ?? t.name).toLowerCase().includes(q);
      const matchStatus = !statusFilter || t.status === statusFilter;
      const matchPlan = !planFilter || t.plan === planFilter;
      return matchSearch && matchStatus && matchPlan;
    });

    rows.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "slug": cmp = a.slug.localeCompare(b.slug); break;
        case "name": cmp = (a.businessName ?? a.name).localeCompare(b.businessName ?? b.name); break;
        case "status": cmp = a.status.localeCompare(b.status); break;
        case "plan": cmp = a.plan.localeCompare(b.plan); break;
        case "users": cmp = (a.counts?.users ?? 0) - (b.counts?.users ?? 0); break;
        case "createdAt": cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(); break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [data, search, statusFilter, planFilter, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <span className="text-slate-600 ml-1">&#8597;</span>;
    return sortDir === "asc" ? <ChevronUp className="inline h-3 w-3 ml-0.5" /> : <ChevronDown className="inline h-3 w-3 ml-0.5" />;
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === filteredSorted.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filteredSorted.map((t) => t.id)));
    }
  };

  const executeBulk = async () => {
    if (!bulkAction || selected.size === 0) return;
    setActionLoading("bulk");
    const ids = Array.from(selected);
    try {
      for (const id of ids) {
        if (bulkAction === "suspend") {
          await superAdminClient.patch(`/platform-admin/tenants/${id}/status`, { status: "SUSPENDED" });
        } else if (bulkAction === "activate") {
          await superAdminClient.patch(`/platform-admin/tenants/${id}/status`, { status: "ACTIVE" });
        } else if (bulkAction === "change-plan") {
          await superAdminClient.patch(`/platform-admin/tenants/${id}/plan`, { plan: bulkPlan });
        }
      }
      setSelected(new Set());
      setBulkAction(null);
      fetchTenants(page);
    } catch (err: unknown) {
      alert((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Bulk action failed");
    } finally {
      setActionLoading(null);
    }
  };

  const filtersActive = search !== "" || statusFilter !== "" || planFilter !== "";

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Tenants</h1>
          <p className="mt-1 text-sm text-slate-400">{data ? `${data.meta.total} total` : ""}</p>
        </div>
        <Link href="/admin/tenants/new" className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-500">
          + Create New Tenant
        </Link>
      </div>

      {/* Search & Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="text" placeholder="Search by slug or name..."
          value={search} onChange={(e) => setSearch(e.target.value)}
          className="h-9 w-64 rounded-lg border border-slate-600 bg-slate-800 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
        />
        <select
          value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 rounded-lg border border-slate-600 bg-slate-800 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
        >
          <option value="">All Statuses</option>
          <option value="ACTIVE">ACTIVE</option>
          <option value="TRIAL">TRIAL</option>
          <option value="SUSPENDED">SUSPENDED</option>
          <option value="CANCELLED">CANCELLED</option>
        </select>
        <select
          value={planFilter} onChange={(e) => setPlanFilter(e.target.value)}
          className="h-9 rounded-lg border border-slate-600 bg-slate-800 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
        >
          <option value="">All Plans</option>
          <option value="STARTER">STARTER</option>
          <option value="PROFESSIONAL">PROFESSIONAL</option>
          <option value="ENTERPRISE">ENTERPRISE</option>
        </select>
        {filtersActive && (
          <>
            <span className="text-sm text-slate-400">{filteredSorted.length} results</span>
            <button onClick={() => { setSearch(""); setStatusFilter(""); setPlanFilter(""); }} className="text-xs text-slate-500 hover:text-slate-300">Clear filters</button>
          </>
        )}
      </div>

      {/* Bulk actions bar */}
      {selected.size > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-lg bg-indigo-900/30 px-4 py-2 ring-1 ring-indigo-700/40">
          <span className="text-sm text-indigo-300">{selected.size} selected</span>
          <button onClick={() => setBulkAction("suspend")} className="rounded px-3 py-1 text-xs font-medium text-yellow-400 hover:bg-yellow-900/30">Suspend All</button>
          <button onClick={() => setBulkAction("activate")} className="rounded px-3 py-1 text-xs font-medium text-green-400 hover:bg-green-900/30">Activate All</button>
          <button onClick={() => setBulkAction("change-plan")} className="rounded px-3 py-1 text-xs font-medium text-blue-400 hover:bg-blue-900/30">Change Plan</button>
          <button onClick={() => setSelected(new Set())} className="ml-auto text-xs text-slate-400 hover:text-slate-300">Clear selection</button>
        </div>
      )}

      {/* Bulk Action Modal */}
      <AdminModal
        open={!!bulkAction}
        onClose={() => setBulkAction(null)}
        title={
          bulkAction === "suspend" ? `Suspend ${selected.size} tenant(s)?` :
          bulkAction === "activate" ? `Activate ${selected.size} tenant(s)?` :
          `Change plan for ${selected.size} tenant(s)`
        }
        footer={
          <>
            <button onClick={() => setBulkAction(null)} className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-slate-700">Cancel</button>
            <button
              disabled={actionLoading === "bulk"}
              onClick={executeBulk}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {actionLoading === "bulk" ? "Processing..." : "Confirm"}
            </button>
          </>
        }
      >
        {bulkAction === "change-plan" && (
          <div className="mb-3">
            <label className="mb-1 block text-sm text-slate-400">New plan</label>
            <select value={bulkPlan} onChange={(e) => setBulkPlan(e.target.value)} className="h-9 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white">
              <option value="STARTER">STARTER</option>
              <option value="PROFESSIONAL">PROFESSIONAL</option>
              <option value="ENTERPRISE">ENTERPRISE</option>
            </select>
          </div>
        )}
        <p className="text-sm text-slate-300">This action will be applied to {selected.size} selected tenant(s).</p>
      </AdminModal>

      {/* Delete confirmation modal */}
      <AdminModal
        open={!!deletingTenant}
        onClose={() => { setDeletingTenant(null); setDeleteConfirmSlug(""); }}
        title="Permanently delete tenant?"
        footer={
          <>
            <button onClick={() => { setDeletingTenant(null); setDeleteConfirmSlug(""); }} className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-slate-700">Cancel</button>
            <button
              disabled={deleteConfirmSlug !== deletingTenant?.slug || actionLoading === deletingTenant?.id + "-del"}
              onClick={deleteTenant}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
            >
              {actionLoading === deletingTenant?.id + "-del" ? "Deleting..." : "Delete Permanently"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-300">
            This will permanently cancel and archive <strong className="text-white">{deletingTenant?.businessName ?? deletingTenant?.slug}</strong>. This action cannot be undone.
          </p>
          <p className="text-sm text-slate-400">
            Type the tenant slug <strong className="font-mono text-slate-200">{deletingTenant?.slug}</strong> to confirm:
          </p>
          <input
            type="text"
            value={deleteConfirmSlug}
            onChange={(e) => setDeleteConfirmSlug(e.target.value)}
            placeholder={deletingTenant?.slug}
            className="h-9 w-full rounded-lg border border-slate-600 bg-slate-800 px-3 text-sm text-white placeholder:text-slate-500 focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/30"
          />
        </div>
      </AdminModal>

      {loading && <div className="text-center text-slate-500 py-12">Loading tenants...</div>}
      {error && <div className="rounded-lg bg-red-900/40 px-4 py-3 text-sm text-red-400 ring-1 ring-red-700 mb-4">{error}</div>}

      {data && (
        <>
          <div className="rounded-xl bg-slate-800 ring-1 ring-white/5 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-3 text-left w-8">
                      <input
                        type="checkbox"
                        checked={selected.size === filteredSorted.length && filteredSorted.length > 0}
                        onChange={toggleSelectAll}
                        className="rounded border-slate-600 bg-slate-700"
                      />
                    </th>
                    <th className="px-4 py-3 text-left cursor-pointer select-none" onClick={() => toggleSort("slug")}>
                      Slug <SortIcon col="slug" />
                    </th>
                    <th className="px-4 py-3 text-left cursor-pointer select-none" onClick={() => toggleSort("name")}>
                      Business Name <SortIcon col="name" />
                    </th>
                    <th className="px-4 py-3 text-left cursor-pointer select-none" onClick={() => toggleSort("status")}>
                      Status <SortIcon col="status" />
                    </th>
                    <th className="px-4 py-3 text-left cursor-pointer select-none" onClick={() => toggleSort("plan")}>
                      Plan <SortIcon col="plan" />
                    </th>
                    <th className="px-4 py-3 text-right cursor-pointer select-none" onClick={() => toggleSort("users")}>
                      Users <SortIcon col="users" />
                    </th>
                    <th className="px-4 py-3 text-left cursor-pointer select-none" onClick={() => toggleSort("createdAt")}>
                      Created <SortIcon col="createdAt" />
                    </th>
                    <th className="px-4 py-3 text-left">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/50">
                  {filteredSorted.map((t) => (
                    <tr key={t.id} className={`hover:bg-slate-700/30 transition-colors ${selected.has(t.id) ? "bg-indigo-900/10" : ""}`}>
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(t.id)}
                          onChange={() => toggleSelect(t.id)}
                          className="rounded border-slate-600 bg-slate-700"
                        />
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-300">{t.slug}</td>
                      <td className="px-4 py-3 text-white">{t.businessName ?? t.name}</td>
                      <td className="px-4 py-3"><AdminBadge>{t.status}</AdminBadge></td>
                      <td className="px-4 py-3"><AdminBadge variant="plan">{t.plan}</AdminBadge></td>
                      <td className="px-4 py-3 text-right text-slate-400">{t.counts?.users ?? 0}</td>
                      <td className="px-4 py-3 text-slate-500">{new Date(t.createdAt).toLocaleDateString()}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Link href={`/admin/tenants/${t.id}`} className="rounded px-2 py-1 text-xs font-medium text-indigo-400 hover:bg-indigo-900/30 hover:text-indigo-300">View</Link>
                          {t.status !== "CANCELLED" && (
                            <button
                              disabled={actionLoading === t.id}
                              onClick={() => toggleStatus(t)}
                              className={`rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${t.status === "SUSPENDED" ? "text-green-400 hover:bg-green-900/30" : "text-yellow-400 hover:bg-yellow-900/30"}`}
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
                          {t.status === "SUSPENDED" && (
                            <button
                              disabled={!!actionLoading}
                              onClick={() => { setDeletingTenant(t); setDeleteConfirmSlug(""); }}
                              className="rounded px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-900/30 disabled:opacity-50"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filteredSorted.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center text-slate-500">
                        {filtersActive ? "No tenants match your filters." : <>No tenants yet. <Link href="/admin/tenants/new" className="text-indigo-400 hover:underline">Create one</Link></>}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {data.meta.pages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800 disabled:opacity-40">Prev</button>
              <span className="text-sm text-slate-500">Page {data.meta.page} of {data.meta.pages}</span>
              <button disabled={page >= data.meta.pages} onClick={() => setPage((p) => p + 1)} className="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800 disabled:opacity-40">Next</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
