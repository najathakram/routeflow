"use client";

import * as React from "react";
import Link from "next/link";
import { superAdminClient } from "@/lib/admin-api";
import { AdminBadge } from "../../_components/AdminBadge";
import { AdminModal } from "../../_components/AdminModal";
import { ChevronUp, ChevronDown, Users, CheckCircle, ShieldOff, Link2 } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BuyerRow {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  status: "ACTIVE" | "SUSPENDED" | "DELETED";
  emailVerified: boolean;
  createdAt: string;
  _count: { customerLinks: number };
}

interface BuyersResponse {
  data: BuyerRow[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

interface Stats {
  buyers: { total: number; active: number };
  links: { total: number; last30Days: number; byStatus: Record<string, number> };
}

type SortKey = "name" | "email" | "status" | "links" | "createdAt";
type SortDir = "asc" | "desc";

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminBuyersPage() {
  const [data, setData] = React.useState<BuyersResponse | null>(null);
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [actionLoading, setActionLoading] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [confirmAction, setConfirmAction] = React.useState<{ buyer: BuyerRow; status: "SUSPENDED" | "DELETED" } | null>(null);

  // Filters
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");

  // Sort
  const [sortKey, setSortKey] = React.useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = React.useState<SortDir>("desc");

  const fetchBuyers = React.useCallback((p: number) => {
    setLoading(true);
    setError(null);
    superAdminClient
      .get<BuyersResponse>(`/platform-admin/buyer-accounts?page=${p}&limit=200`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err?.response?.data?.message ?? "Failed to load buyers"))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    fetchBuyers(page);
    superAdminClient
      .get<Stats>("/platform-admin/customer-links/stats")
      .then((res) => setStats(res.data))
      .catch(() => null);
  }, [page, fetchBuyers]);

  const setStatus = async (buyer: BuyerRow, status: "ACTIVE" | "SUSPENDED" | "DELETED") => {
    if (status === "DELETED" || status === "SUSPENDED") {
      setConfirmAction({ buyer, status });
      return;
    }
    await executeStatus(buyer, status);
  };

  const executeStatus = async (buyer: BuyerRow, status: "ACTIVE" | "SUSPENDED" | "DELETED") => {
    setActionLoading(buyer.id + status);
    setActionError(null);
    try {
      await superAdminClient.patch(`/platform-admin/buyer-accounts/${buyer.id}/status`, { status });
      fetchBuyers(page);
    } catch (err: unknown) {
      setActionError((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Action failed");
    } finally {
      setActionLoading(null);
    }
  };

  // Filter + sort (client-side on the fetched page)
  const filteredSorted = React.useMemo(() => {
    if (!data) return [];
    const q = search.toLowerCase();
    let rows = data.data.filter((b) => {
      const matchSearch = !q || b.email.toLowerCase().includes(q) || b.name.toLowerCase().includes(q);
      const matchStatus = !statusFilter || b.status === statusFilter;
      return matchSearch && matchStatus;
    });

    rows.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "name":    cmp = a.name.localeCompare(b.name); break;
        case "email":   cmp = a.email.localeCompare(b.email); break;
        case "status":  cmp = a.status.localeCompare(b.status); break;
        case "links":   cmp = a._count.customerLinks - b._count.customerLinks; break;
        case "createdAt": cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(); break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [data, search, statusFilter, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <span className="text-slate-600 ml-1">&#8597;</span>;
    return sortDir === "asc" ? <ChevronUp className="inline h-3 w-3 ml-0.5" /> : <ChevronDown className="inline h-3 w-3 ml-0.5" />;
  };

  const filtersActive = search !== "" || statusFilter !== "";

  return (
    <div className="p-6">
      {/* Confirm action modal */}
      <AdminModal
        open={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        title={
          confirmAction?.status === "DELETED"
            ? `Permanently delete "${confirmAction?.buyer.name}"?`
            : `Suspend "${confirmAction?.buyer.name}"?`
        }
        footer={
          <>
            <button onClick={() => setConfirmAction(null)} className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-slate-700">Cancel</button>
            <button
              disabled={!!actionLoading}
              onClick={async () => {
                if (!confirmAction) return;
                const { buyer, status } = confirmAction;
                setConfirmAction(null);
                await executeStatus(buyer, status);
              }}
              className={`rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 ${
                confirmAction?.status === "DELETED" ? "bg-red-600 hover:bg-red-500" : "bg-yellow-600 hover:bg-yellow-500"
              }`}
            >
              {confirmAction?.status === "DELETED" ? "Delete Permanently" : "Suspend"}
            </button>
          </>
        }
      >
        {confirmAction?.status === "DELETED" ? (
          <p className="text-sm text-slate-300">
            This will permanently delete <strong className="text-white">{confirmAction?.buyer.name}</strong> ({confirmAction?.buyer.email}). This action cannot be undone.
          </p>
        ) : (
          <p className="text-sm text-slate-300">
            <strong className="text-white">{confirmAction?.buyer.name}</strong> will be suspended and will not be able to log in. You can reactivate them at any time.
          </p>
        )}
      </AdminModal>

      {/* Action error banner */}
      {actionError && (
        <div className="mb-4 rounded-lg bg-red-900/40 px-4 py-3 text-sm text-red-400 ring-1 ring-red-700 flex items-center justify-between">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="ml-4 text-red-400 hover:text-red-200 text-lg leading-none">&times;</button>
        </div>
      )}

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Buyers</h1>
        <p className="mt-1 text-sm text-slate-400">
          All customer portal accounts across the platform
        </p>
      </div>

      {/* Stats */}
      {stats && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Total Buyers", value: stats.buyers.total, icon: Users, color: "text-indigo-400" },
            { label: "Active", value: stats.buyers.active, icon: CheckCircle, color: "text-green-400" },
            { label: "Suspended", value: (stats.buyers.total - stats.buyers.active), icon: ShieldOff, color: "text-yellow-400" },
            { label: "Active Links", value: stats.links.byStatus?.ACTIVE ?? 0, icon: Link2, color: "text-sky-400" },
          ].map((s) => (
            <div key={s.label} className="rounded-xl bg-slate-800 p-4 ring-1 ring-white/5">
              <s.icon className={`h-4 w-4 ${s.color} mb-2`} />
              <div className="text-2xl font-bold text-white">{s.value}</div>
              <div className="text-xs text-slate-500">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Search & Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search by name or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 w-72 rounded-lg border border-slate-600 bg-slate-800 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 rounded-lg border border-slate-600 bg-slate-800 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
        >
          <option value="">All Statuses</option>
          <option value="ACTIVE">ACTIVE</option>
          <option value="SUSPENDED">SUSPENDED</option>
          <option value="DELETED">DELETED</option>
        </select>
        {filtersActive && (
          <>
            <span className="text-sm text-slate-400">{filteredSorted.length} results</span>
            <button
              onClick={() => { setSearch(""); setStatusFilter(""); }}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              Clear filters
            </button>
          </>
        )}
      </div>

      {loading && <div className="py-12 text-center text-slate-500">Loading buyers...</div>}
      {error && (
        <div className="mb-4 rounded-lg bg-red-900/40 px-4 py-3 text-sm text-red-400 ring-1 ring-red-700">
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
                    <th className="px-4 py-3 text-left cursor-pointer select-none" onClick={() => toggleSort("name")}>
                      Name <SortIcon col="name" />
                    </th>
                    <th className="px-4 py-3 text-left cursor-pointer select-none" onClick={() => toggleSort("email")}>
                      Email <SortIcon col="email" />
                    </th>
                    <th className="px-4 py-3 text-left">Verified</th>
                    <th className="px-4 py-3 text-left cursor-pointer select-none" onClick={() => toggleSort("status")}>
                      Status <SortIcon col="status" />
                    </th>
                    <th className="px-4 py-3 text-right cursor-pointer select-none" onClick={() => toggleSort("links")}>
                      Sellers <SortIcon col="links" />
                    </th>
                    <th className="px-4 py-3 text-left cursor-pointer select-none" onClick={() => toggleSort("createdAt")}>
                      Joined <SortIcon col="createdAt" />
                    </th>
                    <th className="px-4 py-3 text-left">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/50">
                  {filteredSorted.map((b) => (
                    <tr key={b.id} className="hover:bg-slate-700/30 transition-colors">
                      <td className="px-4 py-3 font-medium text-white">{b.name}</td>
                      <td className="px-4 py-3 text-slate-300">{b.email}</td>
                      <td className="px-4 py-3">
                        {b.emailVerified ? (
                          <span className="text-xs font-medium text-green-400">Verified</span>
                        ) : (
                          <span className="text-xs text-slate-500">Unverified</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <AdminBadge>{b.status}</AdminBadge>
                      </td>
                      <td className="px-4 py-3 text-right text-slate-400">{b._count.customerLinks}</td>
                      <td className="px-4 py-3 text-slate-500">
                        {new Date(b.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/admin/buyers/${b.id}`}
                            className="rounded px-2 py-1 text-xs font-medium text-indigo-400 hover:bg-indigo-900/30 hover:text-indigo-300"
                          >
                            Manage
                          </Link>
                          {b.status === "ACTIVE" && (
                            <button
                              disabled={!!actionLoading}
                              onClick={() => setStatus(b, "SUSPENDED")}
                              className="rounded px-2 py-1 text-xs font-medium text-yellow-400 hover:bg-yellow-900/30 disabled:opacity-50"
                            >
                              Suspend
                            </button>
                          )}
                          {b.status === "SUSPENDED" && (
                            <button
                              disabled={!!actionLoading}
                              onClick={() => setStatus(b, "ACTIVE")}
                              className="rounded px-2 py-1 text-xs font-medium text-green-400 hover:bg-green-900/30 disabled:opacity-50"
                            >
                              Reactivate
                            </button>
                          )}
                          {b.status !== "DELETED" && (
                            <button
                              disabled={!!actionLoading}
                              onClick={() => setStatus(b, "DELETED")}
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
                      <td colSpan={7} className="px-4 py-12 text-center text-slate-500">
                        {filtersActive ? "No buyers match your filters." : "No buyer accounts yet."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {data.meta.totalPages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800 disabled:opacity-40"
              >
                Prev
              </button>
              <span className="text-sm text-slate-500">
                Page {data.meta.page} of {data.meta.totalPages}
              </span>
              <button
                disabled={page >= data.meta.totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
