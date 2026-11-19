"use client";

import * as React from "react";
import {
  FEATURE_OVERRIDE_KIND_VALUES,
  type FeatureOverrideKind,
  type FeatureRegistryRow,
} from "@routeflow/types";
import { superAdminClient } from "@/lib/admin-api";
import { previewTenantFeatures } from "@/lib/platform-admin/features";
import { AdminModal } from "../../../../_components/AdminModal";
import { DisabledHint } from "../../../../_components/DisabledHint";
import { longDate } from "../../../../_components/TenantActionDialogs";
import { PreviewDrawer } from "./PreviewDrawer";
import type { FeaturePreviewResponse } from "./types";

// ─── Feature Overrides (within the Features tab) ─────────────────────────────────

interface FeatureOverrideRow {
  id: string;
  tenantId: string;
  featureKey: string;
  effect: "GRANT" | "DENY";
  reason: string;
  expiresAt: string | null;
  createdById: string | null;
  createdAt: string;
  revokedAt: string | null;
}

type ExpiryPreset = "none" | "30" | "90";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Expires options (same three values as ever): a timed one names the date it would end. */
function expiryOptions(now: number): { value: ExpiryPreset; label: string }[] {
  const ends = (days: number) => longDate(new Date(now + days * DAY_MS));
  return [
    { value: "30", label: `30 days (ends ${ends(30)})` },
    { value: "90", label: `90 days (ends ${ends(90)})` },
    { value: "none", label: "No end date" },
  ];
}

/** A comp or trial is a time-boxed gift, so it starts at 30 days: forgetting to set one must not
 * make it permanent. Every other kind keeps "no end date" as its default. */
const defaultExpiryFor = (kind: FeatureOverrideKind): ExpiryPreset =>
  kind === "COMP" || kind === "TRIAL" ? "30" : "none";

// Plain-English labels for the Kind select — values stay the raw FeatureOverrideKind enum.
const OVERRIDE_KIND_LABELS: Record<FeatureOverrideKind, string> = {
  PILOT: "Pilot",
  SUPPORT: "Support",
  COMP: "Complimentary",
  TRIAL: "Trial",
  GRANDFATHER: "Grandfathered",
};

/** Imperative handle so the Feature Console's per-row "Customise" button can open this
 * drawer prefilled for one key, without a second overrides UI (brief D done-checklist item 1). */
export interface FeatureOverridesSectionHandle {
  openFor: (featureKey: string) => void;
}

export const FeatureOverridesSection = React.forwardRef<
  FeatureOverridesSectionHandle,
  { tenant: { id: string } }
>(function FeatureOverridesSection({ tenant }, ref) {
  const [overrides, setOverrides] = React.useState<FeatureOverrideRow[]>([]);
  const [registry, setRegistry] = React.useState<FeatureRegistryRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [showForm, setShowForm] = React.useState(false);
  const [form, setForm] = React.useState({
    featureKey: "",
    effect: "GRANT" as "GRANT" | "DENY",
    kind: "COMP" as FeatureOverrideKind,
    reason: "",
    expiryPreset: defaultExpiryFor("COMP") as ExpiryPreset,
    // Once the operator picks an Expires value themselves, changing Kind no longer re-defaults it.
    expiryTouched: false,
  });
  const [submitting, setSubmitting] = React.useState(false);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);
  // Owner rule: EVERY override write goes through preview — the "+ New Override" button and
  // the Feature Console's "Customise" action share this ONE drawer and this ONE preview → confirm
  // → apply flow (brief D item 3). `pendingCreate` freezes the exact payload the preview was run
  // against, so Confirm applies precisely what was previewed even if the form underneath changes.
  const [previewResponse, setPreviewResponse] = React.useState<FeaturePreviewResponse | null>(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = React.useState<{
    featureKey: string;
    effect: "GRANT" | "DENY";
    kind: FeatureOverrideKind;
    reason: string;
    expiresAt: string | null;
  } | null>(null);
  // Only ONE AdminModal is ever open at a time (form OR preview) so Escape closes just the top
  // one instead of both stacked dialogs; when the preview closes back to the form, focus returns
  // to the form (Opus review of 73668ac2, item 6c).
  const featureKeySelectRef = React.useRef<HTMLSelectElement>(null);
  const wasPreviewOpen = React.useRef(false);
  React.useEffect(() => {
    if (wasPreviewOpen.current && !previewResponse && showForm) {
      featureKeySelectRef.current?.focus();
    }
    wasPreviewOpen.current = !!previewResponse;
  }, [previewResponse, showForm]);

  const fetchOverrides = React.useCallback(() => {
    setLoading(true);
    setError(null);
    superAdminClient
      .get(`/platform-admin/tenants/${tenant.id}/feature-overrides`)
      .then((res) => setOverrides(res.data))
      .catch(() => setError("Failed to load feature overrides."))
      .finally(() => setLoading(false));
  }, [tenant.id]);

  React.useEffect(() => {
    fetchOverrides();
    superAdminClient
      .get("/platform-admin/features/registry")
      .then((res) => setRegistry(res.data))
      .catch(() => setRegistry([]));
  }, [fetchOverrides]);

  function closeForm() {
    setShowForm(false);
    setPreviewResponse(null);
    setPendingCreate(null);
    setPreviewError(null);
  }

  function openForm() {
    setForm({
      featureKey: registry[0]?.key ?? "",
      effect: "GRANT",
      kind: "COMP",
      reason: "",
      expiryPreset: defaultExpiryFor("COMP"),
      expiryTouched: false,
    });
    setPreviewError(null);
    setPreviewResponse(null);
    setShowForm(true);
  }

  React.useImperativeHandle(
    ref,
    () => ({
      openFor: (featureKey: string) => {
        setForm({
          featureKey,
          effect: "GRANT",
          kind: "COMP",
          reason: "",
          expiryPreset: defaultExpiryFor("COMP"),
          expiryTouched: false,
        });
        setPreviewError(null);
        setPreviewResponse(null);
        setShowForm(true);
      },
    }),
    [],
  );

  /** Step 1 of preview → confirm → apply: previews the override, writes nothing. Every override
   * write goes through this — both "+ New Override" and the console's "Customise" action. */
  async function handlePreview(e: React.FormEvent) {
    e.preventDefault();
    setPreviewing(true);
    setPreviewError(null);
    try {
      const expiresAt =
        form.expiryPreset === "none"
          ? null
          : new Date(Date.now() + Number(form.expiryPreset) * 24 * 60 * 60 * 1000).toISOString();
      const payload = {
        featureKey: form.featureKey,
        effect: form.effect,
        kind: form.kind,
        reason: form.reason,
        expiresAt,
      };
      const response = await previewTenantFeatures(tenant.id, { overrides: [payload] });
      setPendingCreate(payload);
      setPreviewResponse(response);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string | string[] } } };
      const message = err?.response?.data?.message;
      setPreviewError(
        Array.isArray(message)
          ? message.join("; ")
          : (message ?? "Could not preview that override. Try again."),
      );
    } finally {
      setPreviewing(false);
    }
  }

  /** Step 2: the actual write, run only after preview and an explicit Confirm. */
  async function handleConfirmCreate() {
    if (!pendingCreate) return;
    setSubmitting(true);
    setPreviewError(null);
    try {
      // B524 prep: this form has no missing-requires warning UI yet (unlike EnableAddonModal's
      // amber-box + checkbox), so there is nothing here for an operator to ever acknowledge —
      // omit `acknowledgeUnmetRequires` entirely rather than hardcoding `false`, which would
      // audit-log "the operator acknowledged nothing" on every single override create and assert
      // a user action that never happened. Mirrors how EnableAddonModal/enableTenantAddon only
      // ever include the field when an operator actually ticked the warning's checkbox (see
      // `features.ts`'s `...(acknowledgeUnmetRequires ? { acknowledgeUnmetRequires } : {})`).
      // The full parity UI (effectiveKeys fetch + missingRequires computation + warning box +
      // real acknowledgment state) is tracked as its own follow-up; only then does this form gain
      // something to conditionally include.
      await superAdminClient.post(
        `/platform-admin/tenants/${tenant.id}/feature-overrides`,
        pendingCreate,
      );
      setPreviewResponse(null);
      setPendingCreate(null);
      setShowForm(false);
      fetchOverrides();
    } catch (e: unknown) {
      // Opus review of 8130b204, item 7c: a class-validator 400 (e.g. EXPIRES_AT_MUST_BE_FUTURE,
      // or a DTO field failing multiple rules) sends `message` as string[], not string — join it
      // into one readable line rather than rendering an array where text is expected.
      const err = e as { response?: { data?: { message?: string | string[] } } };
      const message = err?.response?.data?.message;
      setPreviewError(
        Array.isArray(message)
          ? message.join("; ")
          : (message ?? "Could not create that override. Try again."),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(id: string) {
    setRevokingId(id);
    try {
      await superAdminClient.post(
        `/platform-admin/tenants/${tenant.id}/feature-overrides/${id}/revoke`,
      );
      fetchOverrides();
    } catch {
      setError("Could not revoke that override. Try again.");
    } finally {
      setRevokingId(null);
    }
  }

  const activeOverrides = overrides.filter((o) => !o.revokedAt);
  const selectedRegistryEntry = registry.find((r) => r.key === form.featureKey);

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-300">Overrides</h3>
        <button
          onClick={openForm}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
        >
          + New override
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-lg bg-red-900/30 px-4 py-3 text-sm text-red-300 ring-1 ring-red-600/30">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-8 text-center text-slate-400">Loading overrides…</div>
      ) : (
        <div className="rounded-xl bg-slate-800 ring-1 ring-white/5 overflow-hidden">
          <div
            className="overflow-x-auto"
            role="region"
            aria-label="Feature overrides"
            tabIndex={0}
          >
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-400">
                  <th className="px-4 py-3 text-left">Feature key</th>
                  <th className="px-4 py-3 text-left">Effect</th>
                  <th className="px-4 py-3 text-left">Reason</th>
                  <th className="px-4 py-3 text-left">Expires</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {activeOverrides.map((o) => {
                  const expired = o.expiresAt
                    ? new Date(o.expiresAt).getTime() <= Date.now()
                    : false;
                  return (
                    <tr key={o.id} className="hover:bg-slate-700/20">
                      <td className="px-4 py-2 font-mono text-slate-300">{o.featureKey}</td>
                      <td className="px-4 py-2">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            o.effect === "GRANT"
                              ? "bg-emerald-500/20 text-emerald-300"
                              : "bg-red-500/20 text-red-300"
                          }`}
                        >
                          {o.effect === "GRANT" ? "Grant" : "Deny"}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-slate-400" title={o.reason}>
                        {o.reason}
                      </td>
                      <td className="px-4 py-2 text-slate-400">
                        {o.expiresAt ? new Date(o.expiresAt).toLocaleDateString() : "Standing"}
                      </td>
                      <td className="px-4 py-2">
                        {expired ? (
                          <span className="text-amber-400">Expired</span>
                        ) : (
                          <span className="text-emerald-400">Active</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <button
                          disabled={revokingId === o.id}
                          onClick={() => handleRevoke(o.id)}
                          className="rounded px-2 py-1 text-slate-400 hover:bg-slate-700 hover:text-white disabled:opacity-50"
                        >
                          {revokingId === o.id ? "Revoking…" : "Revoke"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {activeOverrides.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-slate-400">
                      No active overrides.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Only one of these two AdminModals is ever open at a time (never stacked) — the form
          hides while the preview is up, so Escape always closes exactly the top dialog. */}
      <AdminModal
        open={showForm && !previewResponse}
        onClose={closeForm}
        title="New feature override"
        footer={
          <>
            <button
              onClick={closeForm}
              className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="feature-override-form"
              disabled={previewing || !form.featureKey || !form.reason}
              aria-describedby={
                !form.featureKey || !form.reason ? "feature-override-hint" : undefined
              }
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {previewing ? "Loading preview…" : "Preview override"}
            </button>
          </>
        }
      >
        <form id="feature-override-form" onSubmit={handlePreview} className="flex flex-col gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Feature key</label>
            <select
              ref={featureKeySelectRef}
              aria-label="Feature key"
              value={form.featureKey}
              onChange={(e) => setForm((f) => ({ ...f, featureKey: e.target.value }))}
              className="h-9 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
            >
              <option value="" disabled>
                Select a feature key…
              </option>
              {registry.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label} ({r.key}){r.internal ? " — internal" : ""}
                </option>
              ))}
            </select>
            {selectedRegistryEntry?.gate?.via === "none" && (
              <p className="mt-1 text-xs text-amber-400">
                This key has no wired gate (catalog metadata only) — an override here will have no
                effect.
              </p>
            )}
            {form.featureKey === "flag.credit_limits" && (
              <p className="mt-1 text-xs text-amber-400">
                Polarity trap: holding this flag TURNS ON the customer credit-limit check. GRANT
                enforces the limit; DENY disables it (removes a financial safety check), not the
                other way around.
              </p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Effect</label>
            <select
              aria-label="Effect"
              value={form.effect}
              onChange={(e) =>
                setForm((f) => ({ ...f, effect: e.target.value as "GRANT" | "DENY" }))
              }
              className="h-9 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
            >
              <option value="GRANT">Grant</option>
              <option value="DENY">Deny</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Kind</label>
            <select
              aria-label="Kind"
              value={form.kind}
              onChange={(e) =>
                setForm((f) => {
                  const kind = e.target.value as FeatureOverrideKind;
                  return {
                    ...f,
                    kind,
                    expiryPreset: f.expiryTouched ? f.expiryPreset : defaultExpiryFor(kind),
                  };
                })
              }
              className="h-9 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
            >
              {FEATURE_OVERRIDE_KIND_VALUES.map((k) => (
                <option key={k} value={k}>
                  {OVERRIDE_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Reason</label>
            <textarea
              aria-label="Reason"
              value={form.reason}
              onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
              rows={3}
              className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              placeholder="Why does this override exist?"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Expires</label>
            <select
              aria-label="Expires"
              value={form.expiryPreset}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  expiryPreset: e.target.value as ExpiryPreset,
                  expiryTouched: true,
                }))
              }
              aria-describedby={form.expiryPreset === "none" ? "override-no-end-note" : undefined}
              className="h-9 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
            >
              {expiryOptions(Date.now()).map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            {form.expiryPreset === "none" && (
              <p id="override-no-end-note" className="mt-1 text-xs text-slate-400">
                This stays on until someone revokes it.
              </p>
            )}
          </div>

          {previewError && !previewResponse && (
            <p className="text-xs text-red-400">{previewError}</p>
          )}
          <DisabledHint id="feature-override-hint" show={!form.featureKey || !form.reason}>
            Choose a feature and enter a reason to enable Preview override.
          </DisabledHint>
        </form>
      </AdminModal>

      <PreviewDrawer
        open={!!previewResponse}
        title="Preview override"
        response={previewResponse}
        registryByKey={Object.fromEntries(registry.map((r) => [r.key, r]))}
        confirming={submitting}
        error={previewResponse ? previewError : null}
        onConfirm={handleConfirmCreate}
        onClose={() => {
          setPreviewResponse(null);
          setPendingCreate(null);
          setPreviewError(null);
        }}
      />
    </div>
  );
});
FeatureOverridesSection.displayName = "FeatureOverridesSection";
