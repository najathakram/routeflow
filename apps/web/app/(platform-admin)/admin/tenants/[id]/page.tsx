"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { superAdminClient } from "../../../layout";

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "bg-green-900/40 text-green-400 ring-green-600/30",
  TRIAL: "bg-yellow-900/40 text-yellow-400 ring-yellow-600/30",
  SUSPENDED: "bg-red-900/40 text-red-400 ring-red-600/30",
  CANCELLED: "bg-slate-700 text-slate-400 ring-slate-600/30",
};

const PLANS = ["STARTER", "PROFESSIONAL", "ENTERPRISE"] as const;

interface TenantDetail {
  id: string;
  slug: string;
  name: string;
  status: string;
  plan: string;
  trialEndsAt: string | null;
  createdAt: string;
  deletedAt: string | null;
  businessName: string | null;
  primaryColor: string | null;
  logoKey: string | null;
  subscription: {
    currentPlan: string;
    periodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  counts: {
    users: number;
    customers: number;
    orders: number;
    drivers: number;
    routes: number;
  } | null;
}

interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  userId: string | null;
  ip: string | null;
  createdAt: string;
}

function TrialEndsBadge({ trialEndsAt }: { trialEndsAt: string }) {
  const end = new Date(trialEndsAt);
  const now = Date.now();
  const diffDays = Math.ceil((end.getTime() - now) / (1000 * 60 * 60 * 24));

  if (diffDays > 7) {
    return <dd className="text-green-400">{end.toLocaleString()} <span className="text-xs">({diffDays}d left)</span></dd>;
  } else if (diffDays >= 1) {
    return <dd className="text-yellow-400">{end.toLocaleString()} <span className="text-xs">({diffDays}d left)</span></dd>;
  } else {
    return <dd className="text-red-400">{end.toLocaleString()} <span className="text-xs">(expired)</span></dd>;
  }
}

export default function AdminTenantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [tenant, setTenant] = React.useState<TenantDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [actionLoading, setActionLoading] = React.useState<string | null>(null);
  const [statusMsg, setStatusMsg] = React.useState<string | null>(null);
  const [selectedPlan, setSelectedPlan] = React.useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);

  // Extend trial state
  const [trialDays, setTrialDays] = React.useState(14);

  // Reset password state
  const [showResetConfirm, setShowResetConfirm] = React.useState(false);
  const [resetResult, setResetResult] = React.useState<{ username: string; tempPassword: string } | null>(null);
  const [copied, setCopied] = React.useState(false);

  // Audit logs state
  const [auditLogs, setAuditLogs] = React.useState<AuditLogEntry[] | null>(null);
  const [auditLoading, setAuditLoading] = React.useState(false);

  const fetchTenant = React.useCallback(() => {
    setLoading(true);
    superAdminClient
      .get<TenantDetail>(`/platform-admin/tenants/${id}`)
      .then((res) => {
        setTenant(res.data);
        setSelectedPlan(res.data.plan);
      })
      .catch((err) => setError(err?.response?.data?.message ?? "Failed to load tenant"))
      .finally(() => setLoading(false));
  }, [id]);

  const fetchAuditLogs = React.useCallback(() => {
    setAuditLoading(true);
    superAdminClient
      .get<{ data: AuditLogEntry[] }>(`/platform-admin/audit-logs?tenantId=${id}&limit=20`)
      .then((res) => setAuditLogs(res.data.data))
      .catch(() => setAuditLogs([]))
      .finally(() => setAuditLoading(false));
  }, [id]);

  React.useEffect(() => {
    fetchTenant();
    fetchAuditLogs();
  }, [fetchTenant, fetchAuditLogs]);

  const handleStatusToggle = async () => {
    if (!tenant) return;
    const newStatus = tenant.status === "SUSPENDED" ? "ACTIVE" : "SUSPENDED";
    setActionLoading("status");
    try {
      await superAdminClient.patch(`/platform-admin/tenants/${id}/status`, { status: newStatus });
      setStatusMsg(`Status changed to ${newStatus}`);
      fetchTenant();
    } catch (err: unknown) {
      setStatusMsg((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Failed");
    } finally {
      setActionLoading(null);
    }
  };

  const handlePlanChange = async () => {
    setActionLoading("plan");
    try {
      await superAdminClient.patch(`/platform-admin/tenants/${id}/plan`, { plan: selectedPlan });
      setStatusMsg(`Plan changed to ${selectedPlan}`);
      fetchTenant();
    } catch (err: unknown) {
      setStatusMsg((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Failed");
    } finally {
      setActionLoading(null);
    }
  };

  const handleImpersonate = async () => {
    if (!tenant) return;
    setActionLoading("impersonate");
    try {
      const res = await superAdminClient.post(`/platform-admin/tenants/${id}/impersonate`);
      localStorage.setItem("impersonationToken", res.data.accessToken);
      localStorage.setItem("impersonationTenantSlug", tenant.slug);
      // Full page reload so AuthProvider re-initialises from localStorage
      // and picks up the new impersonation token (router.push is client-side
      // navigation and doesn't re-mount providers).
      window.location.href = "/dashboard";
    } catch (err: unknown) {
      setStatusMsg((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Impersonation failed");
    } finally {
      setActionLoading(null);
    }
  };

  const handleExtendTrial = async () => {
    setActionLoading("extend-trial");
    try {
      const res = await superAdminClient.post(`/platform-admin/tenants/${id}/extend-trial`, { days: trialDays });
      setStatusMsg(`Trial extended — new end: ${new Date(res.data.trialEndsAt).toLocaleString()}`);
      fetchTenant();
    } catch (err: unknown) {
      setStatusMsg((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Failed to extend trial");
    } finally {
      setActionLoading(null);
    }
  };

  const handleResetPassword = async () => {
    setActionLoading("reset-pwd");
    setShowResetConfirm(false);
    try {
      const res = await superAdminClient.post(`/platform-admin/tenants/${id}/reset-admin-password`);
      setResetResult(res.data);
      setCopied(false);
    } catch (err: unknown) {
      setStatusMsg((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Failed to reset password");
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async () => {
    setActionLoading("delete");
    try {
      await superAdminClient.delete(`/platform-admin/tenants/${id}`);
      router.push("/admin/tenants");
    } catch (err: unknown) {
      setStatusMsg((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Delete failed");
    } finally {
      setActionLoading(null);
      setShowDeleteConfirm(false);
    }
  };

  const copyToClipboard = () => {
    if (resetResult) {
      navigator.clipboard.writeText(resetResult.tempPassword).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  if (loading) {
    return <div className="p-6 text-center text-slate-500">Loading tenant…</div>;
  }

  if (error || !tenant) {
    return (
      <div className="p-6">
        <div className="rounded-lg bg-red-900/40 px-4 py-3 text-sm text-red-400 ring-1 ring-red-700">
          {error ?? "Tenant not found"}
        </div>
        <Link href="/admin/tenants" className="mt-4 inline-block text-sm text-indigo-400 hover:underline">
          ← Back to Tenants
        </Link>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex items-center gap-4">
        <Link href="/admin/tenants" className="text-sm text-slate-400 hover:text-slate-300">
          ← Tenants
        </Link>
        <h1 className="text-2xl font-bold text-white">{tenant.businessName ?? tenant.name}</h1>
        <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${STATUS_COLORS[tenant.status] ?? "bg-slate-700 text-slate-400"}`}>
          {tenant.status}
        </span>
      </div>

      {statusMsg && (
        <div className="mb-4 rounded-lg bg-indigo-900/40 px-4 py-2 text-sm text-indigo-300 ring-1 ring-indigo-700">
          {statusMsg}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Tenant Info */}
        <div className="rounded-xl bg-slate-800 p-5 ring-1 ring-white/5">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">Tenant Info</h2>
          <dl className="flex flex-col gap-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">ID</dt>
              <dd className="font-mono text-xs text-slate-300">{tenant.id}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Slug</dt>
              <dd className="font-mono text-slate-300">{tenant.slug}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Business Name</dt>
              <dd className="text-white">{tenant.businessName ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Plan</dt>
              <dd className="text-white">{tenant.plan}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Created</dt>
              <dd className="text-slate-300">{new Date(tenant.createdAt).toLocaleString()}</dd>
            </div>
            {tenant.trialEndsAt && (
              <div className="flex justify-between items-center">
                <dt className="text-slate-500">Trial Ends</dt>
                <TrialEndsBadge trialEndsAt={tenant.trialEndsAt} />
              </div>
            )}
          </dl>
        </div>

        {/* Usage Stats */}
        {tenant.counts && (
          <div className="rounded-xl bg-slate-800 p-5 ring-1 ring-white/5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">Usage</h2>
            <div className="grid grid-cols-3 gap-3">
              {[
                ["Users", tenant.counts.users],
                ["Customers", tenant.counts.customers],
                ["Orders", tenant.counts.orders],
                ["Drivers", tenant.counts.drivers],
                ["Routes", tenant.counts.routes],
              ].map(([label, count]) => (
                <div key={String(label)} className="rounded-lg bg-slate-700/50 p-3 text-center">
                  <p className="text-lg font-bold text-white">{count}</p>
                  <p className="text-xs text-slate-500">{label}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="rounded-xl bg-slate-800 p-5 ring-1 ring-white/5 lg:col-span-2">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">Actions</h2>
          <div className="flex flex-wrap gap-3">
            {/* Suspend / Reactivate */}
            {tenant.status !== "CANCELLED" && (
              <button
                disabled={actionLoading === "status"}
                onClick={handleStatusToggle}
                className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-50 ${
                  tenant.status === "SUSPENDED"
                    ? "bg-green-700 text-white hover:bg-green-600"
                    : "bg-yellow-700 text-white hover:bg-yellow-600"
                }`}
              >
                {tenant.status === "SUSPENDED" ? "Reactivate" : "Suspend"}
              </button>
            )}

            {/* Change Plan */}
            <div className="flex items-center gap-2">
              <select
                value={selectedPlan}
                onChange={(e) => setSelectedPlan(e.target.value)}
                className="h-9 rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
              >
                {PLANS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <button
                disabled={actionLoading === "plan" || selectedPlan === tenant.plan}
                onClick={handlePlanChange}
                className="rounded-lg bg-slate-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-500 disabled:opacity-50"
              >
                Change Plan
              </button>
            </div>

            {/* Impersonate */}
            {tenant.status !== "CANCELLED" && (
              <button
                disabled={actionLoading === "impersonate"}
                onClick={handleImpersonate}
                className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-600 disabled:opacity-50"
              >
                Impersonate
              </button>
            )}

            {/* Delete */}
            {!showDeleteConfirm ? (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="ml-auto rounded-lg bg-red-900/40 px-4 py-2 text-sm font-semibold text-red-400 ring-1 ring-red-700 transition-colors hover:bg-red-900/70"
              >
                Delete Tenant
              </button>
            ) : (
              <div className="ml-auto flex items-center gap-2 rounded-lg bg-red-900/40 px-4 py-2 ring-1 ring-red-700">
                <span className="text-sm text-red-300">Confirm delete?</span>
                <button
                  disabled={actionLoading === "delete"}
                  onClick={handleDelete}
                  className="rounded px-3 py-1 text-xs font-bold text-red-400 hover:bg-red-800"
                >
                  Yes, delete
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="rounded px-3 py-1 text-xs text-slate-400 hover:bg-slate-700"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {/* Extend Trial */}
          <div className="mt-5 border-t border-slate-700 pt-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Extend Trial</h3>
            <div className="flex items-center gap-3">
              <label className="text-sm text-slate-400">Days</label>
              <input
                type="number"
                min={1}
                max={365}
                value={trialDays}
                onChange={(e) => setTrialDays(Number(e.target.value))}
                className="h-9 w-20 rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
              />
              <button
                disabled={actionLoading === "extend-trial"}
                onClick={handleExtendTrial}
                className="rounded-lg bg-slate-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-500 disabled:opacity-50"
              >
                {actionLoading === "extend-trial" ? "Extending…" : "Extend Trial"}
              </button>
            </div>
          </div>

          {/* Reset Admin Password */}
          <div className="mt-4 border-t border-slate-700 pt-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Admin Password Reset</h3>
            {!showResetConfirm ? (
              <button
                disabled={actionLoading === "reset-pwd"}
                onClick={() => setShowResetConfirm(true)}
                className="rounded-lg bg-orange-700/60 px-4 py-2 text-sm font-semibold text-orange-300 ring-1 ring-orange-600/40 transition-colors hover:bg-orange-700 disabled:opacity-50"
              >
                {actionLoading === "reset-pwd" ? "Resetting…" : "Reset Admin Password"}
              </button>
            ) : (
              <div className="flex items-center gap-2 rounded-lg bg-orange-900/40 px-4 py-2 ring-1 ring-orange-700">
                <span className="text-sm text-orange-300">Force password reset?</span>
                <button
                  disabled={actionLoading === "reset-pwd"}
                  onClick={handleResetPassword}
                  className="rounded px-3 py-1 text-xs font-bold text-orange-400 hover:bg-orange-800"
                >
                  Yes, reset
                </button>
                <button
                  onClick={() => setShowResetConfirm(false)}
                  className="rounded px-3 py-1 text-xs text-slate-400 hover:bg-slate-700"
                >
                  Cancel
                </button>
              </div>
            )}

            {resetResult && (
              <div className="mt-3 rounded-lg bg-slate-700/60 p-4 ring-1 ring-slate-600">
                <p className="mb-2 text-sm text-slate-300">
                  Temporary password for <span className="font-mono text-white">{resetResult.username}</span>:
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded bg-slate-900 px-3 py-2 font-mono text-sm text-green-400">
                    {resetResult.tempPassword}
                  </code>
                  <button
                    onClick={copyToClipboard}
                    className="rounded px-3 py-2 text-xs font-medium text-slate-400 hover:bg-slate-600 hover:text-white"
                  >
                    {copied ? "Copied!" : "Copy"}
                  </button>
                </div>
                <p className="mt-2 text-xs text-yellow-500">
                  Share this securely — it won&apos;t be shown again. The user will be forced to change it on next login.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Audit Logs */}
        <div className="rounded-xl bg-slate-800 p-5 ring-1 ring-white/5 lg:col-span-2">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">Recent Audit Logs</h2>
          {auditLoading && <p className="text-sm text-slate-500">Loading logs…</p>}
          {!auditLoading && auditLogs !== null && (
            auditLogs.length === 0 ? (
              <p className="text-sm text-slate-500">No audit log entries for this tenant.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-500">
                      <th className="px-3 py-2 text-left">Action</th>
                      <th className="px-3 py-2 text-left">Entity Type</th>
                      <th className="px-3 py-2 text-left">User ID</th>
                      <th className="px-3 py-2 text-left">Timestamp</th>
                      <th className="px-3 py-2 text-left">IP</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700/50">
                    {auditLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-slate-700/20">
                        <td className="px-3 py-2 font-mono text-slate-300">{log.action}</td>
                        <td className="px-3 py-2 text-slate-400">{log.entityType}</td>
                        <td className="px-3 py-2 font-mono text-slate-500">{log.userId ?? "—"}</td>
                        <td className="px-3 py-2 text-slate-500">{new Date(log.createdAt).toLocaleString()}</td>
                        <td className="px-3 py-2 text-slate-500">{log.ip ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
