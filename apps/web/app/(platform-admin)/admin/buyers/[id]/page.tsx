"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { superAdminClient } from "@/lib/admin-api";
import { BUYER_KEYS } from "@/lib/auth-keys";
import { AdminBadge } from "../../../_components/AdminBadge";
import { AdminModal } from "../../../_components/AdminModal";
import {
  ArrowLeft,
  User,
  Link2,
  ShieldCheck,
  ShieldOff,
  Trash2,
  ExternalLink,
  Plus,
  Unlink,
  Save,
  RefreshCw,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CustomerLink {
  id: string;
  status: string;
  linkedAt: string | null;
  createdAt: string;
  tenant: { id: string; name: string; slug: string };
  customer: { id: string; businessName: string | null };
}

interface Buyer {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  mobile: string | null;
  status: "ACTIVE" | "SUSPENDED" | "DELETED";
  emailVerified: boolean;
  createdAt: string;
  updatedAt: string;
  customerLinks: CustomerLink[];
}

interface TenantOption {
  id: string;
  slug: string;
  name: string;
  status: string;
}
interface TenantsResponse {
  data: TenantOption[];
  meta: { total: number };
}
interface CustomerOption {
  id: string;
  businessName: string | null;
  email: string | null;
  customerLink: {
    id: string;
    status: string;
    buyerAccountId: string | null;
    buyerAccount: { id: string; email: string; name: string } | null;
  } | null;
}
interface TenantCustomersResponse {
  tenantId: string;
  tenantName: string;
  customers: CustomerOption[];
}

// ─── Tab types ────────────────────────────────────────────────────────────────

type Tab = "profile" | "sellers";

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BuyerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [buyer, setBuyer] = React.useState<Buyer | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<Tab>("profile");

  // Profile edit
  const [editName, setEditName] = React.useState("");
  const [editEmail, setEditEmail] = React.useState("");
  const [editPhone, setEditPhone] = React.useState("");
  const [editMobile, setEditMobile] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = React.useState(false);

  // Status action
  const [statusLoading, setStatusLoading] = React.useState(false);

  // Impersonate
  const [impersonating, setImpersonating] = React.useState(false);

  // Add link modal
  const [addLinkOpen, setAddLinkOpen] = React.useState(false);
  const [tenants, setTenants] = React.useState<TenantOption[]>([]);
  const [tenantsLoading, setTenantsLoading] = React.useState(false);
  const [selectedTenantId, setSelectedTenantId] = React.useState("");
  const [tenantCustomers, setTenantCustomers] = React.useState<CustomerOption[]>([]);
  const [customersLoading, setCustomersLoading] = React.useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = React.useState("");
  const [addLinkLoading, setAddLinkLoading] = React.useState(false);
  const [addLinkError, setAddLinkError] = React.useState<string | null>(null);

  // Remove link
  const [removingLink, setRemovingLink] = React.useState<string | null>(null);

  // ── Load buyer ───────────────────────────────────────────────────────────────

  const fetchBuyer = React.useCallback(() => {
    setLoading(true);
    setError(null);
    superAdminClient
      .get<Buyer>(`/platform-admin/buyer-accounts/${id}`)
      .then((res) => {
        setBuyer(res.data);
        setEditName(res.data.name);
        setEditEmail(res.data.email);
        setEditPhone(res.data.phone ?? "");
        setEditMobile(res.data.mobile ?? "");
      })
      .catch((err) => setError(err?.response?.data?.message ?? "Failed to load buyer"))
      .finally(() => setLoading(false));
  }, [id]);

  React.useEffect(() => {
    fetchBuyer();
  }, [fetchBuyer]);

  // ── Profile save ─────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!buyer) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      await superAdminClient.patch(`/platform-admin/buyer-accounts/${id}`, {
        name: editName.trim() || undefined,
        email: editEmail.trim() || undefined,
        phone: editPhone.trim() || null,
        mobile: editMobile.trim() || null,
      });
      setSaveSuccess(true);
      fetchBuyer();
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: unknown) {
      setSaveError(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Save failed",
      );
    } finally {
      setSaving(false);
    }
  };

  // ── Status change ─────────────────────────────────────────────────────────────

  const handleStatus = async (status: "ACTIVE" | "SUSPENDED" | "DELETED") => {
    if (!buyer) return;
    if (
      status === "DELETED" &&
      !window.confirm(`Permanently delete "${buyer.name}"? This cannot be undone.`)
    )
      return;
    if (status === "SUSPENDED" && !window.confirm(`Suspend "${buyer.name}"?`)) return;
    setStatusLoading(true);
    try {
      await superAdminClient.patch(`/platform-admin/buyer-accounts/${id}/status`, { status });
      if (status === "DELETED") {
        router.push("/admin/buyers");
      } else {
        fetchBuyer();
      }
    } catch (err: unknown) {
      alert(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Action failed",
      );
    } finally {
      setStatusLoading(false);
    }
  };

  // ── Impersonate ───────────────────────────────────────────────────────────────

  const handleImpersonate = async () => {
    if (
      !buyer ||
      !window.confirm(
        `Impersonate ${buyer.name}? A short-lived JWT will be issued. The buyer will not be notified.`,
      )
    )
      return;
    setImpersonating(true);
    try {
      const res = await superAdminClient.post<{ accessToken: string }>(
        `/platform-admin/buyer-accounts/${id}/impersonate`,
      );
      // A5: write the NAMESPACED key — the portal reads tokens through
      // getBuyerAccessToken() (rf:buyer:accessToken first). Writing only the
      // legacy literal left the portal looking logged-out after impersonation.
      localStorage.setItem(BUYER_KEYS.accessToken, res.data.accessToken);
      window.open("/buyer/portal", "_blank");
    } catch (err: unknown) {
      alert(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Impersonation failed",
      );
    } finally {
      setImpersonating(false);
    }
  };

  // ── Add link modal ────────────────────────────────────────────────────────────

  const openAddLink = () => {
    setAddLinkOpen(true);
    setSelectedTenantId("");
    setSelectedCustomerId("");
    setTenantCustomers([]);
    setAddLinkError(null);
    if (tenants.length === 0) {
      setTenantsLoading(true);
      superAdminClient
        .get<TenantsResponse>("/platform-admin/tenants?limit=200")
        .then((res) => setTenants(res.data.data))
        .catch(() => setTenants([]))
        .finally(() => setTenantsLoading(false));
    }
  };

  const handleTenantSelect = (tenantId: string) => {
    setSelectedTenantId(tenantId);
    setSelectedCustomerId("");
    setTenantCustomers([]);
    if (!tenantId) return;
    setCustomersLoading(true);
    superAdminClient
      .get<TenantCustomersResponse>(
        `/platform-admin/buyer-accounts/${id}/tenant-customers?tenantId=${tenantId}`,
      )
      .then((res) => setTenantCustomers(res.data.customers))
      .catch(() => setTenantCustomers([]))
      .finally(() => setCustomersLoading(false));
  };

  const handleAddLink = async () => {
    if (!selectedTenantId || !selectedCustomerId) return;
    setAddLinkLoading(true);
    setAddLinkError(null);
    try {
      await superAdminClient.post(`/platform-admin/buyer-accounts/${id}/links`, {
        tenantId: selectedTenantId,
        customerId: selectedCustomerId,
      });
      setAddLinkOpen(false);
      fetchBuyer();
    } catch (err: unknown) {
      setAddLinkError(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Failed to add link",
      );
    } finally {
      setAddLinkLoading(false);
    }
  };

  // ── Remove link ───────────────────────────────────────────────────────────────

  const handleRemoveLink = async (link: CustomerLink) => {
    if (!window.confirm(`Disconnect "${buyer?.name}" from "${link.tenant.name}"?`)) return;
    setRemovingLink(link.id);
    try {
      await superAdminClient.delete(`/platform-admin/customer-links/${link.id}`);
      fetchBuyer();
    } catch (err: unknown) {
      alert(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Failed to remove link",
      );
    } finally {
      setRemovingLink(null);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-slate-500">
        Loading buyer account...
      </div>
    );
  }

  if (error || !buyer) {
    return (
      <div className="p-6">
        <div className="rounded-lg bg-red-900/40 px-4 py-3 text-sm text-red-400 ring-1 ring-red-700">
          {error ?? "Buyer not found"}
        </div>
        <Link
          href="/admin/buyers"
          className="mt-4 inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Buyers
        </Link>
      </div>
    );
  }

  const profileDirty =
    editName !== buyer.name ||
    editEmail !== buyer.email ||
    editPhone !== (buyer.phone ?? "") ||
    editMobile !== (buyer.mobile ?? "");

  const activeLinks = buyer.customerLinks.filter((l) => l.status === "ACTIVE");
  const otherLinks = buyer.customerLinks.filter((l) => l.status !== "ACTIVE");

  return (
    <div className="p-6 max-w-4xl">
      {/* Back + Header */}
      <div className="mb-6">
        <Link
          href="/admin/buyers"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Buyers
        </Link>

        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-white">{buyer.name}</h1>
              <AdminBadge>{buyer.status}</AdminBadge>
              {buyer.emailVerified && (
                <span className="rounded-full bg-green-900/40 px-2 py-0.5 text-xs font-medium text-green-400 ring-1 ring-green-700/40">
                  Email verified
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-slate-400">{buyer.email}</p>
            <p className="mt-0.5 text-xs text-slate-600">
              Joined {new Date(buyer.createdAt).toLocaleDateString()} · ID: {buyer.id}
            </p>
          </div>

          {/* Quick actions */}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {buyer.status === "ACTIVE" && (
              <button
                disabled={impersonating}
                onClick={handleImpersonate}
                className="flex items-center gap-1.5 rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700 disabled:opacity-50"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {impersonating ? "Opening..." : "Impersonate"}
              </button>
            )}
            {buyer.status === "ACTIVE" && (
              <button
                disabled={statusLoading}
                onClick={() => handleStatus("SUSPENDED")}
                className="flex items-center gap-1.5 rounded-lg border border-yellow-700/50 px-3 py-1.5 text-xs font-medium text-yellow-400 hover:bg-yellow-900/30 disabled:opacity-50"
              >
                <ShieldOff className="h-3.5 w-3.5" />
                Suspend
              </button>
            )}
            {buyer.status === "SUSPENDED" && (
              <button
                disabled={statusLoading}
                onClick={() => handleStatus("ACTIVE")}
                className="flex items-center gap-1.5 rounded-lg border border-green-700/50 px-3 py-1.5 text-xs font-medium text-green-400 hover:bg-green-900/30 disabled:opacity-50"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                Reactivate
              </button>
            )}
            {buyer.status !== "DELETED" && (
              <button
                disabled={statusLoading}
                onClick={() => handleStatus("DELETED")}
                className="flex items-center gap-1.5 rounded-lg border border-red-700/50 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-900/30 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Tabs — B559: same unwrapped-flex-row defect class as (platform-admin)/_components/
          AdminTabs.tsx; scroll the strip itself instead of letting it force the shared
          `<main className="flex-1 overflow-y-auto">` shell wider than the viewport. */}
      <div className="mb-6 flex overflow-x-auto border-b border-slate-700">
        {(["profile", "sellers"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex shrink-0 items-center gap-2 whitespace-nowrap px-4 py-2.5 text-sm font-medium transition-colors border-b-2 ${
              tab === t
                ? "border-indigo-500 text-white"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            {t === "profile" ? <User className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
            {t === "profile" ? "Profile" : `Seller Links (${buyer.customerLinks.length})`}
          </button>
        ))}
      </div>

      {/* ── Profile Tab ──────────────────────────────────────────────────────── */}
      {tab === "profile" && (
        <div className="rounded-xl bg-slate-800 p-6 ring-1 ring-white/5">
          <h2 className="mb-4 text-sm font-semibold text-slate-300">Edit Profile</h2>

          {saveError && (
            <div className="mb-4 rounded-lg bg-red-900/40 px-3 py-2 text-sm text-red-400 ring-1 ring-red-700">
              {saveError}
            </div>
          )}
          {saveSuccess && (
            <div className="mb-4 rounded-lg bg-green-900/40 px-3 py-2 text-sm text-green-400 ring-1 ring-green-700">
              Profile saved successfully.
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">Full Name</label>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="h-9 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">
                Email
                {editEmail !== buyer.email && (
                  <span className="ml-2 text-yellow-400">(will un-verify)</span>
                )}
              </label>
              <input
                type="email"
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
                className="h-9 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">Phone</label>
              <input
                type="tel"
                value={editPhone}
                onChange={(e) => setEditPhone(e.target.value)}
                placeholder="Optional"
                className="h-9 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">Mobile</label>
              <input
                type="tel"
                value={editMobile}
                onChange={(e) => setEditMobile(e.target.value)}
                placeholder="Optional"
                className="h-9 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
              />
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <button
              onClick={fetchBuyer}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Reset changes
            </button>
            <button
              disabled={saving || !profileDirty}
              onClick={handleSave}
              className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>

          {/* Account metadata */}
          <div className="mt-6 border-t border-slate-700 pt-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
              Account Info
            </h3>
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              {[
                { label: "Account ID", value: buyer.id, mono: true },
                { label: "Status", value: buyer.status },
                { label: "Email Verified", value: buyer.emailVerified ? "Yes" : "No" },
                { label: "Joined", value: new Date(buyer.createdAt).toLocaleString() },
                { label: "Last Updated", value: new Date(buyer.updatedAt).toLocaleString() },
                { label: "Google Account", value: "Check DB" },
              ].map((item) => (
                <div key={item.label}>
                  <dt className="text-xs text-slate-500">{item.label}</dt>
                  <dd
                    className={`mt-0.5 ${item.mono ? "font-mono text-xs text-slate-400" : "text-white"}`}
                  >
                    {item.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}

      {/* ── Sellers Tab ──────────────────────────────────────────────────────── */}
      {tab === "sellers" && (
        <div className="space-y-4">
          {/* Header + Add button */}
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-400">
              {activeLinks.length} active · {otherLinks.length} inactive
            </p>
            <button
              onClick={openAddLink}
              className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              <Plus className="h-4 w-4" /> Link to Seller
            </button>
          </div>

          {/* Active links */}
          {buyer.customerLinks.length === 0 ? (
            <div className="rounded-xl bg-slate-800 p-10 text-center ring-1 ring-white/5">
              <Link2 className="mx-auto mb-3 h-8 w-8 text-slate-600" />
              <p className="text-sm text-slate-500">No seller connections yet.</p>
              <button
                onClick={openAddLink}
                className="mt-3 text-sm text-indigo-400 hover:text-indigo-300"
              >
                + Link to a seller
              </button>
            </div>
          ) : (
            <div className="rounded-xl bg-slate-800 ring-1 ring-white/5 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-500">
                    <th className="px-4 py-3 text-left">Seller (Tenant)</th>
                    <th className="px-4 py-3 text-left">Customer Record</th>
                    <th className="px-4 py-3 text-left">Status</th>
                    <th className="px-4 py-3 text-left">Linked</th>
                    <th className="px-4 py-3 text-left">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/50">
                  {buyer.customerLinks.map((link) => (
                    <tr key={link.id} className="hover:bg-slate-700/20 transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-medium text-white">{link.tenant.name}</div>
                        <div className="font-mono text-xs text-slate-500">{link.tenant.slug}</div>
                      </td>
                      <td className="px-4 py-3 text-slate-300">
                        {link.customer.businessName ?? <span className="text-slate-600">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <AdminBadge>{link.status}</AdminBadge>
                      </td>
                      <td className="px-4 py-3 text-slate-500">
                        {link.linkedAt ? (
                          new Date(link.linkedAt).toLocaleDateString()
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {link.status === "ACTIVE" && (
                          <button
                            disabled={removingLink === link.id}
                            onClick={() => handleRemoveLink(link)}
                            className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-900/30 disabled:opacity-50"
                          >
                            <Unlink className="h-3.5 w-3.5" />
                            {removingLink === link.id ? "Removing..." : "Disconnect"}
                          </button>
                        )}
                        {link.status !== "ACTIVE" && (
                          <button
                            disabled={addLinkLoading}
                            onClick={async () => {
                              setAddLinkLoading(true);
                              try {
                                await superAdminClient.post(
                                  `/platform-admin/buyer-accounts/${id}/links`,
                                  {
                                    tenantId: link.tenant.id,
                                    customerId: link.customer.id,
                                  },
                                );
                                fetchBuyer();
                              } catch (err: unknown) {
                                alert(
                                  (err as { response?: { data?: { message?: string } } })?.response
                                    ?.data?.message ?? "Failed",
                                );
                              } finally {
                                setAddLinkLoading(false);
                              }
                            }}
                            className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-green-400 hover:bg-green-900/30 disabled:opacity-50"
                          >
                            <Link2 className="h-3.5 w-3.5" />
                            Reconnect
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Add Link Modal ────────────────────────────────────────────────────── */}
      <AdminModal
        open={addLinkOpen}
        onClose={() => setAddLinkOpen(false)}
        title="Link Buyer to a Seller"
        footer={
          <>
            <button
              onClick={() => setAddLinkOpen(false)}
              className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              disabled={!selectedTenantId || !selectedCustomerId || addLinkLoading}
              onClick={handleAddLink}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {addLinkLoading ? "Linking..." : "Confirm Link"}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          {addLinkError && (
            <div className="rounded-lg bg-red-900/40 px-3 py-2 text-sm text-red-400 ring-1 ring-red-700">
              {addLinkError}
            </div>
          )}

          {/* Tenant picker */}
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-300">
              Select Seller (Tenant)
            </label>
            {tenantsLoading ? (
              <div className="text-sm text-slate-500">Loading tenants...</div>
            ) : (
              <select
                value={selectedTenantId}
                onChange={(e) => handleTenantSelect(e.target.value)}
                className="h-9 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
              >
                <option value="">-- Choose a seller --</option>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.slug})
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Customer picker */}
          {selectedTenantId && (
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-300">
                Select Customer Record in this Seller
              </label>
              {customersLoading ? (
                <div className="text-sm text-slate-500">Loading customers...</div>
              ) : tenantCustomers.length === 0 ? (
                <div className="text-sm text-slate-500">
                  No customers found in this tenant. Ask the seller to create a customer record
                  first.
                </div>
              ) : (
                <select
                  value={selectedCustomerId}
                  onChange={(e) => setSelectedCustomerId(e.target.value)}
                  className="h-9 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
                >
                  <option value="">-- Choose a customer --</option>
                  {tenantCustomers.map((c) => {
                    const hasOtherBuyer =
                      c.customerLink?.buyerAccountId &&
                      c.customerLink.buyerAccountId !== id &&
                      c.customerLink.status === "ACTIVE";
                    const alreadyThisBuyer =
                      c.customerLink?.buyerAccountId === id && c.customerLink.status === "ACTIVE";
                    return (
                      <option key={c.id} value={c.id} disabled={alreadyThisBuyer}>
                        {c.businessName ?? c.email ?? c.id}
                        {alreadyThisBuyer ? " (already linked)" : ""}
                        {hasOtherBuyer
                          ? ` (linked to: ${c.customerLink?.buyerAccount?.email})`
                          : ""}
                      </option>
                    );
                  })}
                </select>
              )}
              {selectedCustomerId &&
                (() => {
                  const chosen = tenantCustomers.find((c) => c.id === selectedCustomerId);
                  const hasOtherBuyer =
                    chosen?.customerLink?.buyerAccountId &&
                    chosen.customerLink.buyerAccountId !== id &&
                    chosen.customerLink.status === "ACTIVE";
                  return hasOtherBuyer ? (
                    <p className="mt-2 rounded-lg bg-yellow-900/30 px-3 py-2 text-xs text-yellow-400 ring-1 ring-yellow-700/40">
                      ⚠ This customer is already linked to{" "}
                      {chosen?.customerLink?.buyerAccount?.name} (
                      {chosen?.customerLink?.buyerAccount?.email}). Confirming will reassign this
                      link to {buyer.name}.
                    </p>
                  ) : null;
                })()}
            </div>
          )}
        </div>
      </AdminModal>
    </div>
  );
}
