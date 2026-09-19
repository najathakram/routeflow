"use client";

import * as React from "react";
import { fetchFeatureRegistry, previewTenantFeatures } from "@/lib/platform-admin/features";
import { PreviewDrawer } from "./PreviewDrawer";
import type { RegistryLabelLookup } from "./preview-groups";
import type { FeaturePreviewResponse } from "./types";

/**
 * The tenant header's plan select + "Change Plan" button (B539). It used to call the change-plan
 * action directly — no preview at all. It now runs the same non-mutating preview the Feature
 * Console's tier control uses, shows the Gained / Lost diff in the shared
 * `PreviewDrawer`, and only applies on Confirm. `onChangePlan` is the page's existing
 * `change-plan` action; it rejects on failure so the drawer stays open with the error.
 */
export function TierChangeControl({
  tenantId,
  currentPlan,
  plans,
  planLabel,
  onChangePlan,
  disabled,
}: {
  tenantId: string;
  currentPlan: string;
  plans: readonly string[];
  planLabel: (plan: string) => string;
  onChangePlan: (plan: string) => Promise<void> | void;
  disabled?: boolean;
}) {
  const [selectedPlan, setSelectedPlan] = React.useState(currentPlan);
  const [pending, setPending] = React.useState<{
    planKey: string;
    response: FeaturePreviewResponse;
  } | null>(null);
  const [registryByKey, setRegistryByKey] = React.useState<RegistryLabelLookup>({});
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [applying, setApplying] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // After a confirmed change the tenant is refetched with its new plan — follow it.
  React.useEffect(() => setSelectedPlan(currentPlan), [currentPlan]);

  async function startPreview() {
    setError(null);
    setPreviewLoading(true);
    try {
      const [response, registry] = await Promise.all([
        previewTenantFeatures(tenantId, { planKey: selectedPlan }),
        // Labels are a nicety: if the registry cannot be read, the raw feature keys still show.
        fetchFeatureRegistry().catch(() => []),
      ]);
      setRegistryByKey(Object.fromEntries(registry.map((r) => [r.key, { label: r.label }])));
      setPending({ planKey: selectedPlan, response });
    } catch {
      setError("Could not preview that plan change. Try again.");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function confirm() {
    if (!pending) return;
    setError(null);
    setApplying(true);
    try {
      await onChangePlan(pending.planKey);
      setPending(null);
    } catch {
      setError("Could not apply that change. Try again.");
    } finally {
      setApplying(false);
    }
  }

  function close() {
    setPending(null);
    setError(null);
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <select
          aria-label="New plan"
          value={selectedPlan}
          onChange={(e) => setSelectedPlan(e.target.value)}
          className="h-9 rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
        >
          {plans.map((p) => (
            <option key={p} value={p}>
              {planLabel(p)}
            </option>
          ))}
        </select>
        <button
          disabled={disabled || previewLoading || selectedPlan === currentPlan}
          onClick={startPreview}
          className="rounded-lg bg-slate-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-500 disabled:opacity-50"
        >
          {previewLoading ? "Loading preview..." : "Change Plan"}
        </button>
      </div>
      {/* A failed preview never opens the drawer, so its error has to show here. */}
      {error && !pending && (
        <p role="alert" className="basis-full text-sm text-red-400">
          {error}
        </p>
      )}
      <PreviewDrawer
        open={!!pending}
        title="Preview tier change"
        subtitle={pending ? `${planLabel(currentPlan)} → ${planLabel(pending.planKey)}` : undefined}
        allowEmptyConfirm
        emptyMessage="No feature differences — this plan change does not turn any feature on or off. The plan itself (and its price and allowances) still changes when you confirm."
        note="Seat, route, customer and monthly-price allowances are not part of this preview."
        response={pending?.response ?? null}
        registryByKey={registryByKey}
        confirming={applying}
        error={error}
        onConfirm={confirm}
        onClose={close}
      />
    </>
  );
}
