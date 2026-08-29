"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  DEVELOPER_MODE_ADDON,
  DRIVER_PAYMENTS_ADDON,
  RECURRING_ROUTES_ADDON,
  ORDER_DELIVERY_ADDON,
} from "@routeflow/types";
import { superAdminClient } from "@/lib/admin-api";
import { setTenantCookie } from "@/lib/tenant-cookie";
import { setImpersonation } from "@/lib/impersonation";
import { AdminTabs } from "../../../_components/AdminTabs";
import { AdminBadge, planLabel } from "../../../_components/AdminBadge";
import { AdminCard } from "../../../_components/AdminCard";
import { AdminModal } from "../../../_components/AdminModal";
import { TenantPricingCard } from "./_components/TenantPricingCard";
import { LayoutDashboard, CreditCard, Puzzle, Settings, ScrollText } from "lucide-react";

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);

// ─── Types ─────────────────────────────────────────────────────────────────────

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
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  phone: string | null;
  subscription: {
    currentPlan: string;
    periodStart: string | null;
    periodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    stripeCustomerId?: string | null;
    externalPayment: boolean;
    externalPaymentMethod: string | null;
    externalPaymentRef: string | null;
    externalPaymentNotes: string | null;
  } | null;
  counts: {
    users: number;
    customers: number;
    orders: number;
    drivers: number;
    routes: number;
    customerLinks: number;
  } | null;
  orders30d?: number;
  estMrrUsd?: number;
}

interface AuditActor {
  id: string;
  username: string;
  email: string;
  isPlatform: boolean;
}

interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  userId: string | null;
  ip: string | null;
  createdAt: string;
  // Enriched by the API (null for legacy interceptor rows / unresolvable ids).
  actionLabel?: string | null;
  actor?: AuditActor | null;
}

interface Addon {
  id: string;
  addonKey: string;
  active: boolean;
  stripePriceId: string | null;
  createdAt: string;
}

const PLANS = ["STARTER", "PROFESSIONAL", "ENTERPRISE"] as const;

const AVAILABLE_ADDONS = [
  {
    key: "tobacco_dealer",
    name: "Regulated compliance pack",
    description:
      "Regulated Items compliance pack — license-column ledgers, monthly tobacco reports, regulated filings & range reports, and the analytics-exclusion option inside the Regulated Items hub (legacy key: tobacco_dealer)",
  },
  {
    key: "msrp",
    name: "MSRP on invoices",
    description:
      "Suggested retail price (per piece) on products, customers, and invoice pricing — display-only. Nothing appears until MSRP values are entered, and only invoices created afterwards show them.",
  },
  {
    key: "sales_agents",
    name: "Sales agents & commissions",
    description:
      "Agent records, customer attribution, commission accrual on invoices, statements and payouts",
  },
  {
    key: DRIVER_PAYMENTS_ADDON,
    name: "Driver payments (at-door collection)",
    description:
      "Let drivers collect money at the door when completing a stop (cash, card, cheque, Zelle). " +
      "Server-enforced: while OFF, collection is blocked (403) and drivers complete stops on " +
      "account — deliveries, proof-of-delivery, and invoicing continue unchanged; the office " +
      "records payments instead. Turn ON only for tenants whose drivers handle money.",
  },
  {
    key: RECURRING_ROUTES_ADDON,
    name: "Recurring routes",
    description:
      "Standing route templates and scheduled dispatch — fixed customer rounds the tenant " +
      "re-runs (Dispatch → Routes). Independent of Order delivery; enable either or both.",
  },
  {
    key: ORDER_DELIVERY_ADDON,
    name: "Order delivery (ad-hoc trips)",
    description:
      "Plan one-shot delivery trips from selected orders: optimize the stop order, dispatch " +
      "to a driver, and keep the full delivery history. Trips are never reused. Independent " +
      "of Recurring routes; enable either or both.",
  },
  {
    key: DEVELOPER_MODE_ADDON,
    name: "Developer Mode",
    description:
      "Unlock in-development surfaces for this tenant — currently the mobile driver-app " +
      "preview (and dispatch API access for end-to-end testing). No longer unlocks Recurring " +
      "routes or Order delivery: enable those add-ons individually.",
  },
];

const TABS = [
  { key: "overview", label: "Overview", icon: <LayoutDashboard className="h-4 w-4" /> },
  { key: "billing", label: "Billing & Subscription", icon: <CreditCard className="h-4 w-4" /> },
  { key: "addons", label: "Addons & Features", icon: <Puzzle className="h-4 w-4" /> },
  { key: "config", label: "Configuration", icon: <Settings className="h-4 w-4" /> },
  { key: "audit", label: "Audit Log", icon: <ScrollText className="h-4 w-4" /> },
];

// ─── Helper ────────────────────────────────────────────────────────────────────

function TrialEndsBadge({ trialEndsAt }: { trialEndsAt: string }) {
  const end = new Date(trialEndsAt);
  const diffDays = Math.ceil((end.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  const color =
    diffDays > 7 ? "text-green-400" : diffDays >= 1 ? "text-yellow-400" : "text-red-400";
  return (
    <span className={color}>
      {end.toLocaleDateString()}{" "}
      <span className="text-xs">({diffDays > 0 ? `${diffDays}d left` : "expired"})</span>
    </span>
  );
}

// ─── Tenant Admin Section ──────────────────────────────────────────────────────

interface TenantAdminUser {
  id: string;
  username: string;
  email: string | null;
  status: string;
  createdAt: string;
  forcePasswordChange: boolean;
}

function TenantAdminSection({
  tenantId,
  onRefreshTenant,
}: {
  tenantId: string;
  onRefreshTenant: () => void;
}) {
  const [admin, setAdmin] = React.useState<TenantAdminUser | null | undefined>(undefined); // undefined = loading
  const [showCreateForm, setShowCreateForm] = React.useState(false);
  const [createForm, setCreateForm] = React.useState({ username: "", email: "" });
  const [creating, setCreating] = React.useState(false);
  const [createResult, setCreateResult] = React.useState<{
    tempPassword?: string;
    username?: string;
  } | null>(null);
  const [msg, setMsg] = React.useState<{ type: "success" | "error"; text: string } | null>(null);

  const fetchAdmin = React.useCallback(() => {
    superAdminClient
      .get(`/platform-admin/tenants/${tenantId}/admin`)
      .then((res) => setAdmin(res.data.admin))
      .catch(() => setAdmin(null));
  }, [tenantId]);

  React.useEffect(() => {
    fetchAdmin();
  }, [fetchAdmin]);

  async function handleCreateAdmin(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setMsg(null);
    try {
      const res = await superAdminClient.post(
        `/platform-admin/tenants/${tenantId}/admin`,
        createForm,
      );
      setCreateResult(res.data);
      setAdmin(res.data);
      setShowCreateForm(false);
      setCreateForm({ username: "", email: "" });
      onRefreshTenant();
    } catch (err: unknown) {
      setMsg({
        type: "error",
        text:
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Failed to create admin",
      });
    } finally {
      setCreating(false);
    }
  }

  if (admin === undefined) return null; // still loading

  return (
    <AdminCard title="Admin Account">
      {msg && (
        <div
          className={`mb-3 rounded-lg px-3 py-2 text-sm ${msg.type === "success" ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"}`}
        >
          {msg.text}
        </div>
      )}

      {createResult?.tempPassword && (
        <div className="mb-4 rounded-lg bg-slate-700/60 p-4 ring-1 ring-slate-600">
          <p className="mb-2 text-sm text-slate-300">
            Admin <span className="font-mono text-white">{createResult.username}</span> created.
            Temporary password:
          </p>
          <code className="block rounded bg-slate-900 px-3 py-2 font-mono text-sm text-green-400">
            {createResult.tempPassword}
          </code>
          <p className="mt-2 text-xs text-yellow-500">
            Share this securely. The user will be forced to change it on next login.
          </p>
        </div>
      )}

      {admin ? (
        <dl className="flex flex-col gap-2.5 text-sm">
          {[
            [
              "Username",
              <span key="u" className="font-mono text-slate-300">
                {admin.username}
              </span>,
            ],
            [
              "Email",
              <span key="e" className="text-white">
                {admin.email ?? "—"}
              </span>,
            ],
            [
              "Status",
              <span
                key="s"
                className={admin.status === "ACTIVE" ? "text-green-400" : "text-yellow-400"}
              >
                {admin.status}
              </span>,
            ],
            [
              "Force Password Change",
              <span
                key="fp"
                className={admin.forcePasswordChange ? "text-yellow-400" : "text-slate-400"}
              >
                {admin.forcePasswordChange ? "Yes" : "No"}
              </span>,
            ],
            [
              "Created",
              <span key="c" className="text-slate-400">
                {new Date(admin.createdAt).toLocaleDateString()}
              </span>,
            ],
          ].map(([label, value]) => (
            <div key={String(label)} className="flex justify-between items-center">
              <dt className="text-slate-500">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="rounded-lg border border-dashed border-red-700/40 bg-red-900/10 p-4 text-center">
          <p className="text-sm font-semibold text-red-400">No admin account found</p>
          <p className="mt-1 text-xs text-slate-500">
            This tenant cannot be impersonated until an admin account exists.
          </p>
          {!showCreateForm ? (
            <button
              onClick={() => setShowCreateForm(true)}
              className="mt-3 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-500"
            >
              Create Admin Account
            </button>
          ) : (
            <form onSubmit={handleCreateAdmin} className="mt-4 text-left space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">Username</label>
                <input
                  required
                  value={createForm.username}
                  onChange={(e) => setCreateForm((f) => ({ ...f, username: e.target.value }))}
                  placeholder="admin"
                  className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">Email</label>
                <input
                  required
                  type="email"
                  value={createForm.email}
                  onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="admin@company.com"
                  className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <p className="text-xs text-slate-500">
                A temporary password will be auto-generated and emailed to the admin.
              </p>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={creating}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {creating ? "Creating..." : "Create Admin"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-400 hover:bg-slate-700"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </AdminCard>
  );
}

// ─── Overview Tab ──────────────────────────────────────────────────────────────

function OverviewTab({
  tenant,
  onAction,
  actionLoading,
  statusMsg,
  onRefreshTenant,
}: {
  tenant: TenantDetail;
  onAction: (action: string, payload?: unknown) => Promise<void>;
  actionLoading: string | null;
  statusMsg: string | null;
  onRefreshTenant: () => void;
}) {
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const [showResetConfirm, setShowResetConfirm] = React.useState(false);
  const [resetResult, setResetResult] = React.useState<{
    username: string;
    tempPassword: string;
  } | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [trialDays, setTrialDays] = React.useState(14);
  const [selectedPlan, setSelectedPlan] = React.useState(tenant.plan);

  const [recentLogs, setRecentLogs] = React.useState<AuditLogEntry[]>([]);
  React.useEffect(() => {
    superAdminClient
      .get(`/platform-admin/audit-logs?tenantId=${tenant.id}&limit=5`)
      .then((res) => setRecentLogs(res.data.data))
      .catch(() => {});
  }, [tenant.id]);

  const sub = tenant.subscription;
  const paymentMethodLabel = sub?.externalPayment
    ? (sub.externalPaymentMethod ?? "External")
    : sub?.stripeCustomerId
      ? "Card (Stripe)"
      : null;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* At-a-glance KPIs */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:col-span-2">
        <div className="rounded-xl bg-slate-800 p-5 ring-1 ring-white/5">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Est. MRR</p>
          <p className="mt-2 text-2xl font-bold text-white">{usd(tenant.estMrrUsd ?? 0)}</p>
          <p className="mt-1 text-xs text-slate-500">{planLabel(tenant.plan)} · stopgap estimate</p>
        </div>
        <div className="rounded-xl bg-slate-800 p-5 ring-1 ring-white/5">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Orders, 30d</p>
          <p className="mt-2 text-2xl font-bold text-white">{tenant.orders30d ?? 0}</p>
          <p className="mt-1 text-xs text-slate-500">Placed in the last 30 days</p>
        </div>
        <div className="rounded-xl bg-slate-800 p-5 ring-1 ring-white/5">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Users</p>
          <p className="mt-2 text-2xl font-bold text-white">{tenant.counts?.users ?? 0}</p>
          <p className="mt-1 text-xs text-slate-500">Across this workspace</p>
        </div>
      </div>

      {/* Tenant Info */}
      <AdminCard title="Tenant Info">
        <dl className="flex flex-col gap-2.5 text-sm">
          {[
            [
              "ID",
              <span key="id" className="font-mono text-xs text-slate-300">
                {tenant.id}
              </span>,
            ],
            [
              "Slug",
              <span key="slug" className="font-mono text-slate-300">
                {tenant.slug}
              </span>,
            ],
            [
              "Business Name",
              <span key="bn" className="text-white">
                {tenant.businessName ?? "—"}
              </span>,
            ],
            [
              "Plan",
              <AdminBadge key="plan" variant="plan">
                {tenant.plan}
              </AdminBadge>,
            ],
            ["Status", <AdminBadge key="status">{tenant.status}</AdminBadge>],
            [
              "Created",
              <span key="created" className="text-slate-300">
                {new Date(tenant.createdAt).toLocaleString()}
              </span>,
            ],
          ].map(([label, value]) => (
            <div key={String(label)} className="flex justify-between items-center">
              <dt className="text-slate-500">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
          {tenant.trialEndsAt && (
            <div className="flex justify-between items-center">
              <dt className="text-slate-500">Trial Ends</dt>
              <dd>
                <TrialEndsBadge trialEndsAt={tenant.trialEndsAt} />
              </dd>
            </div>
          )}
          {tenant.primaryColor && (
            <div className="flex justify-between items-center">
              <dt className="text-slate-500">Brand color</dt>
              <dd className="flex items-center gap-2">
                <span
                  className="inline-block h-3.5 w-3.5 rounded ring-1 ring-white/10"
                  style={{ backgroundColor: tenant.primaryColor }}
                />
                <span className="font-mono text-xs text-slate-300">{tenant.primaryColor}</span>
              </dd>
            </div>
          )}
          {tenant.counts && (
            <div className="flex justify-between items-center">
              <dt className="text-slate-500">Linked buyers</dt>
              <dd className="font-mono text-slate-300">{tenant.counts.customerLinks}</dd>
            </div>
          )}
          {sub?.periodEnd && (
            <div className="flex justify-between items-center">
              <dt className="text-slate-500">Next renewal</dt>
              <dd className="text-slate-300">{new Date(sub.periodEnd).toLocaleDateString()}</dd>
            </div>
          )}
          {paymentMethodLabel && (
            <div className="flex justify-between items-center">
              <dt className="text-slate-500">Payment method</dt>
              <dd className="text-slate-300">{paymentMethodLabel}</dd>
            </div>
          )}
        </dl>
      </AdminCard>

      {/* Usage Stats */}
      {tenant.counts && (
        <AdminCard title="Usage Stats">
          <div className="grid grid-cols-3 gap-3">
            {(
              [
                ["Users", tenant.counts.users],
                ["Customers", tenant.counts.customers],
                ["Orders", tenant.counts.orders],
                ["Drivers", tenant.counts.drivers],
                ["Routes", tenant.counts.routes],
              ] as [string, number][]
            ).map(([label, count]) => (
              <div key={label} className="rounded-lg bg-slate-700/50 p-3 text-center">
                <p className="text-lg font-bold text-white">{count}</p>
                <p className="text-xs text-slate-500">{label}</p>
              </div>
            ))}
          </div>
        </AdminCard>
      )}

      {/* Admin Account */}
      <TenantAdminSection tenantId={tenant.id} onRefreshTenant={onRefreshTenant} />

      {/* Quick Actions */}
      <AdminCard title="Quick Actions" className="lg:col-span-2">
        {statusMsg && (
          <div className="mb-4 rounded-lg bg-indigo-900/40 px-4 py-2 text-sm text-indigo-300 ring-1 ring-indigo-700">
            {statusMsg}
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          {tenant.status !== "CANCELLED" && (
            <button
              disabled={actionLoading === "status"}
              onClick={() => onAction("toggle-status")}
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-50 ${
                tenant.status === "SUSPENDED"
                  ? "bg-green-700 text-white hover:bg-green-600"
                  : "bg-yellow-700 text-white hover:bg-yellow-600"
              }`}
            >
              {tenant.status === "SUSPENDED" ? "Reactivate" : "Suspend"}
            </button>
          )}

          <div className="flex items-center gap-2">
            <select
              value={selectedPlan}
              onChange={(e) => setSelectedPlan(e.target.value)}
              className="h-9 rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
            >
              {PLANS.map((p) => (
                <option key={p} value={p}>
                  {planLabel(p)}
                </option>
              ))}
            </select>
            <button
              disabled={actionLoading === "plan" || selectedPlan === tenant.plan}
              onClick={() => onAction("change-plan", { plan: selectedPlan })}
              className="rounded-lg bg-slate-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-500 disabled:opacity-50"
            >
              Change Plan
            </button>
          </div>

          {tenant.status !== "CANCELLED" && (
            <button
              disabled={actionLoading === "impersonate"}
              onClick={() => onAction("impersonate")}
              className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-600 disabled:opacity-50"
            >
              Impersonate
            </button>
          )}

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
                onClick={() => onAction("delete")}
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
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Extend Trial
          </h3>
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
              onClick={() => onAction("extend-trial", { days: trialDays })}
              className="rounded-lg bg-slate-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-500 disabled:opacity-50"
            >
              {actionLoading === "extend-trial" ? "Extending..." : "Extend Trial"}
            </button>
          </div>
        </div>

        {/* Reset Admin Password */}
        <div className="mt-4 border-t border-slate-700 pt-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Admin Password Reset
          </h3>
          {!showResetConfirm ? (
            <button
              disabled={actionLoading === "reset-pwd"}
              onClick={() => setShowResetConfirm(true)}
              className="rounded-lg bg-orange-700/60 px-4 py-2 text-sm font-semibold text-orange-300 ring-1 ring-orange-600/40 transition-colors hover:bg-orange-700 disabled:opacity-50"
            >
              Reset Admin Password
            </button>
          ) : (
            <div className="flex items-center gap-2 rounded-lg bg-orange-900/40 px-4 py-2 ring-1 ring-orange-700">
              <span className="text-sm text-orange-300">Force password reset?</span>
              <button
                disabled={actionLoading === "reset-pwd"}
                onClick={async () => {
                  setShowResetConfirm(false);
                  try {
                    const res = await superAdminClient.post(
                      `/platform-admin/tenants/${tenant.id}/reset-admin-password`,
                    );
                    setResetResult(res.data);
                    setCopied(false);
                  } catch {}
                }}
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
                Temporary password for{" "}
                <span className="font-mono text-white">{resetResult.username}</span>:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-slate-900 px-3 py-2 font-mono text-sm text-green-400">
                  {resetResult.tempPassword}
                </code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(resetResult.tempPassword).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    });
                  }}
                  className="rounded px-3 py-2 text-xs font-medium text-slate-400 hover:bg-slate-600 hover:text-white"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <p className="mt-2 text-xs text-yellow-500">
                Share this securely. The user will be forced to change it on next login.
              </p>
            </div>
          )}
        </div>
      </AdminCard>

      {/* Recent Audit Logs */}
      <AdminCard
        title="Recent Audit Logs"
        className="lg:col-span-2"
        actions={
          <Link
            href={`/admin/audit-logs?tenantId=${tenant.id}`}
            className="text-xs text-indigo-400 hover:text-indigo-300"
          >
            View all
          </Link>
        }
        noPadding
      >
        {recentLogs.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">No audit log entries for this tenant.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-2.5 text-left">Action</th>
                  <th className="px-4 py-2.5 text-left">Entity</th>
                  <th className="px-4 py-2.5 text-left">User</th>
                  <th className="px-4 py-2.5 text-left">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {recentLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-700/20">
                    <td className="px-4 py-2 text-slate-300" title={log.action}>
                      {log.actionLabel ?? log.action}
                    </td>
                    <td className="px-4 py-2 text-slate-400">{log.entityType}</td>
                    <td className="px-4 py-2 text-slate-400">
                      {log.actor ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span>{log.actor.email || log.actor.username}</span>
                          {log.actor.isPlatform && (
                            <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-medium text-indigo-300">
                              platform
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="font-mono text-slate-500">
                          {log.userId?.slice(0, 8) ?? "—"}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-slate-500">
                      {new Date(log.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>
    </div>
  );
}

// ─── Billing Tab ───────────────────────────────────────────────────────────────

const EXTERNAL_PAYMENT_METHODS = [
  { value: "ZELLE", label: "Zelle" },
  { value: "BANK_TRANSFER", label: "Bank Transfer (ACH/Wire)" },
  { value: "WIRE", label: "Wire Transfer" },
  { value: "CHECK", label: "Check" },
  { value: "CASH", label: "Cash" },
  { value: "OTHER", label: "Other" },
] as const;

const BILLING_PERIODS = [
  { value: 30, label: "Monthly (30 days)" },
  { value: 90, label: "Quarterly (90 days)" },
  { value: 180, label: "Semi-Annual (180 days)" },
  { value: 365, label: "Annual (365 days)" },
] as const;

function BillingTab({
  tenant,
  onRefreshTenant,
}: {
  tenant: TenantDetail;
  onRefreshTenant: () => void;
}) {
  const [portalLoading, setPortalLoading] = React.useState(false);
  const [msg, setMsg] = React.useState<{ type: "success" | "error" | "info"; text: string } | null>(
    null,
  );

  // Manual activation form state
  const [activating, setActivating] = React.useState(false);
  const [manualForm, setManualForm] = React.useState({
    plan: tenant.plan as string,
    paymentMethod: "ZELLE" as string,
    paymentRef: "",
    billingPeriodDays: 30,
    notes: "",
  });

  const sub = tenant.subscription;
  const daysLeft = tenant.trialEndsAt
    ? Math.ceil((new Date(tenant.trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null;

  const openBillingPortal = async () => {
    setPortalLoading(true);
    try {
      const res = await superAdminClient.post(
        `/platform-admin/tenants/${tenant.id}/billing/portal`,
      );
      window.open(res.data.url, "_blank");
    } catch (err: unknown) {
      setMsg({
        type: "error",
        text:
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Failed to open billing portal",
      });
    } finally {
      setPortalLoading(false);
    }
  };

  const handleManualActivation = async (e: React.FormEvent) => {
    e.preventDefault();
    setActivating(true);
    setMsg(null);
    try {
      const res = await superAdminClient.post(
        `/platform-admin/tenants/${tenant.id}/activate-subscription`,
        {
          plan: manualForm.plan,
          paymentMethod: manualForm.paymentMethod,
          paymentRef: manualForm.paymentRef || undefined,
          billingPeriodDays: manualForm.billingPeriodDays,
          notes: manualForm.notes || undefined,
        },
      );
      setMsg({
        type: "success",
        text: `Subscription activated — ${res.data.plan} plan, paid via ${manualForm.paymentMethod}. Next renewal: ${new Date(res.data.periodEnd).toLocaleDateString()}`,
      });
      onRefreshTenant();
    } catch (err: unknown) {
      setMsg({
        type: "error",
        text:
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Activation failed",
      });
    } finally {
      setActivating(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Current Plan */}
      <AdminCard title="Current Plan">
        <div className="flex items-center gap-4 mb-4">
          <AdminBadge variant="plan">{tenant.plan}</AdminBadge>
          <AdminBadge>{tenant.status}</AdminBadge>
        </div>
        {daysLeft !== null && (
          <p
            className={`text-sm ${daysLeft > 7 ? "text-green-400" : daysLeft > 0 ? "text-yellow-400" : "text-red-400"}`}
          >
            {daysLeft > 0 ? `${daysLeft} days remaining on trial` : "Trial expired"}
          </p>
        )}
      </AdminCard>

      {/* Subscription Details */}
      <AdminCard title="Subscription">
        {sub ? (
          <dl className="flex flex-col gap-2 text-sm">
            {sub.externalPayment && (
              <div className="mb-2 flex items-center gap-2 rounded-lg bg-emerald-900/30 px-3 py-2 ring-1 ring-emerald-700/50">
                <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                  External Payment
                </span>
                {sub.externalPaymentMethod && (
                  <span className="rounded bg-emerald-800/50 px-2 py-0.5 text-xs text-emerald-300">
                    {EXTERNAL_PAYMENT_METHODS.find((m) => m.value === sub.externalPaymentMethod)
                      ?.label ?? sub.externalPaymentMethod}
                  </span>
                )}
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-slate-500">Plan</dt>
              <dd className="text-white">{sub.currentPlan}</dd>
            </div>
            {sub.periodStart && (
              <div className="flex justify-between">
                <dt className="text-slate-500">Period Start</dt>
                <dd className="text-slate-300">{new Date(sub.periodStart).toLocaleDateString()}</dd>
              </div>
            )}
            {sub.periodEnd && (
              <div className="flex justify-between">
                <dt className="text-slate-500">Period End</dt>
                <dd className="text-slate-300">{new Date(sub.periodEnd).toLocaleDateString()}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-slate-500">Cancel Pending</dt>
              <dd className={sub.cancelAtPeriodEnd ? "text-red-400" : "text-green-400"}>
                {sub.cancelAtPeriodEnd ? "Yes" : "No"}
              </dd>
            </div>
            {sub.externalPaymentRef && (
              <div className="flex justify-between">
                <dt className="text-slate-500">Payment Ref</dt>
                <dd className="font-mono text-xs text-slate-300">{sub.externalPaymentRef}</dd>
              </div>
            )}
            {sub.externalPaymentNotes && (
              <div className="flex flex-col gap-1">
                <dt className="text-slate-500">Notes</dt>
                <dd className="rounded bg-slate-700/50 px-3 py-2 text-xs text-slate-300">
                  {sub.externalPaymentNotes}
                </dd>
              </div>
            )}
            {sub.stripeCustomerId && (
              <div className="flex justify-between">
                <dt className="text-slate-500">Stripe ID</dt>
                <dd className="font-mono text-xs text-slate-400">{sub.stripeCustomerId}</dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="text-sm text-slate-500">No subscription record yet.</p>
        )}
      </AdminCard>

      {/* Manual Activation */}
      <AdminCard title="Manual Activation" className="lg:col-span-2">
        <p className="mb-4 text-sm text-slate-400">
          Activate this tenant&apos;s subscription when payment was received outside Stripe — via
          Zelle, bank transfer, check, or any other platform.
        </p>

        {msg && (
          <div
            className={`mb-4 rounded-lg px-4 py-3 text-sm ring-1 break-all ${
              msg.type === "success"
                ? "bg-green-900/30 text-green-300 ring-green-700/50"
                : msg.type === "error"
                  ? "bg-red-900/30 text-red-300 ring-red-700/50"
                  : "bg-indigo-900/30 text-indigo-300 ring-indigo-700/50"
            }`}
          >
            {msg.text}
          </div>
        )}

        <form
          onSubmit={handleManualActivation}
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {/* Plan */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Plan</label>
            <select
              value={manualForm.plan}
              onChange={(e) => setManualForm((f) => ({ ...f, plan: e.target.value }))}
              className="h-9 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
            >
              {PLANS.map((p) => (
                <option key={p} value={p}>
                  {planLabel(p)}
                </option>
              ))}
            </select>
          </div>

          {/* Payment method */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Payment Method</label>
            <select
              value={manualForm.paymentMethod}
              onChange={(e) => setManualForm((f) => ({ ...f, paymentMethod: e.target.value }))}
              className="h-9 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
            >
              {EXTERNAL_PAYMENT_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          {/* Billing period */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Billing Period</label>
            <select
              value={manualForm.billingPeriodDays}
              onChange={(e) =>
                setManualForm((f) => ({ ...f, billingPeriodDays: Number(e.target.value) }))
              }
              className="h-9 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
            >
              {BILLING_PERIODS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {/* Reference */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">
              Transaction / Confirmation Reference{" "}
              <span className="text-slate-600">(optional)</span>
            </label>
            <input
              type="text"
              value={manualForm.paymentRef}
              onChange={(e) => setManualForm((f) => ({ ...f, paymentRef: e.target.value }))}
              placeholder="e.g. Zelle confirmation #123"
              className="h-9 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          {/* Notes */}
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs font-medium text-slate-400">
              Notes <span className="text-slate-600">(optional)</span>
            </label>
            <input
              type="text"
              value={manualForm.notes}
              onChange={(e) => setManualForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="Internal notes about this payment"
              className="h-9 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          {/* Submit */}
          <div className="sm:col-span-full flex items-center gap-4 border-t border-slate-700 pt-4">
            <button
              type="submit"
              disabled={activating}
              className="rounded-lg bg-emerald-700 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
            >
              {activating ? "Activating..." : "Activate Subscription"}
            </button>
            <p className="text-xs text-slate-500">
              This will set the tenant status to <strong className="text-slate-300">ACTIVE</strong>{" "}
              and record the selected payment method.
            </p>
          </div>
        </form>
      </AdminCard>

      {/* Stripe Actions — checkout now lives on the Pricing card below (interval-aware) */}
      <AdminCard title="Stripe Actions" className="lg:col-span-2">
        <div className="flex flex-wrap gap-3">
          <button
            disabled={portalLoading}
            onClick={openBillingPortal}
            className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-600 disabled:opacity-50"
          >
            {portalLoading ? "Opening..." : "Open Billing Portal"}
          </button>
        </div>
      </AdminCard>

      {/* Pricing — resolved catalog/custom price + the sole checkout entry point */}
      <TenantPricingCard tenantId={tenant.id} />
    </div>
  );
}

// ─── Addons Tab ────────────────────────────────────────────────────────────────

function AddonsTab({ tenant }: { tenant: TenantDetail }) {
  const [addons, setAddons] = React.useState<Addon[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [toggling, setToggling] = React.useState<string | null>(null);
  const [showEnableModal, setShowEnableModal] = React.useState<string | null>(null);

  const fetchAddons = React.useCallback(() => {
    setLoading(true);
    superAdminClient
      .get(`/platform-admin/tenants/${tenant.id}/addons`)
      .then((res) => setAddons(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [tenant.id]);

  React.useEffect(() => {
    fetchAddons();
  }, [fetchAddons]);

  const [toggleError, setToggleError] = React.useState<string | null>(null);

  const toggleAddon = async (key: string, currentlyActive: boolean) => {
    setToggling(key);
    setToggleError(null);
    try {
      if (currentlyActive) {
        await superAdminClient.post(`/platform-admin/tenants/${tenant.id}/addons/disable`, {
          addonKey: key,
        });
      } else {
        await superAdminClient.post(`/platform-admin/tenants/${tenant.id}/addons/enable`, {
          addonKey: key,
        });
      }
      fetchAddons();
    } catch (e: unknown) {
      // A silently-failed toggle looks like success (the switch just doesn't
      // move) — surface the server's reason instead. Addon enables can
      // legitimately fail, e.g. a bridged key whose SKU isn't in the published
      // catalog (#433's validation).
      const err = e as { response?: { data?: { message?: string } } };
      setToggleError(
        err?.response?.data?.message ??
          `Could not ${currentlyActive ? "disable" : "enable"} that add-on. Try again.`,
      );
    }
    setToggling(null);
    setShowEnableModal(null);
  };

  const activeKeys = new Set(addons.filter((a) => a.active).map((a) => a.addonKey));

  return (
    <>
      <AdminModal
        open={!!showEnableModal}
        onClose={() => setShowEnableModal(null)}
        title={`Enable ${AVAILABLE_ADDONS.find((a) => a.key === showEnableModal)?.name ?? showEnableModal}`}
        footer={
          <>
            <button
              onClick={() => setShowEnableModal(null)}
              className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              disabled={toggling === showEnableModal}
              onClick={() => showEnableModal && toggleAddon(showEnableModal, false)}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {toggling === showEnableModal ? "Enabling..." : "Enable Addon"}
            </button>
          </>
        }
      >
        <p className="text-sm text-slate-300">
          This will enable{" "}
          <strong>{AVAILABLE_ADDONS.find((a) => a.key === showEnableModal)?.name}</strong> for
          tenant <strong>{tenant.businessName ?? tenant.slug}</strong>.
        </p>
        <p className="mt-2 text-xs text-slate-500">
          If Stripe is configured, a subscription item will be created for billing.
        </p>
      </AdminModal>

      {loading ? (
        <div className="py-8 text-center text-slate-500">Loading addons...</div>
      ) : (
        <>
          {toggleError && (
            <div className="mb-4 rounded-lg bg-red-900/30 px-4 py-3 text-sm text-red-300 ring-1 ring-red-600/30">
              {toggleError}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {AVAILABLE_ADDONS.map((addon) => {
              const isActive = activeKeys.has(addon.key);
              return (
                <div
                  key={addon.key}
                  className={`rounded-xl p-4 ring-1 transition-colors ${
                    isActive ? "bg-indigo-900/20 ring-indigo-600/30" : "bg-slate-800 ring-white/5"
                  }`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="text-sm font-semibold text-white">{addon.name}</h3>
                    <button
                      disabled={toggling === addon.key}
                      onClick={() => {
                        if (isActive) {
                          toggleAddon(addon.key, true);
                        } else {
                          setShowEnableModal(addon.key);
                        }
                      }}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
                        isActive ? "bg-indigo-600" : "bg-slate-600"
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                          isActive ? "translate-x-4" : "translate-x-0.5"
                        }`}
                      />
                    </button>
                  </div>
                  <p className="text-xs text-slate-400">{addon.description}</p>
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

// ─── Configuration Tab ─────────────────────────────────────────────────────────

function ConfigTab({ tenant }: { tenant: TenantDetail }) {
  const [form, setForm] = React.useState({
    addressLine1: tenant.addressLine1 ?? "",
    city: tenant.city ?? "",
    state: tenant.state ?? "",
    zip: tenant.zip ?? "",
    country: tenant.country ?? "",
    phone: tenant.phone ?? "",
  });
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await superAdminClient.patch(`/platform-admin/tenants/${tenant.id}/config`, form);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setError("Failed to save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const readOnlyFields: [string, string | null][] = [
    ["Business Name", tenant.businessName],
    ["Primary Color", tenant.primaryColor],
    ["Logo Key", tenant.logoKey],
  ];

  const addressFields = [
    { key: "addressLine1", label: "Street" },
    { key: "city", label: "City" },
    { key: "state", label: "State / Province" },
    { key: "zip", label: "ZIP / Postcode" },
    { key: "country", label: "Country" },
    { key: "phone", label: "Phone" },
  ] as const;

  return (
    <AdminCard title="Tenant Configuration">
      {/* Read-only branding info */}
      <dl className="mb-6 flex flex-col gap-3 text-sm">
        {readOnlyFields.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between">
            <dt className="text-slate-500">{label}</dt>
            <dd className="text-white">
              {label === "Primary Color" && value ? (
                <span className="flex items-center gap-2">
                  <span
                    className="inline-block h-4 w-4 rounded-full ring-1 ring-white/20"
                    style={{ backgroundColor: value }}
                  />
                  {value}
                </span>
              ) : (
                (value ?? <span className="text-slate-600">Not set</span>)
              )}
            </dd>
          </div>
        ))}
      </dl>

      <hr className="mb-5 border-slate-700" />

      {/* Editable address / contact form */}
      <form onSubmit={handleSave} className="flex flex-col gap-4">
        <h3 className="text-sm font-semibold text-slate-300">Business Address &amp; Contact</h3>
        {addressFields.map(({ key, label }) => (
          <div key={key} className="flex flex-col gap-1">
            <label className="text-xs text-slate-400">{label}</label>
            <input
              className="rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              value={form[key]}
              onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
            />
          </div>
        ))}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={saving}
          className="self-end rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? "Saving…" : saved ? "Saved ✓" : "Save Changes"}
        </button>
      </form>
    </AdminCard>
  );
}

// ─── Audit Log Tab ─────────────────────────────────────────────────────────────

function AuditLogTab({ tenantId }: { tenantId: string }) {
  const [logs, setLogs] = React.useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [page, setPage] = React.useState(1);
  const [meta, setMeta] = React.useState({ total: 0, pages: 1 });

  React.useEffect(() => {
    setLoading(true);
    superAdminClient
      .get(`/platform-admin/audit-logs?tenantId=${tenantId}&page=${page}&limit=20`)
      .then((res) => {
        setLogs(res.data.data);
        setMeta(res.data.meta);
      })
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));
  }, [tenantId, page]);

  if (loading) return <div className="py-8 text-center text-slate-500">Loading audit logs...</div>;

  return (
    <div>
      <div className="rounded-xl bg-slate-800 ring-1 ring-white/5 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3 text-left">Action</th>
                <th className="px-4 py-3 text-left">Entity Type</th>
                <th className="px-4 py-3 text-left">Entity ID</th>
                <th className="px-4 py-3 text-left">User</th>
                <th className="px-4 py-3 text-left">Timestamp</th>
                <th className="px-4 py-3 text-left">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-slate-700/20">
                  <td className="px-4 py-2 text-slate-300" title={log.action}>
                    {log.actionLabel ?? log.action}
                  </td>
                  <td className="px-4 py-2 text-slate-400">{log.entityType}</td>
                  <td className="px-4 py-2 font-mono text-slate-500">
                    {log.entityId?.slice(0, 8) ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-slate-400">
                    {log.actor ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span>{log.actor.email || log.actor.username}</span>
                        {log.actor.isPlatform && (
                          <span className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-medium text-indigo-300">
                            platform
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="font-mono text-slate-500">
                        {log.userId?.slice(0, 8) ?? "—"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-slate-500">
                    {new Date(log.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-slate-500">{log.ip ?? "—"}</td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                    No audit log entries.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {meta.pages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-2">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800 disabled:opacity-40"
          >
            Prev
          </button>
          <span className="text-sm text-slate-500">
            Page {page} of {meta.pages}
          </span>
          <button
            disabled={page >= meta.pages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function AdminTenantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [tenant, setTenant] = React.useState<TenantDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [actionLoading, setActionLoading] = React.useState<string | null>(null);
  const [statusMsg, setStatusMsg] = React.useState<string | null>(null);
  const [activeTab, setActiveTab] = React.useState("overview");

  const fetchTenant = React.useCallback(() => {
    setLoading(true);
    superAdminClient
      .get<TenantDetail>(`/platform-admin/tenants/${id}`)
      .then((res) => setTenant(res.data))
      .catch((err) => setError(err?.response?.data?.message ?? "Failed to load tenant"))
      .finally(() => setLoading(false));
  }, [id]);

  React.useEffect(() => {
    fetchTenant();
  }, [fetchTenant]);

  const handleAction = async (action: string, payload?: unknown) => {
    if (!tenant) return;
    setActionLoading(action);
    setStatusMsg(null);
    try {
      switch (action) {
        case "toggle-status": {
          const newStatus = tenant.status === "SUSPENDED" ? "ACTIVE" : "SUSPENDED";
          await superAdminClient.patch(`/platform-admin/tenants/${id}/status`, {
            status: newStatus,
          });
          setStatusMsg(`Status changed to ${newStatus}`);
          break;
        }
        case "change-plan": {
          const { plan } = payload as { plan: string };
          await superAdminClient.patch(`/platform-admin/tenants/${id}/plan`, { plan });
          setStatusMsg(`Plan changed to ${plan}`);
          break;
        }
        case "impersonate": {
          try {
            const res = await superAdminClient.post(`/platform-admin/tenants/${id}/impersonate`);
            // Impersonation state lives ONLY in lib/impersonation.ts. The old
            // legacy "accessToken" write here leaked the impersonation token to
            // legacy-key readers (e.g. the settings Google-link fetch) — the exact
            // contamination that hijacked fresh logins. Cost of removal: realtime
            // sockets (which read OP_KEYS directly) stay silent during impersonation.
            setImpersonation(res.data.accessToken, tenant.slug);
            setTenantCookie(tenant.slug);
            window.location.href = "/dashboard";
          } catch (impErr: unknown) {
            const msg =
              (impErr as { response?: { data?: { message?: string } } })?.response?.data?.message ??
              "";
            if (msg.toLowerCase().includes("tenant_admin")) {
              setStatusMsg(
                "⚠️ No admin account found for this tenant. Please create one using the Admin Account section below, then try again.",
              );
            } else {
              setStatusMsg(msg || "Impersonation failed");
            }
          }
          return;
        }
        case "extend-trial": {
          const { days } = payload as { days: number };
          const res = await superAdminClient.post(`/platform-admin/tenants/${id}/extend-trial`, {
            days,
          });
          setStatusMsg(
            `Trial extended — new end: ${new Date(res.data.trialEndsAt).toLocaleString()}`,
          );
          break;
        }
        case "delete": {
          await superAdminClient.delete(`/platform-admin/tenants/${id}`);
          router.push("/admin/tenants");
          return;
        }
      }
      fetchTenant();
    } catch (err: unknown) {
      setStatusMsg(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Action failed",
      );
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) return <div className="p-6 text-center text-slate-500">Loading tenant...</div>;

  if (error || !tenant) {
    return (
      <div className="p-6">
        <div className="rounded-lg bg-red-900/40 px-4 py-3 text-sm text-red-400 ring-1 ring-red-700">
          {error ?? "Tenant not found"}
        </div>
        <Link
          href="/admin/tenants"
          className="mt-4 inline-block text-sm text-indigo-400 hover:underline"
        >
          Back to Tenants
        </Link>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-1 flex items-center gap-4">
        <Link href="/admin/tenants" className="text-sm text-slate-400 hover:text-slate-300">
          Tenants
        </Link>
        <span className="text-slate-600">/</span>
        <h1 className="text-xl font-bold text-white">{tenant.businessName ?? tenant.name}</h1>
        <AdminBadge>{tenant.status}</AdminBadge>
        <AdminBadge variant="plan">{tenant.plan}</AdminBadge>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        <span className="font-mono">{tenant.slug}</span>.routeflow.info · created{" "}
        {new Date(tenant.createdAt).toLocaleDateString()}
        {tenant.counts ? ` · ${tenant.counts.users} users` : ""}
      </p>

      {/* Tabs */}
      <AdminTabs tabs={TABS} active={activeTab} onChange={setActiveTab} />

      {/* Tab Content */}
      {activeTab === "overview" && (
        <OverviewTab
          tenant={tenant}
          onAction={handleAction}
          actionLoading={actionLoading}
          statusMsg={statusMsg}
          onRefreshTenant={fetchTenant}
        />
      )}
      {activeTab === "billing" && <BillingTab tenant={tenant} onRefreshTenant={fetchTenant} />}
      {activeTab === "addons" && <AddonsTab tenant={tenant} />}
      {activeTab === "config" && <ConfigTab tenant={tenant} />}
      {activeTab === "audit" && <AuditLogTab tenantId={tenant.id} />}
    </div>
  );
}
