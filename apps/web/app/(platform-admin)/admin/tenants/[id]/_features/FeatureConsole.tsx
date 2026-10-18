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
import { BADGE_COLORS, deriveReadout, type StateReadout } from "./badge";
import {
  blockedReason,
  explainModeSentence,
  isOptionBlocked,
  modeLabel,
  modeSourceLabel,
  selectableOptions,
  MIXED_LABEL,
} from "./mode-utils";
import { PreviewDrawer } from "./PreviewDrawer";
import { EnableAddonModal } from "./EnableAddonModal";
import { currentRoleIsSuperAdmin } from "./super-admin";
import type {
  EffectiveFeature,
  EntitlementsMode,
  FeatureModeOption,
  FeaturePreviewResponse,
  FeatureRegistryRow,
} from "./types";

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

interface RequirementStatus {
  satisfied: boolean;
  missingAllOf: string[];
  unmetAnyOf: string[] | null;
}

/** B519: read straight off the registry row's `requires` — never a hardcoded key list. */
function checkRequires(
  requires: FeatureRegistryRow["requires"],
  effectiveKeys: ReadonlySet<string>,
): RequirementStatus {
  const missingAllOf = (requires?.allOf ?? []).filter((k) => !effectiveKeys.has(k));
  const anyOf = requires?.anyOf;
  const anyOfSatisfied = !anyOf || anyOf.length === 0 || anyOf.some((k) => effectiveKeys.has(k));
  return {
    satisfied: missingAllOf.length === 0 && anyOfSatisfied,
    missingAllOf,
    unmetAnyOf: anyOfSatisfied ? null : [...anyOf],
  };
}

/** Human-readable phrase for what's unmet, resolving registry keys to their labels.
 *  `undefined` when satisfied — callers use that to decide whether to warn at all. */
function describeUnmetRequirement(
  status: RequirementStatus,
  registryByKey: Record<string, FeatureRegistryRow>,
): string | undefined {
  if (status.satisfied) return undefined;
  const label = (key: string) => registryByKey[key]?.label ?? key;
  const parts: string[] = [];
  if (status.missingAllOf.length > 0) parts.push(status.missingAllOf.map(label).join(" and "));
  if (status.unmetAnyOf) parts.push(status.unmetAnyOf.map(label).join(" or "));
  return parts.join(" and ");
}

export interface FeatureConsoleProps {
  /** `planKey` is the resolved plan (what the header and Overview show); `plan` is the legacy enum
   *  and is only the fallback when there is no planKey (BO-10). */
  tenant: { id: string; plan: string; planKey?: string | null };
  /** Shown in the "Enable as add-on" modal's two-step confirm; falls back to `tenant.id`. */
  tenantLabel?: string;
  /** Calls the page's EXISTING plan-change action (`handleAction("change-plan", { plan })`) —
   * never a second path. */
  onChangePlan: (plan: string) => Promise<void> | void;
  changePlanLoading?: boolean;
  /** Opens #795's FeatureOverridesSection drawer, prefilled for this key ("Customise"). */
  onCustomise: (featureKey: string) => void;
}

/** "Set override": a quiet link-button, no fill, so the only filled indigo buttons on the page are
 *  real primaries (BO-09). 44 px tall below md, 24 px from md up. */
const QUIET_ACTION =
  "inline-flex min-h-11 items-center rounded px-2 py-1 text-xs font-semibold text-indigo-300 hover:text-indigo-200 hover:underline md:min-h-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800";
/** "Turn on as add-on": an outlined secondary, no fill (BO-09). */
const OUTLINED_ACTION =
  "inline-flex min-h-11 items-center rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-200 ring-1 ring-slate-500 hover:bg-slate-700 md:min-h-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800";

/** The dark-gate note, shown in the Details panel (BO-12). */
const DARK_NOTE =
  "Not enforced yet. This check only logs a warning when it would refuse the feature, and still allows it.";
/** Release stage, in plain words, shown in the Details panel (BO-12). */
const RELEASE_STAGE: Record<string, string> = {
  ga: "Release stage: Released.",
  beta: "Release stage: Beta. Released for testing and may still change.",
  proposed: "Release stage: Planned. Not released yet, and nothing relies on it today.",
  deprecated: "Release stage: Being phased out. Avoid turning it on for new businesses.",
  sunset: "Release stage: Retired. No longer offered.",
};
/** The only lifecycle stages worth a word on the row itself (muted plain text, not a chip). */
const LIFECYCLE_WORD: Record<string, string> = {
  deprecated: "Being phased out",
  sunset: "Retired",
};
const NOT_REPORTED_NOTE = "The server did not report a state for this feature.";

/** The Details toggle: quiet, 44 px tall below md (BO-09 tap rules). */
const DETAILS_TOGGLE =
  "inline-flex min-h-11 items-center rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-700 hover:text-white md:min-h-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-800";

export function FeatureConsole({
  tenant,
  tenantLabel,
  onChangePlan,
  changePlanLoading,
  onCustomise,
}: FeatureConsoleProps) {
  const [enabling, setEnabling] = React.useState<{
    addonKey: string;
    label: string;
    unmetRequirement?: string;
  } | null>(null);
  const [registry, setRegistry] = React.useState<FeatureRegistryRow[] | null>(null);
  const [effective, setEffective] = React.useState<EffectiveFeature[] | null>(null);
  const [entitlementsMode, setEntitlementsMode] = React.useState<EntitlementsMode | null>(null);
  const [diffCount, setDiffCount] = React.useState<number | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [showInternal, setShowInternal] = React.useState(false);
  const [openWhy, setOpenWhy] = React.useState<string | null>(null);

  const currentPlan = tenant.planKey ?? tenant.plan;
  const [selectedPlan, setSelectedPlan] = React.useState(currentPlan);
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
    setSelectedPlan(currentPlan);
  }, [currentPlan]);

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
    if (!keys.includes(currentPlan)) keys.push(currentPlan);
    return keys;
  }, [currentPlan]);

  // Every hook above runs unconditionally on every render (rules-of-hooks) — the SUPER_ADMIN
  // gate and the loading/error/empty early returns come only after all of them are declared.
  if (!currentRoleIsSuperAdmin()) {
    return (
      <p className="text-sm text-slate-400">Feature console is available to super admins only.</p>
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
    return <div className="py-8 text-center text-slate-400">Loading feature console...</div>;
  }

  if (loadError) {
    return (
      <div
        role="alert"
        className="rounded-lg bg-red-900/40 px-4 py-3 text-sm text-red-400 ring-1 ring-red-700"
      >
        {loadError}
      </div>
    );
  }

  if (!registry || registry.length === 0) {
    return (
      <div className="rounded-lg bg-slate-800 px-4 py-8 text-center text-sm text-slate-400 ring-1 ring-white/5">
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
                {p === currentPlan ? " — current" : ""}
              </option>
            ))}
          </select>
          <button
            disabled={selectedPlan === currentPlan || previewLoading || changePlanLoading}
            onClick={startTierPreview}
            className="rounded-lg bg-slate-600 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-500 disabled:opacity-50"
          >
            {changePlanLoading
              ? "Applying..."
              : previewLoading
                ? "Loading preview..."
                : "Preview plan change"}
          </button>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-400">
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
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
            {area}
          </h3>
          <div className="flex flex-col gap-2">
            {rows.map((row) => {
              const feature = effectiveByKey[row.key];
              // A free configuration row (no plan flag or add-on gates it): its answer is the applied
              // mode and where it came from, never on/off or "inherited from the plan" (B1132).
              const appliedMode =
                row.config && row.gate.via === "none" && feature?.mode ? feature.mode : null;
              const unmetRequirement = describeUnmetRequirement(
                checkRequires(row.requires, effectiveKeys),
                registryByKey,
              );
              const isOpen = openWhy === row.key;
              const lifecycleWord = LIFECYCLE_WORD[row.lifecycle];
              return (
                <div
                  key={row.key}
                  className="rounded-xl bg-slate-800 p-4 ring-1 ring-white/5"
                  data-feature-key={row.key}
                  id={`feature-${row.key}`}
                >
                  <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between lg:gap-3">
                    <div>
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-sm font-semibold text-white">{row.label}</span>
                        {appliedMode ? (
                          <span data-testid="readout" className="text-xs">
                            <span data-testid="applied-mode" className="font-medium text-slate-200">
                              {modeLabel(row.config?.modes ?? [], appliedMode.effective)}
                            </span>{" "}
                            <span data-testid="applied-mode-source" className="text-slate-400">
                              · {modeSourceLabel(appliedMode)}
                            </span>
                          </span>
                        ) : (
                          <StateReadoutText readout={deriveReadout(row.gate, feature)} />
                        )}
                        {lifecycleWord && (
                          <span className="text-xs text-slate-400">· {lifecycleWord}</span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-slate-400">{row.description}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => setOpenWhy(isOpen ? null : row.key)}
                        className={DETAILS_TOGGLE}
                        aria-expanded={isOpen}
                        aria-controls={`why-panel-${row.key}`}
                        aria-label={`Details for ${row.label}`}
                      >
                        Details
                      </button>
                      {row.gate.via !== "none" && (
                        <button
                          onClick={() => onCustomise(row.key)}
                          className={QUIET_ACTION}
                          aria-label={`Set override ${row.label}`}
                        >
                          Set override
                        </button>
                      )}
                      {ADDON_ROW_KEY_BY_REGISTRY_KEY[row.key] && (
                        <button
                          onClick={() =>
                            setEnabling({
                              addonKey: ADDON_ROW_KEY_BY_REGISTRY_KEY[row.key],
                              label: row.label,
                              unmetRequirement,
                            })
                          }
                          className={OUTLINED_ACTION}
                          aria-label={`Turn on ${row.label} as an add-on`}
                        >
                          Turn on as add-on
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Gated on the reported mode, not on `serving`: a gate-less config row (fulfilment_model)
                      reports serving:false yet is still settable. The server refuses delivery/both
                      without a fleet (FeatureConfigService.set). */}
                  {row.config && feature?.mode && (feature.serving || row.gate.via === "none") && (
                    <ModeSelector
                      featureKey={row.key}
                      label={row.label}
                      options={row.config.modes}
                      mode={feature.mode}
                      effectiveKeys={effectiveKeys}
                      disabled={previewLoading}
                      onSelect={(newMode) => startModePreview(row.key, newMode)}
                    />
                  )}

                  {/* Always mounted so aria-controls points at a real element; opening it never
                      moves focus. After the mode radios, full width (BO-12 U8, U9, D5). */}
                  <div
                    id={`why-panel-${row.key}`}
                    hidden={!isOpen}
                    className="mt-3 rounded-lg bg-slate-900/50 p-3 text-xs text-slate-300 ring-1 ring-white/5"
                  >
                    {isOpen && (
                      <>
                        <p>
                          {!feature
                            ? NOT_REPORTED_NOTE
                            : appliedMode
                              ? explainModeSentence(row.config?.modes ?? [], appliedMode)
                              : explainSentence(feature)}
                        </p>
                        {row.gate.via === "none" && !row.config && (
                          <p className="mt-2">
                            Nothing checks this setting yet, so an override would have no effect.
                          </p>
                        )}
                        {feature && !appliedMode && feature.resolver !== feature.serving && (
                          <p className="mt-2 text-amber-300">
                            Note: the new resolver disagrees — it would say this is{" "}
                            {feature.resolver ? "ON" : "OFF"}. Still in preview mode, so nothing
                            changes for customers yet.
                          </p>
                        )}
                        {RELEASE_STAGE[row.lifecycle] && (
                          <p className="mt-2">{RELEASE_STAGE[row.lifecycle]}</p>
                        )}
                        {row.gate.state === "dark" && <p className="mt-2">{DARK_NOTE}</p>}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <PreviewDrawer
        open={!!pending}
        title={pending?.kind === "tier" ? "Preview plan change" : "Preview mode change"}
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
        unmetRequirement={enabling?.unmetRequirement}
        onCustomise={onCustomise}
        onEnabled={load}
      />
    </div>
  );
}

// ─── State readout ─────────────────────────────────────────────────────────────

/** The one state readout on a row: plain visible text, no tooltip, no aria-label, no hidden copy,
 *  so the state is read once. Only a readout that carries a source colour is a 10 px chip. */
function StateReadoutText({ readout }: { readout: StateReadout }) {
  const style =
    readout.kind === "chip" && readout.badge
      ? `rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ${BADGE_COLORS[readout.badge]}`
      : readout.kind === "not-reported" || readout.kind === "not-enforced"
        ? "text-xs text-amber-300"
        : readout.kind === "on"
          ? "text-xs text-emerald-400"
          : "text-xs text-slate-400";
  return (
    <span data-testid="readout" className={style}>
      {readout.text}
    </span>
  );
}

// ─── Mode selector ─────────────────────────────────────────────────────────────

function ModeSelector({
  featureKey,
  label,
  options,
  mode,
  effectiveKeys,
  disabled,
  onSelect,
}: {
  featureKey: string;
  label: string;
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
      <span className="text-xs text-slate-400">Mode:</span>
      {isMixed && (
        <span className="rounded bg-purple-900/40 px-1.5 py-0.5 text-[10px] font-medium text-purple-300 ring-1 ring-purple-600/30">
          {MIXED_LABEL}
        </span>
      )}
      <div role="radiogroup" aria-label={`${label} mode`} className="flex flex-wrap gap-3">
        {radios.map((option) => {
          const blocked = isOptionBlocked(option, mode);
          const checked = !isMixed && mode.effective === option.key;
          return (
            <label
              key={option.key}
              title={blocked ? (blockedReason(option, effectiveKeys) ?? undefined) : undefined}
              className={`flex items-center gap-1.5 text-xs ${
                blocked ? "cursor-not-allowed text-slate-400" : "text-slate-300"
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
