"use client";

import * as React from "react";
import Link from "next/link";
import { superAdminClient } from "@/lib/admin-api";
import { AdminBadge } from "../../_components/AdminBadge";
import { ArrowLeft, Check } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BuyerRow {
  id: string;
  email: string;
  name: string;
  status: "ACTIVE" | "SUSPENDED" | "DELETED";
  emailVerified: boolean;
  createdAt: string;
  businessName: string | null;
  sellers: number;
  orders90d: number;
}

interface Segments {
  all: number;
  multiSeller: number;
  unverified: number;
}

interface DirectoryResponse {
  data: BuyerRow[];
  segments: Segments;
  meta: { total: number; page: number; limit: number; pages: number };
}

interface MergeAccount {
  id: string;
  email: string;
  name: string;
  sellers: number;
  orders90d: number;
}

interface MergeRequest {
  id: string;
  status: string;
  initiatedBy: string;
  initiatorNotes: string | null;
  createdAt: string;
  primary: MergeAccount;
  secondary: MergeAccount;
}

interface MergeSummary {
  data: MergeRequest[];
  pendingCount: number;
}

type Segment = "all" | "multi-seller" | "unverified";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminBuyersPage() {
  const [data, setData] = React.useState<DirectoryResponse | null>(null);
  const [merges, setMerges] = React.useState<MergeSummary | null>(null);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [actionLoading, setActionLoading] = React.useState<string | null>(null);

  const [search, setSearch] = React.useState("");
  const [segment, setSegment] = React.useState<Segment>("all");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const reqSeqRef = React.useRef(0);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  React.useEffect(() => {
    setPage(1);
  }, [debouncedSearch, segment]);

  const fetchDirectory = React.useCallback(
    (p: number) => {
      const seq = ++reqSeqRef.current;
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({ page: String(p), limit: "25", segment });
      if (debouncedSearch) params.set("search", debouncedSearch);
      superAdminClient
        .get<DirectoryResponse>(`/platform-admin/buyer-directory?${params}`)
        .then((res) => {
          if (seq === reqSeqRef.current) setData(res.data);
        })
        .catch((err) => {
          if (seq === reqSeqRef.current)
            setError(err?.response?.data?.message ?? "Failed to load buyers");
        })
        .finally(() => {
          if (seq === reqSeqRef.current) setLoading(false);
        });
    },
    [debouncedSearch, segment],
  );

  React.useEffect(() => {
    fetchDirectory(page);
  }, [page, fetchDirectory]);

  const fetchMerges = React.useCallback(() => {
    superAdminClient
      .get<MergeSummary>("/platform-admin/buyer-merge-summary?limit=10")
      .then((res) => setMerges(res.data))
      .catch(() => setMerges({ data: [], pendingCount: 0 }));
  }, []);

  React.useEffect(() => {
    fetchMerges();
  }, [fetchMerges]);

  const setStatus = async (buyer: BuyerRow, status: "ACTIVE" | "SUSPENDED" | "DELETED") => {
    if (
      status === "DELETED" &&
      !window.confirm(`Permanently delete "${buyer.name}" (${buyer.email})?`)
    )
      return;
    if (status === "SUSPENDED" && !window.confirm(`Suspend "${buyer.name}"?`)) return;
    setActionLoading(buyer.id + status);
    try {
      await superAdminClient.patch(`/platform-admin/buyer-accounts/${buyer.id}/status`, { status });
      fetchDirectory(page);
    } catch (err: unknown) {
      alert(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Action failed",
      );
    } finally {
      setActionLoading(null);
    }
  };

  const resolveMerge = async (req: MergeRequest, action: "execute" | "reject") => {
    const verb = action === "execute" ? "Approve" : "Reject";
    if (!window.confirm(`${verb} merge of ${req.secondary.email} into ${req.primary.email}?`))
      return;
    setActionLoading("merge" + req.id);
    try {
      await superAdminClient.post(`/platform-admin/buyer-merge-requests/${req.id}/${action}`, {});
      fetchMerges();
      fetchDirectory(page);
    } catch (err: unknown) {
      alert(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Merge action failed",
      );
    } finally {
      setActionLoading(null);
    }
  };

  const chips: { key: Segment; label: string; count?: number }[] = [
    { key: "all", label: "All", count: data?.segments.all },
    { key: "multi-seller", label: "Multi-seller", count: data?.segments.multiSeller },
    { key: "unverified", label: "Unverified", count: data?.segments.unverified },
  ];

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-1 flex items-baseline gap-3">
        <h1 className="text-2xl font-bold text-white">Buyers</h1>
        {data && (
          <span className="text-sm text-slate-400">
            · {data.segments.all.toLocaleString()} accounts
          </span>
        )}
      </div>
      <p className="mb-5 text-sm text-slate-400">
        Cross-tenant buyer accounts and pending account merges.
      </p>

      {/* Search + segment chips */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Buyer email or name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 w-72 rounded-lg border border-slate-600 bg-slate-800 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
        />
        {chips.map((c) => (
          <button
            key={c.key}
            onClick={() => setSegment(c.key)}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              segment === c.key
                ? "border-indigo-500 bg-indigo-900/40 text-indigo-300"
                : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200"
            }`}
          >
            {c.label}
            {typeof c.count === "number" && (
              <span className="ml-1.5 text-slate-500">{c.count.toLocaleString()}</span>
            )}
          </button>
        ))}
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
                    <th className="px-4 py-3 text-left">Buyer</th>
                    <th className="px-4 py-3 text-left">Business</th>
                    <th className="px-4 py-3 text-right">Sellers</th>
                    <th className="px-4 py-3 text-right">Orders 90d</th>
                    <th className="px-4 py-3 text-left">Verified</th>
                    <th className="px-4 py-3 text-left">Joined</th>
                    <th className="px-4 py-3 text-left">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/50">
                  {data.data.map((b) => (
                    <tr key={b.id} className="hover:bg-slate-700/30 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-white">{b.email}</span>
                          {b.status !== "ACTIVE" && <AdminBadge>{b.status}</AdminBadge>}
                        </div>
                        {b.name && b.name !== b.email && (
                          <div className="text-xs text-slate-500">{b.name}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-300">{b.businessName ?? "—"}</td>
                      <td className="px-4 py-3 text-right text-slate-400">{b.sellers}</td>
                      <td className="px-4 py-3 text-right text-slate-400">{b.orders90d}</td>
                      <td className="px-4 py-3">
                        {b.emailVerified ? (
                          <span className="text-xs font-medium text-green-400">Verified</span>
                        ) : (
                          <span className="text-xs text-yellow-500">Unverified</span>
                        )}
                      </td>
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
                  {data.data.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-12 text-center text-slate-500">
                        No buyer accounts match this view.
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

      {/* Inline Merge Requests */}
      {merges && merges.data.length > 0 && (
        <div className="mt-8 rounded-xl bg-slate-800 ring-1 ring-white/5 overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-700 px-5 py-3">
            <h3 className="text-sm font-semibold text-white">Merge Requests</h3>
            <span className="rounded-full bg-yellow-900/40 px-2.5 py-0.5 text-xs font-medium text-yellow-400 ring-1 ring-yellow-600/30">
              {plural(merges.pendingCount, "pending")}
            </span>
          </div>
          <div className="flex flex-col divide-y divide-slate-700/50">
            {merges.data.map((req) => (
              <div key={req.id} className="px-5 py-4">
                <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
                  <div className="rounded-lg border border-slate-700 p-3">
                    <div className="font-medium text-white">{req.primary.email}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      kept · {plural(req.primary.sellers, "seller")} · {req.primary.orders90d}{" "}
                      orders
                    </div>
                  </div>
                  <ArrowLeft className="mx-auto hidden h-4 w-4 text-slate-500 sm:block" />
                  <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
                    <div className="font-medium text-white">{req.secondary.email}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      absorbed · {plural(req.secondary.sellers, "seller")} ·{" "}
                      {req.secondary.orders90d} orders
                    </div>
                    {req.initiatorNotes && (
                      <div className="mt-1 text-xs italic text-slate-500">
                        &ldquo;{req.initiatorNotes}&rdquo;
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-end gap-2">
                  <Link
                    href={`/admin/buyers/merge-requests/${req.id}`}
                    className="rounded px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700"
                  >
                    View details
                  </Link>
                  <button
                    disabled={!!actionLoading}
                    onClick={() => resolveMerge(req, "reject")}
                    className="rounded px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-900/30 disabled:opacity-50"
                  >
                    Reject
                  </button>
                  <button
                    disabled={!!actionLoading}
                    onClick={() => resolveMerge(req, "execute")}
                    className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                  >
                    <Check className="h-3 w-3" /> Approve merge
                  </button>
                </div>
              </div>
            ))}
          </div>
          {merges.pendingCount > merges.data.length && (
            <div className="border-t border-slate-700 px-5 py-2 text-center">
              <Link
                href="/admin/buyers/merge-requests"
                className="text-xs text-indigo-400 hover:text-indigo-300"
              >
                View all {merges.pendingCount} merge requests
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
