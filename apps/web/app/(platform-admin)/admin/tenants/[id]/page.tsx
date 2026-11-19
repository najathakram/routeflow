"use client";

import * as React from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  BILLING_PERIODS,
  EXTERNAL_PAYMENT_METHODS,
  type ManualActivationAddons,
  type ManualActivationResult,
} from "@routeflow/types";
import { superAdminClient } from "@/lib/admin-api";
import { activationErrorText } from "@/lib/activation-error-copy";
import { setTenantCookie } from "@/lib/tenant-cookie";
import { setImpersonation } from "@/lib/impersonation";
import { AdminTabs } from "../../../_components/AdminTabs";
import { AdminBadge, planLabel, statusLabel } from "../../../_components/AdminBadge";
import { usePlanOptions, withCurrentPlan } from "../../../_components/usePlanOptions";
import { AdminCard } from "../../../_components/AdminCard";
import { PlanMoveReasonDialog } from "../../../_components/PlanMoveReason";
import { ActivationAddonChecklist } from "../../../_components/ActivationAddonChecklist";
import { DisabledHint } from "../../../_components/DisabledHint";
import {
  DeleteTenantDialog,
  ExtendTrialDialog,
  ImpersonateDialog,
  SuspendDialog,
  TENANT_ACTION_COPY,
  deleteFailureCopy,
  extendFailureCopy,
  statusFailureCopy,
  longDate,
  tenantLabel,
} from "../../../_components/TenantActionDialogs";
import { TenantPricingCard } from "./_components/TenantPricingCard";
import { ReadinessCard, type AdminReadState } from "./_components/ReadinessCard";
import { useFocusTarget } from "./_features/useFocusTarget";
import { LayoutDashboard, CreditCard, Puzzle, Building2, History } from "lucide-react";
import { FeatureConsole } from "./_features/FeatureConsole";
import {
  FeatureOverridesSection,
  type FeatureOverridesSectionHandle,
} from "./_features/FeatureOverridesSection";
import { SetupSection } from "./_features/SetupSection";
import { ConfigSnapshotsTab } from "./_features/ConfigSnapshotsTab";
import { FeatureChangeHistory } from "./_features/FeatureChangeHistory";
import { TierChangeControl } from "./_features/TierChangeControl";
import { adminCreatedNote } from "@/lib/platform-admin/admin-created-note";
import { tenantDisplayName } from "@/lib/tenant-display-name";

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
  // SA-140/B556: display-resolved — falls back to `plan` only when no subscription.planKey is
  // set (a drifted tenant). `plan` itself is unchanged.
  planKey: string;
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
    /** SA-3: absent on an older API; the Readiness card then says "Not checked". */
    products?: number;
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

// The owner's five tabs (keep-move-remove list, row 30). The URL key of "Plan & billing" stays `billing`.
const TABS = [
  { key: "overview", label: "Overview", icon: <LayoutDashboard className="h-4 w-4" /> },
  { key: "features", label: "Features", icon: <Puzzle className="h-4 w-4" /> },
  { key: "billing", label: "Plan & billing", icon: <CreditCard className="h-4 w-4" /> },
  { key: "details", label: "Business details", icon: <Building2 className="h-4 w-4" /> },
  { key: "history", label: "History", icon: <History className="h-4 w-4" /> },
];

/** R26: the old tab keys, and the one new tab each opens. */
const LEGACY_TAB_KEYS: Record<string, string> = {
  setup: "features",
  addons: "features",
  config: "details",
  snapshots: "history",
  audit: "history",
};

/**
 * The tab named by `?tab=`: a new key, an old key (mapped by LEGACY_TAB_KEYS), or Overview. The old
 * `?focus=admin-account` link carried no tab (it opened Overview, where the card used to be): it opens Business details.
 */
function resolveTab(param: string | null | undefined, focus?: string | null): string {
  if (focus === "admin-account" && (!param || param === "overview")) return "details";
  const key = param ? (LEGACY_TAB_KEYS[param] ?? param) : param;
  return TABS.some((t) => t.key === key) ? (key as string) : "overview";
}

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
  admin,
  onRefreshTenant,
  onAdminChange,
}: {
  tenantId: string;
  /** The page's one Admin Account read: undefined while loading, null when there is no admin. */
  admin: TenantAdminUser | null | undefined;
  onRefreshTenant: () => void;
  /** A create reports the new admin to the page, which feeds the Sign-in dialog and the readiness card. */
  onAdminChange: (admin: TenantAdminUser | null, state: AdminReadState) => void;
}) {
  const [showCreateForm, setShowCreateForm] = React.useState(false);
  const [createForm, setCreateForm] = React.useState({ username: "", email: "" });
  const [creating, setCreating] = React.useState(false);
  const [createResult, setCreateResult] = React.useState<{
    tempPassword?: string;
    username?: string;
    emailSent?: boolean;
  } | null>(null);
  const [msg, setMsg] = React.useState<{ type: "success" | "error"; text: string } | null>(null);

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
      onAdminChange(res.data, "loaded");
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
          <p className="mt-2 text-xs text-yellow-500">{adminCreatedNote(createResult.emailSent)}</p>
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
                {statusLabel(admin.status)}
              </span>,
            ],
            [
              "Force password change",
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
              <dt className="text-slate-400">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="rounded-lg border border-dashed border-red-700/40 bg-red-900/10 p-4 text-center">
          <p className="text-sm font-semibold text-red-400">No admin account found</p>
          <p className="mt-1 text-xs text-slate-400">
            This tenant cannot be impersonated until an admin account exists.
          </p>
          {!showCreateForm ? (
            <button
              onClick={() => setShowCreateForm(true)}
              className="mt-3 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-500"
            >
              Create admin account
            </button>
          ) : (
            <form onSubmit={handleCreateAdmin} className="mt-4 text-left space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">Username</label>
                <input
                  aria-label="Username"
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
                  aria-label="Email"
                  required
                  type="email"
                  value={createForm.email}
                  onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="admin@company.com"
                  className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <p className="text-xs text-slate-400">
                A temporary password will be generated and shown here once. We also try to email it
                to the admin.
              </p>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={creating}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {creating ? "Creating…" : "Create admin"}
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
// A one-glance health check (list rows 2-5, 15): ready to take a sale, the numbers in one row, the basic facts,
// the last few changes. Everything that acts or edits lives on another tab.

function OverviewTab({
  tenant,
  adminRead,
}: {
  tenant: TenantDetail;
  adminRead: { admin: TenantAdminUser | null; state: AdminReadState };
}) {
  const [recentLogs, setRecentLogs] = React.useState<AuditLogEntry[]>([]);
  React.useEffect(() => {
    superAdminClient
      .get(`/platform-admin/audit-logs?tenantId=${tenant.id}&limit=5`)
      .then((res) => setRecentLogs(res.data.data))
      .catch(() => {});
  }, [tenant.id]);

  // Row 3 and row 4 are one row now: the money and the orders, then the counts (Users once).
  const numbers: [string, string | number, string | null][] = [
    [
      "Est. MRR",
      usd(tenant.estMrrUsd ?? 0),
      `${planLabel(tenant.planKey ?? tenant.plan)} · stopgap estimate`,
    ],
    ["Orders, 30d", tenant.orders30d ?? 0, "Placed in the last 30 days"],
    ["Users", tenant.counts?.users ?? 0, "Across this workspace"],
    ...(tenant.counts
      ? ([
          ["Customers", tenant.counts.customers, null],
          ["Orders", tenant.counts.orders, "All time"],
          ["Drivers", tenant.counts.drivers, null],
          ["Routes", tenant.counts.routes, null],
        ] as [string, number, string | null][])
      : []),
  ];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <ReadinessCard tenant={tenant} admin={adminRead.admin} adminState={adminRead.state} />

      <div
        className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4 lg:col-span-2 xl:grid-cols-7"
        data-testid="overview-numbers"
      >
        {numbers.map(([label, value, note]) => (
          <div key={label} className="rounded-xl bg-slate-800 p-4 ring-1 ring-white/5">
            <p className="text-xs font-medium uppercase tracking-wider text-slate-400">{label}</p>
            <p className="mt-2 text-2xl font-bold text-white">{value}</p>
            {note && <p className="mt-1 text-xs text-slate-400">{note}</p>}
          </div>
        ))}
      </div>

      <AdminCard title="Business info" className="min-w-0 lg:col-span-2">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2.5 text-sm sm:grid-cols-2">
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
                {tenant.planKey ?? tenant.plan}
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
            <div key={String(label)} className="flex items-center justify-between">
              <dt className="text-slate-400">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
          {tenant.trialEndsAt && (
            <div className="flex items-center justify-between">
              <dt className="text-slate-400">Trial Ends</dt>
              <dd>
                <TrialEndsBadge trialEndsAt={tenant.trialEndsAt} />
              </dd>
            </div>
          )}
        </dl>
      </AdminCard>

      {/* Recent Audit Logs: a few rows here, the rest on History (row 15) */}
      <AdminCard
        title="Recent audit logs"
        className="min-w-0 lg:col-span-2"
        actions={
          <Link
            href={`/admin/tenants/${tenant.id}?tab=history`}
            className="admin-tap-text text-xs text-indigo-400 hover:text-indigo-300"
          >
            View all
          </Link>
        }
        noPadding
      >
        {recentLogs.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-400">No audit log entries for this tenant.</p>
        ) : (
          <div
            className="overflow-x-auto"
            role="region"
            aria-label="Recent audit log entries"
            tabIndex={0}
          >
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-400">
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
                        <span className="font-mono text-slate-400">
                          {log.userId?.slice(0, 8) ?? "—"}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-slate-400">
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

function BillingTab({
  tenant,
  onRefreshTenant,
  onAction,
  actionLoading,
  onAskExtendTrial,
  trialDays,
  onTrialDays,
}: {
  tenant: TenantDetail;
  onRefreshTenant: () => void;
  onAction: (action: string, payload?: unknown) => Promise<void>;
  actionLoading: string | null;
  /** Opens the page's Extend-trial confirm for `trialDays`. */
  onAskExtendTrial: () => void;
  trialDays: number;
  onTrialDays: (days: number) => void;
}) {
  const [portalLoading, setPortalLoading] = React.useState(false);
  // B857: the resolved planKey, never the raw legacy `plan` enum (TEAM/BUSINESS/…), which is not among the options.
  const currentPlan = tenant.planKey ?? tenant.plan;
  // An ACTIVE tenant is paying: the server refuses to move it to a trial (409), so the control is off too.
  const canExtendTrial = tenant.status !== "ACTIVE";
  // SA-788 (c): the tenant's add-ons as the last activation left them.
  const [activationAddons, setActivationAddons] = React.useState<ManualActivationAddons | null>(
    null,
  );
  const [msg, setMsg] = React.useState<{ type: "success" | "error" | "info"; text: string } | null>(
    null,
  );

  // Manual activation form state
  const [activating, setActivating] = React.useState(false);
  const planOptions = usePlanOptions();
  const [manualForm, setManualForm] = React.useState({
    plan: (tenant.planKey ?? tenant.plan) as string,
    paymentMethod: "ZELLE" as string,
    paymentRef: "",
    billingPeriodDays: 30,
    notes: "",
  });

  const sub = tenant.subscription;
  const paymentMethodLabel = sub?.externalPayment
    ? (sub.externalPaymentMethod &&
        EXTERNAL_PAYMENT_METHODS.find((m) => m.value === sub.externalPaymentMethod)?.label) ||
      sub.externalPaymentMethod ||
      "External"
    : sub?.stripeCustomerId
      ? "Card (Stripe)"
      : null;
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
    setActivationAddons(null);
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
        text: `Subscription activated — ${planLabel(res.data.plan)} plan, paid by ${EXTERNAL_PAYMENT_METHODS.find((m) => m.value === manualForm.paymentMethod)?.label ?? manualForm.paymentMethod}. Next renewal ${longDate(new Date(res.data.periodEnd))}.`,
      });
      setActivationAddons((res.data as ManualActivationResult).addons ?? null);
      onRefreshTenant();
    } catch (err: unknown) {
      setMsg({ type: "error", text: activationErrorText(err) });
    } finally {
      setActivating(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* Current Plan */}
      <AdminCard title="Current plan" className="min-w-0">
        <div className="flex items-center gap-4 mb-4">
          <AdminBadge variant="plan">{tenant.planKey ?? tenant.plan}</AdminBadge>
          <AdminBadge>{tenant.status}</AdminBadge>
        </div>
        {daysLeft !== null && (
          <p
            className={`text-sm ${daysLeft > 7 ? "text-green-400" : daysLeft > 0 ? "text-yellow-400" : "text-red-400"}`}
          >
            {daysLeft > 0
              ? `${daysLeft} ${daysLeft === 1 ? "day" : "days"} remaining on trial`
              : "Trial expired"}
          </p>
        )}

        {/* Rows 11 and 12: a plan move and a trial extension are billing, so they sit with the plan. */}
        <div className="mt-5 border-t border-slate-700 pt-4">
          <TierChangeControl
            tenantId={tenant.id}
            currentPlan={currentPlan}
            plans={withCurrentPlan(planOptions.planKeys, currentPlan)}
            planLabel={planLabel}
            disabled={actionLoading === "change-plan"}
            onChangePlan={(plan) => onAction("change-plan", { plan })}
          />
        </div>

        <div className="mt-5 border-t border-slate-700 pt-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
            Extend Trial
          </h3>
          {tenant.status !== "TRIAL" && (
            <p id="not-on-trial-note" className="mb-3 text-sm text-slate-300">
              Not on a trial.
            </p>
          )}
          <div className="flex items-center gap-3">
            <label className="text-sm text-slate-400">Days</label>
            <input
              aria-label="Days"
              type="number"
              min={1}
              max={365}
              value={trialDays}
              onChange={(e) => onTrialDays(Number(e.target.value))}
              className="h-9 w-20 rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
            />
            <button
              disabled={actionLoading === "extend-trial" || !canExtendTrial}
              aria-describedby={canExtendTrial ? undefined : "extend-trial-hint"}
              onClick={onAskExtendTrial}
              className="rounded-lg bg-slate-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-500 disabled:opacity-50"
            >
              {actionLoading === "extend-trial" ? "Extending…" : "Extend trial"}
            </button>
          </div>
          <DisabledHint
            id="extend-trial-hint"
            show={!canExtendTrial}
            className="mt-2 text-xs text-slate-400"
          >
            {TENANT_ACTION_COPY.trialNotAllowed}
          </DisabledHint>
        </div>
      </AdminCard>

      {/* Subscription Details */}
      <AdminCard title="Subscription" className="min-w-0">
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
              <dt className="text-slate-400">Plan</dt>
              <dd className="text-white">{sub.currentPlan}</dd>
            </div>
            {sub.periodStart && (
              <div className="flex justify-between">
                <dt className="text-slate-400">Period Start</dt>
                <dd className="text-slate-300">{new Date(sub.periodStart).toLocaleDateString()}</dd>
              </div>
            )}
            {sub.periodEnd && (
              <div className="flex justify-between">
                <dt className="text-slate-400">Next renewal</dt>
                <dd className="text-slate-300">{new Date(sub.periodEnd).toLocaleDateString()}</dd>
              </div>
            )}
            {paymentMethodLabel && (
              <div className="flex justify-between">
                <dt className="text-slate-400">Payment method</dt>
                <dd className="text-slate-300">{paymentMethodLabel}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-slate-400">Cancel Pending</dt>
              <dd className={sub.cancelAtPeriodEnd ? "text-red-400" : "text-green-400"}>
                {sub.cancelAtPeriodEnd ? "Yes" : "No"}
              </dd>
            </div>
            {sub.externalPaymentRef && (
              <div className="flex justify-between">
                <dt className="text-slate-400">Payment Ref</dt>
                <dd className="font-mono text-xs text-slate-300">{sub.externalPaymentRef}</dd>
              </div>
            )}
            {sub.externalPaymentNotes && (
              <div className="flex flex-col gap-1">
                <dt className="text-slate-400">Notes</dt>
                <dd className="rounded bg-slate-700/50 px-3 py-2 text-xs text-slate-300">
                  {sub.externalPaymentNotes}
                </dd>
              </div>
            )}
            {sub.stripeCustomerId && (
              <details className="text-sm">
                <summary className="cursor-pointer text-slate-400 hover:text-slate-300">
                  More details
                </summary>
                <div className="mt-2 flex justify-between">
                  <span className="text-slate-400">Stripe ID</span>
                  <span className="font-mono text-xs text-slate-400">{sub.stripeCustomerId}</span>
                </div>
              </details>
            )}
          </dl>
        ) : (
          <p className="text-sm text-slate-400">No subscription record yet.</p>
        )}
      </AdminCard>

      {/* Manual Activation */}
      <AdminCard title="Manual activation" className="min-w-0 lg:col-span-2">
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
        {msg?.type === "success" && <ActivationAddonChecklist addons={activationAddons} />}

        <form
          onSubmit={handleManualActivation}
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {/* Plan */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Plan</label>
            <select
              aria-label="Plan"
              value={manualForm.plan}
              onChange={(e) => setManualForm((f) => ({ ...f, plan: e.target.value }))}
              className="h-9 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
            >
              {withCurrentPlan(planOptions.planKeys, manualForm.plan).map((p) => (
                <option key={p} value={p}>
                  {planLabel(p)}
                </option>
              ))}
            </select>
            {planOptions.unavailable && (
              <p className="mt-1 text-xs text-amber-400">
                Plan catalog unavailable — showing all plans without live pricing.
              </p>
            )}
          </div>

          {/* Payment method */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Payment Method</label>
            <select
              aria-label="Payment method"
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
              aria-label="Billing period"
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
              <span className="text-slate-400">(optional)</span>
            </label>
            <input
              aria-label="Transaction / confirmation reference"
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
              Notes <span className="text-slate-400">(optional)</span>
            </label>
            <input
              aria-label="Notes"
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
              {activating ? "Activating…" : "Activate subscription"}
            </button>
            <p className="text-xs text-slate-400">
              This will set the tenant status to <strong className="text-slate-300">ACTIVE</strong>{" "}
              and record the selected payment method.
            </p>
          </div>
        </form>
      </AdminCard>

      {/* Stripe Actions — checkout now lives on the Pricing card below (interval-aware) */}
      <AdminCard title="Stripe actions" className="min-w-0 lg:col-span-2">
        <div className="flex flex-wrap gap-3">
          <button
            disabled={portalLoading}
            onClick={openBillingPortal}
            className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-600 disabled:opacity-50"
          >
            {portalLoading ? "Opening…" : "Open billing portal"}
          </button>
        </div>
      </AdminCard>

      {/* Pricing — resolved catalog/custom price + the sole checkout entry point */}
      <TenantPricingCard tenantId={tenant.id} />
    </div>
  );
}

// ─── Features Tab ──────────────────────────────────────────────────────────────
// The new home for setup (list rows 21-24): the tenant's current setup in plain English, the business-profile
// picker, then the feature console as the main list (no "Advanced" fold) with the per-feature overrides under it.
// WP12 moves each override into its feature's row; until then the table stays here, one section below the list.

function FeaturesTab({
  tenant,
  onAction,
  actionLoading,
}: {
  tenant: TenantDetail;
  onAction: (action: string, payload?: unknown) => Promise<void>;
  actionLoading: string | null;
}) {
  const overridesRef = React.useRef<FeatureOverridesSectionHandle>(null);
  // Bumped when a business profile changed this tenant's setup: the console and the overrides list remount and reload.
  const [setupVersion, setSetupVersion] = React.useState(0);

  return (
    <>
      <SetupSection
        tenantId={tenant.id}
        version={setupVersion}
        onApplied={() => setSetupVersion((v) => v + 1)}
      />

      <section className="mt-6" data-testid="features-list">
        <div id="features">
          <FeatureConsole
            key={`console-${setupVersion}`}
            tenant={tenant}
            tenantLabel={tenant.businessName ?? tenant.slug}
            onChangePlan={(plan) => onAction("change-plan", { plan })}
            changePlanLoading={actionLoading === "change-plan"}
            onCustomise={(featureKey) => overridesRef.current?.openFor(featureKey)}
          />
        </div>

        <FeatureOverridesSection
          key={`overrides-${setupVersion}`}
          ref={overridesRef}
          tenant={tenant}
        />
      </section>
    </>
  );
}

// ─── Business details Tab ──────────────────────────────────────────────────────
// Who the business is (list rows 6, 8, 13, 14, 25-27): name, look, logo picture, address and phone, the main login
// with its password reset, and, alone at the very bottom, Delete.

const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000/api/v1";

function AdminPasswordReset({ tenantId }: { tenantId: string }) {
  const [showResetConfirm, setShowResetConfirm] = React.useState(false);
  const [resetResult, setResetResult] = React.useState<{
    username: string;
    tempPassword: string;
  } | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  return (
    <AdminCard title="Admin password reset" className="min-w-0">
      {!showResetConfirm ? (
        <button
          disabled={busy}
          onClick={() => setShowResetConfirm(true)}
          className="rounded-lg bg-orange-700/60 px-4 py-2 text-sm font-semibold text-orange-300 ring-1 ring-orange-600/40 transition-colors hover:bg-orange-700 disabled:opacity-50"
        >
          Reset admin password
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-orange-900/40 px-4 py-2 ring-1 ring-orange-700">
          <span className="text-sm text-orange-300">Force password reset?</span>
          <button
            disabled={busy}
            onClick={async () => {
              setShowResetConfirm(false);
              setBusy(true);
              try {
                const res = await superAdminClient.post(
                  `/platform-admin/tenants/${tenantId}/reset-admin-password`,
                );
                setResetResult(res.data);
                setCopied(false);
              } catch {
              } finally {
                setBusy(false);
              }
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
    </AdminCard>
  );
}

function BusinessDetailsTab({
  tenant,
  adminRead,
  onAdminChange,
  onRefreshTenant,
  onAskDelete,
}: {
  tenant: TenantDetail;
  adminRead: { admin: TenantAdminUser | null; state: AdminReadState };
  onAdminChange: (admin: TenantAdminUser | null, state: AdminReadState) => void;
  onRefreshTenant: () => void;
  onAskDelete: () => void;
}) {
  // A missing storage object (or a cancelled business) makes the logo route 404: fall back to the placeholder.
  const [logoBroken, setLogoBroken] = React.useState(false);
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
  // "Create admin" on the Readiness card lands here: ?focus=admin-account scrolls <main> to the card and focuses it.
  const adminAccountRef = React.useRef<HTMLDivElement>(null);
  useFocusTarget("admin-account", adminAccountRef);

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

  const addressFields = [
    { key: "addressLine1", label: "Street" },
    { key: "city", label: "City" },
    { key: "state", label: "State / Province" },
    { key: "zip", label: "ZIP / Postcode" },
    { key: "country", label: "Country" },
    { key: "phone", label: "Phone" },
  ] as const;

  // The server only deletes SUSPENDED tenants: the control is dim until then, and says why.
  const canDelete = tenant.status === "SUSPENDED";

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <AdminCard title="Business" className="min-w-0">
        {/* Row 26: the logo as a picture, never the storage code. The public logo route streams it with no login. */}
        <div className="mb-5 flex items-center gap-4">
          <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-700/50 ring-1 ring-white/10">
            {tenant.logoKey && !logoBroken ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`${API_URL}/public/tenants/${encodeURIComponent(tenant.slug)}/logo`}
                alt={`${tenantDisplayName(tenant)} logo`}
                className="h-full w-full object-contain"
                onError={() => setLogoBroken(true)}
              />
            ) : (
              <Building2 aria-hidden="true" className="h-6 w-6 text-slate-400" />
            )}
          </div>
          {(!tenant.logoKey || logoBroken) && (
            <p className="text-sm text-slate-400">
              {tenant.logoKey ? "The logo could not be loaded." : "No logo uploaded."}
            </p>
          )}
        </div>
        <dl className="mb-6 flex flex-col gap-3 text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-slate-400">Business Name</dt>
            <dd className="text-white">
              {tenant.businessName ?? <span className="text-slate-400">Not set</span>}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-slate-400">Primary Color</dt>
            <dd className="text-white">
              {tenant.primaryColor ? (
                <span className="flex items-center gap-2">
                  <span
                    className="inline-block h-4 w-4 rounded-full ring-1 ring-white/20"
                    style={{ backgroundColor: tenant.primaryColor }}
                  />
                  {tenant.primaryColor}
                </span>
              ) : (
                <span className="text-slate-400">Not set</span>
              )}
            </dd>
          </div>
          {tenant.counts && (
            <div className="flex items-center justify-between">
              <dt className="text-slate-400">Linked buyers</dt>
              <dd className="font-mono text-slate-300">{tenant.counts.customerLinks}</dd>
            </div>
          )}
        </dl>

        <hr className="mb-5 border-slate-700" />

        <form onSubmit={handleSave} className="flex flex-col gap-4">
          <h3 className="text-sm font-semibold text-slate-300">Business Address &amp; Contact</h3>
          {addressFields.map(({ key, label }) => (
            <div key={key} className="flex flex-col gap-1">
              <label className="text-xs text-slate-400">{label}</label>
              <input
                aria-label={label}
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
            {saving ? "Saving…" : saved ? "Saved" : "Save changes"}
          </button>
        </form>
      </AdminCard>

      <div className="flex min-w-0 flex-col gap-6">
        <div
          id="admin-account"
          ref={adminAccountRef}
          tabIndex={-1}
          className="min-w-0 scroll-mt-4 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          <TenantAdminSection
            tenantId={tenant.id}
            admin={adminRead.state === "loading" ? undefined : adminRead.admin}
            onRefreshTenant={onRefreshTenant}
            onAdminChange={onAdminChange}
          />
        </div>
        <AdminPasswordReset tenantId={tenant.id} />
      </div>

      {/* Row 14: rare and permanent, so it sits alone at the very bottom, away from the daily buttons. */}
      <section
        aria-labelledby="delete-business-heading"
        data-testid="delete-zone"
        className="min-w-0 rounded-xl border border-red-900/50 bg-red-950/20 p-5 lg:col-span-2"
      >
        <h2 id="delete-business-heading" className="text-sm font-semibold text-red-300">
          Delete this business
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          This removes the business and cannot be undone.
        </p>
        <div className="mt-4 flex flex-col items-start gap-1">
          <button
            disabled={!canDelete}
            aria-describedby={canDelete ? undefined : "delete-tenant-hint"}
            onClick={onAskDelete}
            className="rounded-lg bg-red-900/40 px-4 py-2 text-sm font-semibold text-red-400 ring-1 ring-red-700 transition-colors hover:bg-red-900/70 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-red-900/40"
          >
            Delete business
          </button>
          <DisabledHint id="delete-tenant-hint" show={!canDelete}>
            {TENANT_ACTION_COPY.deleteRefused}
          </DisabledHint>
        </div>
      </section>
    </div>
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

  if (loading) return <div className="py-8 text-center text-slate-400">Loading audit logs…</div>;

  return (
    <div>
      <div className="rounded-xl bg-slate-800 ring-1 ring-white/5 overflow-hidden">
        <div className="overflow-x-auto" role="region" aria-label="Audit log entries" tabIndex={0}>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-400">
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
                  <td className="px-4 py-2 font-mono text-slate-400">
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
                      <span className="font-mono text-slate-400">
                        {log.userId?.slice(0, 8) ?? "—"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-slate-400">
                    {new Date(log.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-slate-400">{log.ip ?? "—"}</td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-400">
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
          <span className="text-sm text-slate-400">
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
  const searchParams = useSearchParams();
  const urlTab = resolveTab(searchParams?.get("tab"), searchParams?.get("focus"));
  // R26: an old link (?tab=setup, config, snapshots, audit, addons, or a bare ?focus=admin-account) opens the new tab
  // and the address bar is rewritten to it, keeping every other param (the focus target survives the move).
  const rawTab = searchParams?.get("tab") ?? null;
  React.useEffect(() => {
    if (rawTab === urlTab || (rawTab === null && urlTab === "overview")) return;
    const next = new URLSearchParams(searchParams?.toString() ?? "");
    next.set("tab", urlTab);
    router.replace(`/admin/tenants/${id}?${next.toString()}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawTab, urlTab]);
  const [tenant, setTenant] = React.useState<TenantDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [actionLoading, setActionLoading] = React.useState<string | null>(null);
  const [statusMsg, setStatusMsg] = React.useState<string | null>(null);
  const [activeTab, setActiveTab] = React.useState(urlTab);
  // The URL is the source of truth: back/forward, a pasted link and an old ?tab=addons all land here.
  React.useEffect(() => setActiveTab(urlTab), [urlTab]);
  const changeTab = (key: string) => {
    setActiveTab(key);
    router.replace(`/admin/tenants/${id}?tab=${key}`, { scroll: false });
  };

  // A refetch after an action stays silent: the loading gate below unmounts the tree, which would
  // drop state held in it (the one-time temporary password of a new tenant admin, B1271).
  const fetchTenant = React.useCallback(() => {
    superAdminClient
      .get<TenantDetail>(`/platform-admin/tenants/${id}`)
      .then((res) => setTenant(res.data))
      .catch((err) => setError(err?.response?.data?.message ?? "Failed to load tenant"))
      .finally(() => setLoading(false));
  }, [id]);

  React.useEffect(() => {
    setLoading(true);
    fetchTenant();
  }, [fetchTenant]);

  // R49: a plan move needs a reason. The plan change (from the preview's Confirm, in either control) waits here
  // for the reason dialog; Cancel resolves null and nothing is sent.
  const [moveAsk, setMoveAsk] = React.useState<{
    plan: string;
    resolve: (reason: string | null) => void;
  } | null>(null);
  const askMoveReason = (plan: string) =>
    new Promise<string | null>((resolve) => setMoveAsk({ plan, resolve }));
  const answerMoveAsk = (reason: string | null) => {
    moveAsk?.resolve(reason);
    setMoveAsk(null);
  };

  const handleAction = async (action: string, payload?: unknown) => {
    if (!tenant) return;
    let moveReason: string | null = null;
    if (action === "change-plan") {
      moveReason = await askMoveReason((payload as { plan: string }).plan);
      if (moveReason === null) return;
    }
    setActionLoading(action);
    setStatusMsg(null);
    try {
      switch (action) {
        case "toggle-status": {
          const newStatus = tenant.status === "SUSPENDED" ? "ACTIVE" : "SUSPENDED";
          await superAdminClient.patch(`/platform-admin/tenants/${id}/status`, {
            status: newStatus,
          });
          setStatusMsg(`Status changed to ${statusLabel(newStatus)}.`);
          break;
        }
        case "change-plan": {
          const { plan } = payload as { plan: string };
          await superAdminClient.patch(`/platform-admin/tenants/${id}/plan`, {
            plan,
            reason: moveReason,
          });
          setStatusMsg(`Plan changed to ${planLabel(plan)}.`);
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
            setImpersonation(
              res.data.accessToken,
              tenant.slug,
              res.data.impersonatedUser?.username,
              tenant.id,
            );
            setTenantCookie(tenant.slug);
            window.location.href = "/dashboard";
          } catch (impErr: unknown) {
            const msg =
              (impErr as { response?: { data?: { message?: string } } })?.response?.data?.message ??
              "";
            if (msg.toLowerCase().includes("tenant_admin")) {
              setStatusMsg(TENANT_ACTION_COPY.noAdmin(tenantLabel(tenant)));
            } else {
              setStatusMsg(TENANT_ACTION_COPY.impersonateFailed);
            }
          }
          return;
        }
        case "extend-trial": {
          const { days } = payload as { days: number };
          const res = await superAdminClient.post(`/platform-admin/tenants/${id}/extend-trial`, {
            days,
          });
          setStatusMsg(`Trial extended. It ends ${longDate(new Date(res.data.trialEndsAt))}.`);
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
      // Fixed copy per action: the server's own text is never shown.
      // A failed delete is shown INSIDE its dialog (the page rethrows below), not as a second banner.
      if (action !== "delete") {
        setStatusMsg(
          action === "extend-trial"
            ? extendFailureCopy(err)
            : action === "change-plan"
              ? TENANT_ACTION_COPY.planFailed
              : action === "toggle-status"
                ? statusFailureCopy(err)
                : TENANT_ACTION_COPY.actionFailed,
        );
      }
      // The Feature Console's tier-change confirm (via onChangePlan) awaits this call and must
      // observe the failure to keep its preview drawer open with the error, instead of silently
      // closing as if the change applied — rethrow only for this action; every other call site
      // here is a fire-and-forget onClick that already gets its feedback from statusMsg above.
      if (action === "change-plan" || action === "delete") throw err;
    } finally {
      setActionLoading(null);
    }
  };

  // The page's single Admin Account read (the Business details card shows it; Overview's readiness card and the
  // Sign-in dialog use it too), so no tab mounts a second fetch.
  const [adminRead, setAdminRead] = React.useState<{
    admin: TenantAdminUser | null;
    state: AdminReadState;
  }>({ admin: null, state: "loading" });
  const handleAdminChange = React.useCallback(
    (admin: TenantAdminUser | null, state: AdminReadState) => setAdminRead({ admin, state }),
    [],
  );
  React.useEffect(() => {
    let live = true;
    setAdminRead({ admin: null, state: "loading" });
    superAdminClient
      .get(`/platform-admin/tenants/${id}/admin`)
      .then((res) => live && setAdminRead({ admin: res.data.admin ?? null, state: "loaded" }))
      .catch(() => live && setAdminRead({ admin: null, state: "failed" }));
    return () => {
      live = false;
    };
  }, [id]);

  // The four confirm dialogs live here, so the header, Plan & billing and Business details can all open them.
  const [confirming, setConfirming] = React.useState<
    "impersonate" | "extend-trial" | "suspend" | "delete" | null
  >(null);
  // The server only deletes SUSPENDED tenants: its refusal is shown inside the delete dialog, which stays open.
  const [deleteError, setDeleteError] = React.useState<string | null>(null);
  const [trialDays, setTrialDays] = React.useState(14);

  if (loading) return <div className="p-6 text-center text-slate-400">Loading tenant…</div>;

  if (error || !tenant) {
    return (
      <div className="p-6">
        <div
          role="alert"
          className="rounded-lg bg-red-900/40 px-4 py-3 text-sm text-red-400 ring-1 ring-red-700"
        >
          {error ?? "Tenant not found"}
        </div>
        <Link
          href="/admin/tenants"
          className="admin-tap-text mt-4 inline-block text-sm text-indigo-400 hover:underline"
        >
          Back to tenants
        </Link>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header: which business, on every tab (list row 1), with the two daily actions (rows 9, 10) */}
      <div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link
          href="/admin/tenants"
          className="admin-tap-text text-sm text-slate-400 hover:text-slate-300"
        >
          Tenants
        </Link>
        <span className="text-slate-400">/</span>
        <h1 className="text-xl font-bold text-white">{tenantDisplayName(tenant)}</h1>
        <AdminBadge>{tenant.status}</AdminBadge>
        <AdminBadge variant="plan">{tenant.planKey ?? tenant.plan}</AdminBadge>
        {tenant.status !== "CANCELLED" && (
          <div className="flex flex-wrap gap-2 sm:ml-auto" data-testid="tenant-header-actions">
            <button
              disabled={actionLoading === "toggle-status"}
              onClick={() =>
                tenant.status === "SUSPENDED"
                  ? handleAction("toggle-status")
                  : setConfirming("suspend")
              }
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-50 ${
                tenant.status === "SUSPENDED"
                  ? "bg-green-700 text-white hover:bg-green-600"
                  : "bg-yellow-700 text-white hover:bg-yellow-600"
              }`}
            >
              {tenant.status === "SUSPENDED" ? "Reactivate" : "Suspend"}
            </button>
            <button
              disabled={actionLoading === "impersonate"}
              onClick={() => setConfirming("impersonate")}
              className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-600 disabled:opacity-50"
            >
              Sign in as admin
            </button>
          </div>
        )}
      </div>
      <p className="mb-4 text-sm text-slate-400">
        <span className="font-mono">{tenant.slug}</span>.routeflow.info · created{" "}
        {new Date(tenant.createdAt).toLocaleDateString()}
        {tenant.counts
          ? ` · ${tenant.counts.users} ${tenant.counts.users === 1 ? "user" : "users"}`
          : ""}
      </p>

      {statusMsg && (
        <div
          role="status"
          className="mb-4 rounded-lg bg-indigo-900/40 px-4 py-2 text-sm text-indigo-300 ring-1 ring-indigo-700"
        >
          {statusMsg}
        </div>
      )}

      {/* Tabs */}
      <AdminTabs tabs={TABS} active={activeTab} onChange={changeTab} />

      {/* Tab Content */}
      {activeTab === "overview" && <OverviewTab tenant={tenant} adminRead={adminRead} />}
      {activeTab === "features" && (
        <FeaturesTab tenant={tenant} onAction={handleAction} actionLoading={actionLoading} />
      )}
      {activeTab === "billing" && (
        <BillingTab
          tenant={tenant}
          onRefreshTenant={fetchTenant}
          onAction={handleAction}
          actionLoading={actionLoading}
          onAskExtendTrial={() => setConfirming("extend-trial")}
          trialDays={trialDays}
          onTrialDays={setTrialDays}
        />
      )}
      {activeTab === "details" && (
        <BusinessDetailsTab
          tenant={tenant}
          adminRead={adminRead}
          onAdminChange={handleAdminChange}
          onRefreshTenant={fetchTenant}
          onAskDelete={() => {
            setDeleteError(null);
            setConfirming("delete");
          }}
        />
      )}
      {activeTab === "history" && (
        <>
          <div className="mb-8">
            <FeatureChangeHistory tenantId={tenant.id} />
          </div>
          <h2 className="mb-3 text-sm font-semibold text-slate-300">Audit log</h2>
          <AuditLogTab tenantId={tenant.id} />
          <div className="mt-8">
            <ConfigSnapshotsTab tenantId={tenant.id} />
          </div>
        </>
      )}

      <ImpersonateDialog
        open={confirming === "impersonate"}
        tenant={tenant}
        adminUsername={adminRead.admin?.username ?? null}
        busy={actionLoading === "impersonate"}
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          setConfirming(null);
          void handleAction("impersonate");
        }}
      />
      <SuspendDialog
        open={confirming === "suspend"}
        tenant={tenant}
        busy={actionLoading === "toggle-status"}
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          setConfirming(null);
          void handleAction("toggle-status");
        }}
      />
      <DeleteTenantDialog
        open={confirming === "delete"}
        tenant={tenant}
        busy={actionLoading === "delete"}
        error={deleteError}
        onClose={() => setConfirming(null)}
        onConfirm={async () => {
          setDeleteError(null);
          try {
            await handleAction("delete");
          } catch (err: unknown) {
            setDeleteError(deleteFailureCopy(err));
          }
        }}
      />
      <ExtendTrialDialog
        open={confirming === "extend-trial"}
        tenant={tenant}
        status={tenant.status}
        days={trialDays}
        trialEndsAt={tenant.trialEndsAt}
        busy={actionLoading === "extend-trial"}
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          setConfirming(null);
          void handleAction("extend-trial", { days: trialDays });
        }}
      />

      <PlanMoveReasonDialog
        open={moveAsk !== null}
        // SA-1100 A-1: one business's money, so the reason dialog is the red confirm and names who.
        title={`Move ${tenantDisplayName(tenant)} to ${planLabel(moveAsk?.plan ?? "")}?`}
        onSubmit={answerMoveAsk}
        onCancel={() => answerMoveAsk(null)}
      />
    </div>
  );
}
