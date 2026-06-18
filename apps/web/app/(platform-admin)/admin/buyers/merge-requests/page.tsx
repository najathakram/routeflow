"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { superAdminClient } from "@/lib/admin-api";
import { GitMerge, Loader2, ArrowLeft, ExternalLink } from "lucide-react";

const STATUS_COLORS: Record<string, string> = {
  PENDING_VERIFICATION: "bg-yellow-900/30 text-yellow-400",
  PENDING_REVIEW: "bg-blue-900/30 text-blue-400",
  COMPLETED: "bg-green-900/30 text-green-400",
  REJECTED: "bg-red-900/30 text-red-400",
};

const INITIATOR_LABELS: Record<string, string> = {
  BUYER: "Buyer self-service",
  TENANT: "Tenant suggestion",
  SUPER_ADMIN: "Admin direct",
};

interface MergeRequest {
  id: string;
  status: string;
  initiatedBy: string;
  createdAt: string;
  verifiedAt: string | null;
  completedAt: string | null;
  rejectedAt: string | null;
  primaryAccount: { id: string; email: string; name: string | null };
  secondaryAccount: { id: string; email: string; name: string | null };
  initiatingTenant: { id: string; name: string; slug: string } | null;
}

export default function MergeRequestsPage() {
  const [requests, setRequests] = React.useState<MergeRequest[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [statusFilter, setStatusFilter] = React.useState("");
  const [loading, setLoading] = React.useState(true);

  const fetchRequests = React.useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (statusFilter) params.append("status", statusFilter);
      const res = await superAdminClient.get(`/platform-admin/buyer-merge-requests?${params}`);
      setRequests(res.data.data);
      setTotal(res.data.meta.total);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  React.useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  return (
    <div className="p-6 md:p-8">
      <div className="mb-6 flex items-center gap-4">
        <Link href="/admin/buyers" className="text-slate-400 hover:text-white">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600/20">
            <GitMerge className="h-5 w-5 text-indigo-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Merge Requests</h1>
            <p className="text-xs text-slate-500">{total} total</p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="h-9 rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
          >
            <option value="">All statuses</option>
            <option value="PENDING_VERIFICATION">Pending Verification</option>
            <option value="PENDING_REVIEW">Pending Review</option>
            <option value="COMPLETED">Completed</option>
            <option value="REJECTED">Rejected</option>
          </select>
        </div>
      </div>

      <div className="rounded-xl border border-slate-700/50 bg-slate-800/40 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-indigo-400" />
          </div>
        ) : requests.length === 0 ? (
          <div className="py-16 text-center text-slate-500">No merge requests found.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3 text-left">Primary Account</th>
                <th className="px-4 py-3 text-left">Secondary Account</th>
                <th className="px-4 py-3 text-left">Initiated By</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Created</th>
                <th className="px-4 py-3 text-left">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {requests.map((req) => (
                <tr key={req.id} className="hover:bg-slate-700/20">
                  <td className="px-4 py-3">
                    <p className="font-medium text-white">
                      {req.primaryAccount.name ?? req.primaryAccount.email}
                    </p>
                    <p className="text-xs text-slate-500">{req.primaryAccount.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium text-white">
                      {req.secondaryAccount.name ?? req.secondaryAccount.email}
                    </p>
                    <p className="text-xs text-slate-500">{req.secondaryAccount.email}</p>
                  </td>
                  <td className="px-4 py-3 text-slate-400">
                    <p>{INITIATOR_LABELS[req.initiatedBy] ?? req.initiatedBy}</p>
                    {req.initiatingTenant && (
                      <p className="text-xs text-slate-500">{req.initiatingTenant.name}</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[req.status] ?? "bg-slate-700 text-slate-400"}`}
                    >
                      {req.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs">
                    {new Date(req.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/buyers/merge-requests/${req.id}`}
                      className="flex items-center gap-1 text-indigo-400 hover:text-indigo-300 text-xs font-medium"
                    >
                      Review <ExternalLink className="h-3 w-3" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {total > 20 && (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-400">
          <span>
            Page {page} of {Math.ceil(total / 20)}
          </span>
          <div className="flex gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="rounded px-3 py-1 hover:bg-slate-700 disabled:opacity-40"
            >
              ← Prev
            </button>
            <button
              disabled={page >= Math.ceil(total / 20)}
              onClick={() => setPage((p) => p + 1)}
              className="rounded px-3 py-1 hover:bg-slate-700 disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
