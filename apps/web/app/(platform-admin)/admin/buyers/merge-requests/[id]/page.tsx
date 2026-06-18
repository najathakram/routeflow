"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { superAdminClient } from "@/lib/admin-api";
import {
  ArrowLeft,
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  GitMerge,
  Link2,
  Link2Off,
  User,
  Unlink,
} from "lucide-react";

interface BuyerInfo {
  id: string;
  email: string;
  name: string | null;
  status: string;
  googleId: string | null;
  customerLinks: Array<{
    id: string;
    status: string;
    tenant: { id: string; name: string; slug: string };
    customer: { id: string; businessName: string };
  }>;
}

interface Preview {
  linksToTransfer: BuyerInfo["customerLinks"];
  conflictingLinks: BuyerInfo["customerLinks"];
  googleIdTransfer: boolean;
  googleIdConflict: boolean;
}

interface MergeRequestDetail {
  id: string;
  status: string;
  initiatedBy: string;
  initiatorNotes: string | null;
  adminNotes: string | null;
  verifiedAt: string | null;
  completedAt: string | null;
  rejectedAt: string | null;
  createdAt: string;
  primaryAccount: BuyerInfo;
  secondaryAccount: BuyerInfo;
  initiatingTenant: { id: string; name: string; slug: string } | null;
  preview: Preview;
}

const STATUS_COLORS: Record<string, string> = {
  PENDING_VERIFICATION: "bg-yellow-900/30 text-yellow-400 ring-yellow-700/40",
  PENDING_REVIEW: "bg-blue-900/30 text-blue-400 ring-blue-700/40",
  COMPLETED: "bg-green-900/30 text-green-400 ring-green-700/40",
  REJECTED: "bg-red-900/30 text-red-400 ring-red-700/40",
};

function AccountCard({ account, label }: { account: BuyerInfo; label: string }) {
  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-800/40 p-5">
      <div className="mb-3 flex items-center gap-2">
        <User className="h-4 w-4 text-slate-400" />
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          {label}
        </span>
      </div>
      <p className="text-base font-semibold text-white">{account.name ?? account.email}</p>
      <p className="text-sm text-slate-400">{account.email}</p>
      <p className="mt-1 text-xs text-slate-500">Status: {account.status}</p>
      {account.googleId && <p className="mt-1 text-xs text-slate-500">Has Google account linked</p>}
      <div className="mt-3">
        <p className="mb-1 text-xs font-medium text-slate-500">
          Seller connections ({account.customerLinks.length})
        </p>
        {account.customerLinks.length === 0 ? (
          <p className="text-xs text-slate-600">None</p>
        ) : (
          <ul className="space-y-1">
            {account.customerLinks.map((l) => (
              <li key={l.id} className="flex items-center gap-2 text-xs">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${l.status === "ACTIVE" ? "bg-green-400" : "bg-slate-500"}`}
                />
                <span className="text-slate-300">{l.tenant.name}</span>
                <span className="text-slate-500">({l.customer.businessName})</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function MergeRequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [req, setReq] = React.useState<MergeRequestDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [actionLoading, setActionLoading] = React.useState<"execute" | "reject" | null>(null);
  const [adminNotes, setAdminNotes] = React.useState("");
  const [confirmExecute, setConfirmExecute] = React.useState(false);
  const [resultMsg, setResultMsg] = React.useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const fetchDetail = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await superAdminClient.get(`/platform-admin/buyer-merge-requests/${id}`);
      setReq(res.data);
      setAdminNotes(res.data.adminNotes ?? "");
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  async function handleExecute() {
    setActionLoading("execute");
    setResultMsg(null);
    try {
      await superAdminClient.post(`/platform-admin/buyer-merge-requests/${id}/execute`);
      setResultMsg({ type: "success", text: "Merge executed successfully." });
      fetchDetail();
    } catch (err: any) {
      setResultMsg({ type: "error", text: err?.response?.data?.message ?? "Execution failed." });
    } finally {
      setActionLoading(null);
      setConfirmExecute(false);
    }
  }

  async function handleReject() {
    setActionLoading("reject");
    setResultMsg(null);
    try {
      await superAdminClient.post(`/platform-admin/buyer-merge-requests/${id}/reject`, {
        adminNotes,
      });
      setResultMsg({ type: "success", text: "Merge request rejected." });
      fetchDetail();
    } catch (err: any) {
      setResultMsg({ type: "error", text: err?.response?.data?.message ?? "Rejection failed." });
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-indigo-400" />
      </div>
    );
  }

  if (!req) return <div className="p-8 text-slate-400">Merge request not found.</div>;

  const canAct = req.status === "PENDING_REVIEW";

  return (
    <div className="p-6 md:p-8">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <Link href="/admin/buyers/merge-requests" className="text-slate-400 hover:text-white">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <GitMerge className="h-5 w-5 text-indigo-400" />
        <h1 className="text-xl font-bold text-white">Merge Request Review</h1>
        <span
          className={`ml-2 rounded-full px-3 py-0.5 text-xs font-medium ring-1 ${STATUS_COLORS[req.status] ?? "bg-slate-700 text-slate-400 ring-slate-600"}`}
        >
          {req.status.replace(/_/g, " ")}
        </span>
      </div>

      {resultMsg && (
        <div
          className={`mb-4 flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium ${resultMsg.type === "success" ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"}`}
        >
          {resultMsg.type === "success" ? (
            <CheckCircle className="h-4 w-4" />
          ) : (
            <XCircle className="h-4 w-4" />
          )}
          {resultMsg.text}
        </div>
      )}

      {/* Meta */}
      <div className="mb-6 rounded-lg border border-slate-700/50 bg-slate-800/20 px-4 py-3 text-xs text-slate-400 flex flex-wrap gap-x-6 gap-y-1">
        <span>
          Initiated by: <strong className="text-slate-300">{req.initiatedBy}</strong>
          {req.initiatingTenant && ` (${req.initiatingTenant.name})`}
        </span>
        <span>
          Created:{" "}
          <strong className="text-slate-300">{new Date(req.createdAt).toLocaleString()}</strong>
        </span>
        {req.verifiedAt && (
          <span>
            Verified:{" "}
            <strong className="text-slate-300">{new Date(req.verifiedAt).toLocaleString()}</strong>
          </span>
        )}
        {req.completedAt && (
          <span>
            Completed:{" "}
            <strong className="text-slate-300">{new Date(req.completedAt).toLocaleString()}</strong>
          </span>
        )}
        {req.rejectedAt && (
          <span>
            Rejected:{" "}
            <strong className="text-slate-300">{new Date(req.rejectedAt).toLocaleString()}</strong>
          </span>
        )}
      </div>

      {req.initiatorNotes && (
        <div className="mb-4 rounded-lg bg-slate-700/40 px-4 py-3 text-sm text-slate-300">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Initiator notes:{" "}
          </span>
          {req.initiatorNotes}
        </div>
      )}

      {/* Side-by-side accounts */}
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <AccountCard account={req.primaryAccount} label="Primary (kept)" />
        <AccountCard account={req.secondaryAccount} label="Secondary (absorbed)" />
      </div>

      {/* Preview */}
      <div className="mb-6 rounded-xl border border-slate-700/50 bg-slate-800/40 p-5">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">
          Merge Preview
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Link2 className="h-4 w-4 text-green-400" />
              <span className="text-xs font-medium text-green-400">
                Links to transfer ({req.preview.linksToTransfer.length})
              </span>
            </div>
            {req.preview.linksToTransfer.length === 0 ? (
              <p className="text-xs text-slate-500">None</p>
            ) : (
              <ul className="space-y-1">
                {req.preview.linksToTransfer.map((l) => (
                  <li key={l.id} className="text-xs text-slate-300">
                    {l.tenant.name} — {l.customer.businessName}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Unlink className="h-4 w-4 text-yellow-400" />
              <span className="text-xs font-medium text-yellow-400">
                Conflicting links — will disconnect ({req.preview.conflictingLinks.length})
              </span>
            </div>
            {req.preview.conflictingLinks.length === 0 ? (
              <p className="text-xs text-slate-500">None</p>
            ) : (
              <ul className="space-y-1">
                {req.preview.conflictingLinks.map((l) => (
                  <li key={l.id} className="text-xs text-slate-300">
                    {l.tenant.name} — {l.customer.businessName}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {req.preview.googleIdConflict && (
          <div className="mt-4 flex items-start gap-2 rounded-lg bg-yellow-900/20 px-3 py-2 text-yellow-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <p className="text-xs">
              Both accounts have a Google ID linked. The secondary&apos;s Google ID will be
              disconnected after merge.
            </p>
          </div>
        )}
        {req.preview.googleIdTransfer && (
          <div className="mt-4 flex items-start gap-2 rounded-lg bg-blue-900/20 px-3 py-2 text-blue-400">
            <CheckCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <p className="text-xs">
              The secondary account&apos;s Google ID will be transferred to the primary account.
            </p>
          </div>
        )}
      </div>

      {/* Admin notes + actions */}
      <div className="rounded-xl border border-slate-700/50 bg-slate-800/40 p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">
          Admin Notes
        </h2>
        <textarea
          value={adminNotes}
          onChange={(e) => setAdminNotes(e.target.value)}
          rows={2}
          disabled={!canAct}
          placeholder="Internal notes (optional)..."
          className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
        />

        {canAct && (
          <div className="mt-4 flex flex-wrap gap-3">
            {!confirmExecute ? (
              <button
                onClick={() => setConfirmExecute(true)}
                className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-500"
              >
                Execute Merge
              </button>
            ) : (
              <div className="flex items-center gap-2 rounded-lg bg-indigo-900/40 px-4 py-2 ring-1 ring-indigo-700">
                <span className="text-sm text-indigo-300">
                  Confirm merge? This cannot be undone.
                </span>
                <button
                  disabled={actionLoading === "execute"}
                  onClick={handleExecute}
                  className="flex items-center gap-1 rounded px-3 py-1 text-xs font-bold text-indigo-300 hover:bg-indigo-800 disabled:opacity-50"
                >
                  {actionLoading === "execute" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : null}
                  Yes, merge
                </button>
                <button
                  onClick={() => setConfirmExecute(false)}
                  className="rounded px-3 py-1 text-xs text-slate-400 hover:bg-slate-700"
                >
                  Cancel
                </button>
              </div>
            )}
            <button
              disabled={actionLoading === "reject"}
              onClick={handleReject}
              className="rounded-lg bg-red-900/40 px-5 py-2.5 text-sm font-semibold text-red-400 ring-1 ring-red-700 transition-colors hover:bg-red-900/70 disabled:opacity-50"
            >
              {actionLoading === "reject" ? (
                <Loader2 className="h-4 w-4 animate-spin inline" />
              ) : null}{" "}
              Reject
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
