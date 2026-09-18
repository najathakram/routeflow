"use client";

import * as React from "react";
import { PLAN_KEYS } from "@routeflow/types";
import { planLabel } from "../../../../_components/AdminBadge";
import {
  fetchEntitlementsMode,
  fetchFeatureRegistry,
  fetchTenantFeatureDiffs,
  fetchTenantFeaturesEffective,
  previewTenantFeatures,
  writeTenantFeatureConfig,
} from "@/lib/platform-admin/features";
import { BADGE_COLORS, BADGE_LABELS, deriveBadge } from "./badge";
import { blockedReason, isOptionBlocked, selectableOptions, MIXED_LABEL } from "./mode-utils";
import { PreviewDrawer } from "./PreviewDrawer";
import { EnableAddonModal } from "./EnableAddonModal";
import type {
  EffectiveFeature,
  EntitlementsMode,
  FeatureModeOption,
  FeaturePreviewResponse,
  FeatureRegistryRow,
} from "./types";

/** Best-effort client-side check — the real gate is the server + the route's SuperAdminGuard. */
function currentRoleIsSuperAdmin(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const token = window.localStorage.getItem("superAdminToken");
    if (!token) return false;
    const part = token.split(".")[1];
    if (!part) return false;
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return payload?.role === "SUPER_ADMIN";
  } catch {
    return false;
  }
}

type PendingPreview =
  | { kind: "tier"; planKey: string; response: FeaturePreviewResponse }
  | { kind: "mode"; featureKey: string; newMode: string; response: FeaturePreviewResponse };

/**
 * Registry rows the console can provision as a real, billable `TenantAddon` row via
 * `POST /addons/enable` (B2b) — the value is the legacy `addonKey` that endpoint expects,
 * which is NOT always the registry row's own key. Six of these are `RequireAddon`/`guard`
 * rows keyed identically to their addonKey. `flag.msrp`/`flag.sales_agents` are
 * `RequirePlanFlag` rows whose SERVER gate a "Customise" override on the flag key would
 * satisfy — but their web-side UI (the MSRP price field, the sales-agents nav item) reads
 * `useHasAddon()`, which checks the literal `TenantAddon.addonKey` list and never sees a
 * feature-override. Without this addon-row path those two keys have NO working "on" switch
 * once the legacy AVAILABLE_ADDONS toggle cards are deleted (review catch, 2026-09-17) — an
 * override would look like it worked (the route gate passes) while the UI stayed hidden.
 *
 * Mirrors `LEGACY_ADDON_KEY_TO_SKU` in `apps/api/src/billing/plan-catalog.constants.ts` (the
 * server's addonKey -> Stripe SKU bridge for these same legacy keys) — update both together.
 * This map is hardcoded, not derived from the registry (no "gate kind"/legacy-addonKey field
 * exists there yet — a future SHARED ticket across packages/types + apps/api could add one),
 * so a 9th flag-gated key needing this path will NOT light up here automatically; the pinned
 * test below (`FeatureConsole.test.tsx`) fails loudly if this map's contents drift instead.
 */
export const ADDON_ROW_KEY_BY_REGISTRY_KEY: Readonly<Record<string, string>> = {
  tobacco_dealer: "tobacco_dealer",
  driver_payments: "driver_payments",
  recurring_routes: "recurring_routes",
  order_delivery: "order_delivery",
  ocr: "ocr",
  developer_mode: "developer_mode",
  "flag.msrp": "msrp",
  "flag.sales_agents": "sales_agents",
};

export interface FeatureConsoleProps {
  tenant: { id: string; plan: string };
  /** Shown in the "Enable as add-on" modal's two-step confirm; falls back to `tenant.id`. */
  tenantLabel?: string;
  /** Calls the page's EXISTING plan-change action (`handleAction("change-plan", { plan })`) —
   * never a second path. */
  onChangePlan: (plan: string) => Promise<void> | void;
  changePlanLoading?: boolean;
  /** Opens #795's FeatureOverridesSection drawer, prefilled for this key ("Customise"). */
  onCustomise: (featureKey: string) => void;
}

export function FeatureConsole({
  tenant,
  tenantLabel,
  onChangePlan,
  changePlanLoading,
  onCustomise,
}: FeatureConsoleProps) {
  const [enabling, setEnabling] = React.useState<{ addonKey: string; label: string } | null>(null);
  const [registry, setRegistry] = React.useState<FeatureRegistryRow[] | null>(null);
  const [effective, setEffective] = React.useState<EffectiveFeature[] | null>(null);
  const [entitlementsMode, setEntitlementsMode] = React.useState<EntitlementsMode | null>(null);
  const [diffCount, setDiffCount] = React.useState<number | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [showInternal, setShowInternal] = React.useState(false);
  const [openWhy, setOpenWhy] = React.useState<string | null>(null);

  const [selectedPlan, setSelectedPlan] = React.useState(tenant.plan);
  const [pending, setPending] = React.useState<PendingPreview | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [applying, setApplying] = React.useState(false);

  const load = React.useCallback(() => {
    setLoading(true);
    setLoadError(null);
    Promise.all([
      fetchFeatureRegistry(),
      fetchTenantFeaturesEffective(tenant.id),
      fetchTenantFeatureDiffs(tenant.id),
      fetchEntitlementsMode().catch(() => ({ mode: null as EntitlementsMode | null })),
    ])
      .then(([reg, eff, diffs, mode]) => {
        // Defensive against a future contract-shape drift like the one caught here: an
        // API response that isn't a plain array must never freeze the console mid-render
        // (`(effective ?? []).map(...)` below would throw on a non-array with no error
        // boundary to catch it) — fail into the existing error state instead.
        if (!Array.isArray(reg) || !Array.isArray(eff) || !Array.isArray(diffs)) {
          setLoadError("Could not load the feature console. Try again.");
          return;
        }
        setRegistry(reg);
        setEffective(eff);
        setDiffCount(diffs.filter((d) => !d.explainedAt).length);
        setEntitlementsMode(mode.mode);
      })
      .catch(() => setLoadError("Could not load the feature console. Try again."))
      .finally(() => setLoading(false));
  }, [tenant.id]);

  React.useEffect(() => {
    load();
  }, [load]);

  React.useEffect(() => {
    setSelectedPlan(tenant.plan);
  }, [tenant.plan]);

  const registryByKey = React.useMemo(
    () => Object.fromEntries((registry ?? []).map((r) => [r.key, r])),
    [registry],
  );
  const effectiveByKey = React.useMemo(
    () => Object.fromEntries((effective ?? []).map((f) => [f.key, f])),
    [effective],
  );
  const effectiveKeys = React.useMemo(
    () => new Set((effective ?? []).filter((f) => f.serving).map((f) => f.key)),
    [effective],
  );

  const visibleRows = (registry ?? []).filter((r) => showInternal || !r.internal);
  const groups = React.useMemo(() => {
    const byArea = new Map<string, FeatureRegistryRow[]>();
    for (const row of visibleRows) {
      const list = byArea.get(row.area) ?? [];
      list.push(row);
      byArea.set(row.area, list);
    }
    return [...byArea.entries()];
  }, [visibleRows]);

  // PLAN_KEYS (@routeflow/types) is the canonical tier list; a tenant already sitting on a
  // legacy/off-catalog plan (e.g. "PROFESSIONAL", predates LITE) still needs its own current
  // tier selectable and visibly current, so it's appended when missing.
  const tierOptions = React.useMemo(() => {
    const keys: string[] = [...PLAN_KEYS];
    if (!keys.includes(tenant.plan)) keys.push(tenant.plan);
    return keys;
  }, [tenant.plan]);

  // Every hook above runs unconditionally on every render (rules-of-hooks) — the SUPER_ADMIN
  // gate and the loading/error/empty early returns come only after all of them are declared.
  if (!currentRoleIsSuperAdmin()) {
    return (
      <p className="text-sm text-slate-500">Feature console is available to super admins only.</p>
    );
  }

  async function startTierPreview() {
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      const response = await previewTenantFeatures(tenant.id, { planKey: selectedPlan });
      setPending({ kind: "tier", planKey: selectedPlan, response });
    } catch {
      setPreviewError("Could not preview that plan change. Try again.");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function startModePreview(featureKey: string, newMode: string) {
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      const response = await previewTenantFeatures(tenant.id, {
        modes: { [featureKey]: newMode },
      });
      setPending({ kind: "mode", featureKey, newMode, response });
    } catch {
      setPreviewError("Could not preview that mode change. Try again.");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function confirmPending() {
    if (!pending) return;
    setApplying(true);
    try {
      if (pending.kind === "tier") {
        await onChangePlan(pending.planKey);
      } else {
        await writeTenantFeatureConfig(tenant.id, pending.featureKey, {
          mode: pending.newMode,
          reason: `Mode set to "${pending.newMode}" via the tenant feature console.`,
        });
      }
      setPending(null);
      load();
    } catch {
      setPreviewError("Could not apply that change. Try again.");
    } finally {
      setApplying(false);
    }
  }

  if (loading) {
    return <div className="py-8 text-center text-slate-500">Loading feature console...</div>;
  }

  if (loadError) {
    return (
      <div className="rounded-lg bg-red-900/40 px-4 py-3 text-sm text-red-400 ring-1 ring-red-700">
        {loadError}
      </div>
    );
  }

  if (!registry || registry.length === 0) {
    return (
      <div className="rounded-lg bg-slate-800 px-4 py-8 text-center text-sm text-slate-500 ring-1 ring-white/5">
        No features are registered yet.
      </div>
    );
  }

  return (
    <div className="mb-8">
      {/* Header: tier picker + entitlements-mode / unexplained-diff indicator (read-only) */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-800 p-4 ring-1 ring-white/5">
        <div className="flex items-center gap-2">
          <label htmlFor="feature-console-tier" className="text-sm text-slate-400">
            Tier
          </label>
          <select
            id="feature-console-tier"
            value={selectedPlan}
            onChange={(e) => setSelectedPlan(e.target.value)}
            className="h-9 rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
          >
            {tierOptions.map((p) => (
              <option key={p} value={p}>
                {planLabel(p)}
                {p === "LITE" ? " (invite-only)" : ""}
                {p === tenant.plan ? " — current" : ""}
              </option>
            ))}
          </select>
          <button
            disabled={selectedPlan === tenant.plan || previewLoading || changePlanLoading}
            onClick={startTierPreview}
            className="rounded-lg bg-slate-600 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-500 disabled:opacity-50"
          >
            {changePlanLoading
              ? "Applying..."
              : previewLoading
                ? "Loading preview..."
                : "Preview tier change"}
          </button>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          {entitlementsMode === "shadow" && (
            <span className="rounded px-1.5 py-0.5 ring-1 ring-slate-600/40">
              Preview mode — no customer changes yet
            </span>
          )}
          {entitlementsMode === "live" && (
            <span className="rounded px-1.5 py-0.5 ring-1 ring-slate-600/40">
              Live — serving customers
            </span>
          )}
          {diffCount !== null && diffCount > 0 && (
            <span className="text-amber-400">
              {diffCount} change{diffCount === 1 ? "" : "s"} need a look
            </span>
          )}
          {diffCount === 0 && <span>No changes need a look</span>}
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={showInternal}
              onChange={(e) => setShowInternal(e.target.checked)}
            />
            Show internal
          </label>
        </div>
      </div>

      {/* Body: registry rows grouped by area */}
      {groups.map(([area, rows]) => (
        <div key={area} className="mb-6">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            {area}
          </h3>
          <div className="flex flex-col gap-2">
            {rows.map((row) => {
              const feature = effectiveByKey[row.key];
              const badge = feature ? deriveBadge(feature) : "unknown";
              return (
                <div
                  key={row.key}
                  className="rounded-xl bg-slate-800 p-4 ring-1 ring-white/5"
                  data-feature-key={row.key}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-white">{row.label}</span>
                        <span
                          data-testid="badge"
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ${BADGE_COLORS[badge]}`}
                        >
                          {BADGE_LABELS[badge]}
                        </span>
                        <span className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">
                          {row.lifecycle}
                        </span>
                        {row.gate.state === "dark" && (
                          <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] text-amber-300">
                            dark
                          </span>
                        )}
                        <span
                          className={
                            feature?.serving ? "text-emerald-400 text-xs" : "text-slate-500 text-xs"
                          }
                        >
                          {feature?.serving ? "On" : "Off"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-400">{row.description}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setOpenWhy(openWhy === row.key ? null : row.key)}
                        className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-700 hover:text-white"
                        aria-expanded={openWhy === row.key}
                        aria-controls={`why-panel-${row.key}`}
                        aria-label={`Why is ${row.label} on or off?`}
                      >
                        Why is this on/off?
                      </button>
                      <button
                        onClick={() => onCustomise(row.key)}
                        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                        aria-label={`Customise ${row.label}`}
                      >
                        Customise
                      </button>
                      {ADDON_ROW_KEY_BY_REGISTRY_KEY[row.key] && (
                        <button
                          onClick={() =>
                            setEnabling({
                              addonKey: ADDON_ROW_KEY_BY_REGISTRY_KEY[row.key],
                              label: row.label,
                            })
                          }
                          className="rounded-lg bg-slate-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-500"
                          aria-label={`Enable ${row.label} as an add-on`}
                        >
                          Enable as add-on
                        </button>
                      )}
                    </div>
                  </div>

                  {openWhy === row.key && feature && (
                    <div
                      id={`why-panel-${row.key}`}
                      className="mt-3 rounded-lg bg-slate-900/50 p-3 text-xs text-slate-300 ring-1 ring-white/5"
                    >
                      <p>{explainSentence(feature)}</p>
                      {feature.resolver !== feature.serving && (
                        <p className="mt-2 text-amber-300">
                          Note: the new resolver disagrees — it would say this is{" "}
                          {feature.resolver ? "ON" : "OFF"}. Still in preview mode, so nothing
                          changes for customers yet.
                        </p>
                      )}
                    </div>
                  )}

                  {row.config && feature?.serving && feature.mode && (
                    <ModeSelector
                      featureKey={row.key}
                      options={row.config.modes}
                      mode={feature.mode}
                      effectiveKeys={effectiveKeys}
                      disabled={previewLoading}
                      onSelect={(newMode) => startModePreview(row.key, newMode)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <PreviewDrawer
        open={!!pending}
        title={pending?.kind === "tier" ? "Preview tier change" : "Preview mode change"}
        response={pending?.response ?? null}
        registryByKey={registryByKey}
        confirming={applying}
        error={previewError}
        onConfirm={confirmPending}
        onClose={() => {
          setPending(null);
          setPreviewError(null);
        }}
      />

      <EnableAddonModal
        open={!!enabling}
        onClose={() => setEnabling(null)}
        tenantId={tenant.id}
        tenantLabel={tenantLabel ?? tenant.id}
        addonKey={enabling?.addonKey ?? ""}
        addonLabel={enabling?.label ?? ""}
        onEnabled={load}
      />
    </div>
  );
}

// ─── Mode selector ─────────────────────────────────────────────────────────────

function ModeSelector({
  featureKey,
  options,
  mode,
  effectiveKeys,
  disabled,
  onSelect,
}: {
  featureKey: string;
  options: FeatureModeOption[];
  mode: NonNullable<EffectiveFeature["mode"]>;
  effectiveKeys: ReadonlySet<string>;
  disabled?: boolean;
  onSelect: (newMode: string) => void;
}) {
  const radios = selectableOptions(options);
  const isMixed = mode.effective === "mixed";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-700 pt-3">
      <span className="text-xs text-slate-500">Mode:</span>
      {isMixed && (
        <span className="rounded bg-purple-900/40 px-1.5 py-0.5 text-[10px] font-medium text-purple-300 ring-1 ring-purple-600/30">
          {MIXED_LABEL}
        </span>
      )}
      <div role="radiogroup" aria-label={`${featureKey} mode`} className="flex flex-wrap gap-3">
        {radios.map((option) => {
          const blocked = isOptionBlocked(option, mode);
          const checked = !isMixed && mode.effective === option.key;
          return (
            <label
              key={option.key}
              title={blocked ? (blockedReason(option, effectiveKeys) ?? undefined) : undefined}
              className={`flex items-center gap-1.5 text-xs ${
                blocked ? "cursor-not-allowed text-slate-600" : "text-slate-300"
              }`}
            >
              <input
                type="radio"
                name={`mode-${featureKey}`}
                value={option.key}
                checked={checked}
                disabled={disabled || blocked}
                onChange={() => onSelect(option.key)}
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ─── Explain panel ─────────────────────────────────────────────────────────────

function explainSentence(feature: EffectiveFeature): string {
  const { source, detail, billing } = feature;
  switch (source) {
    case "OVERRIDE_DENY":
      return `This is OFF because an admin override removed it${detail.reason ? ` — "${detail.reason}"` : ""}.${
        detail.expiresAt ? ` Expires ${new Date(detail.expiresAt).toLocaleDateString()}.` : ""
      }`;
    case "OVERRIDE_GRANT":
      return `This is ON because an admin override added it (${detail.kind ?? "override"})${
        detail.reason ? ` — "${detail.reason}"` : ""
      }.${detail.expiresAt ? ` Expires ${new Date(detail.expiresAt).toLocaleDateString()}.` : ""}`;
    case "ADDON_SKU":
      return `This is ON because the tenant purchased it (${detail.sku ?? "add-on"})${
        billing.charged ? " — billed." : "."
      }`;
    case "PRESET":
      return `This is ON because it is included in the ${detail.planKey} plan${
        detail.term ? ` (${detail.term})` : ""
      }.`;
    case "NONE":
      return "This is OFF — not included in the current plan and no override grants it.";
    default:
      return "The server could not determine this feature's state (resolver error). Treating it as unchanged.";
  }
}
