"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { superAdminClient } from "@/lib/admin-api";

interface AuditLogEntry {
  id: string;
  tenantId: string | null;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  ip: string | null;
  createdAt: string;
}

interface AuditLogsResponse {
  data: AuditLogEntry[];
  meta: { total: number; page: number; limit: number; pages: number };
}

export default function AuditLogsPage() {
  const searchParams = useSearchParams();
  const initialTenantId = searchParams.get("tenantId") ?? "";

  const [data, setData] = React.useState<AuditLogsResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(1);

  // Filters
  const [tenantIdFilter, setTenantIdFilter] = React.useState(initialTenantId);
  const [actionFilter, setActionFilter] = React.useState("");
  const [entityTypeFilter, setEntityTypeFilter] = React.useState("");
  const [userIdFilter, setUserIdFilter] = React.useState("");
  const [fromDate, setFromDate] = React.useState("");
  const [toDate, setToDate] = React.useState("");

  // Debounce text inputs
  const [debouncedFilters, setDebouncedFilters] = React.useState({
    tenantId: initialTenantId,
    action: "",
    entityType: "",
    userId: "",
    from: "",
    to: "",
  });

  React.useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedFilters({
        tenantId: tenantIdFilter,
        action: actionFilter,
        entityType: entityTypeFilter,
        userId: userIdFilter,
        from: fromDate,
        to: toDate,
      });
      setPage(1);
    }, 400);
    return () => clearTimeout(t);
  }, [tenantIdFilter, actionFilter, entityTypeFilter, userIdFilter, fromDate, toDate]);

  const fetchLogs = React.useCallback((p: number, filters: typeof debouncedFilters) => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(p), limit: "50" });
    if (filters.tenantId) params.set("tenantId", filters.tenantId);
    if (filters.action) params.set("action", filters.action);
    if (filters.entityType) params.set("entityType", filters.entityType);
    if (filters.userId) params.set("userId", filters.userId);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    superAdminClient
      .get<AuditLogsResponse>(`/platform-admin/audit-logs?${params}`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err?.response?.data?.message ?? "Failed to load audit logs"))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    fetchLogs(page, debouncedFilters);
  }, [page, debouncedFilters, fetchLogs]);

  const hasFilters =
    tenantIdFilter || actionFilter || entityTypeFilter || userIdFilter || fromDate || toDate;

  const clearFilters = () => {
    setTenantIdFilter("");
    setActionFilter("");
    setEntityTypeFilter("");
    setUserIdFilter("");
    setFromDate("");
    setToDate("");
  };

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Audit Logs</h1>
        <p className="mt-1 text-sm text-slate-400">Platform-wide activity log</p>
      </div>

      {/* Filters */}
      <div className="mb-4 rounded-xl bg-slate-800 p-4 ring-1 ring-white/5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Filters</h2>
          {hasFilters && (
            <button onClick={clearFilters} className="text-xs text-slate-500 hover:text-slate-300">
              Clear all
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <input
            type="text"
            placeholder="Tenant ID..."
            value={tenantIdFilter}
            onChange={(e) => setTenantIdFilter(e.target.value)}
            className="h-9 rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
          />
          <input
            type="text"
            placeholder="Action (e.g. LOGIN, CREATE)..."
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="h-9 rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
          />
          <input
            type="text"
            placeholder="Entity Type (e.g. User, Order)..."
            value={entityTypeFilter}
            onChange={(e) => setEntityTypeFilter(e.target.value)}
            className="h-9 rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
          />
          <input
            type="text"
            placeholder="User ID..."
            value={userIdFilter}
            onChange={(e) => setUserIdFilter(e.target.value)}
            className="h-9 rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500 shrink-0">From</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="h-9 flex-1 rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500 shrink-0">To</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="h-9 flex-1 rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
            />
          </div>
        </div>
        {data && <p className="mt-2 text-xs text-slate-500">{data.meta.total} total entries</p>}
      </div>

      {loading && <div className="py-12 text-center text-slate-500">Loading audit logs...</div>}

      {error && (
        <div className="mb-4 rounded-lg bg-red-900/40 px-4 py-3 text-sm text-red-400 ring-1 ring-red-700">
          {error}
        </div>
      )}

      {data && !loading && (
        <>
          <div className="rounded-xl bg-slate-800 ring-1 ring-white/5 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-3 text-left">Tenant</th>
                    <th className="px-3 py-3 text-left">User</th>
                    <th className="px-3 py-3 text-left">Action</th>
                    <th className="px-3 py-3 text-left">Entity Type</th>
                    <th className="px-3 py-3 text-left">Entity ID</th>
                    <th className="px-3 py-3 text-left">Timestamp</th>
                    <th className="px-3 py-3 text-left">IP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/50">
                  {data.data.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-700/20">
                      <td className="px-3 py-2 font-mono text-slate-400">
                        {log.tenantId ? log.tenantId.slice(0, 8) + "..." : "—"}
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-400">
                        {log.userId ? log.userId.slice(0, 8) + "..." : "—"}
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-300">{log.action}</td>
                      <td className="px-3 py-2 text-slate-400">{log.entityType}</td>
                      <td className="px-3 py-2 font-mono text-slate-500">
                        {log.entityId ? log.entityId.slice(0, 8) + "..." : "—"}
                      </td>
                      <td className="px-3 py-2 text-slate-500">
                        {new Date(log.createdAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-slate-500">{log.ip ?? "—"}</td>
                    </tr>
                  ))}
                  {data.data.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                        No audit log entries found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {data.meta.pages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800 disabled:opacity-40"
              >
                Prev
              </button>
              <span className="text-sm text-slate-500">
                Page {data.meta.page} of {data.meta.pages}
              </span>
              <button
                disabled={page >= data.meta.pages}
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
