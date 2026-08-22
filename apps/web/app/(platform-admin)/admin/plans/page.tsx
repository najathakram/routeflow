"use client";

import * as React from "react";
import { superAdminClient } from "@/lib/admin-api";
import { AdminCard } from "../../_components/AdminCard";
import {
  fetchPlanCatalog,
  updatePlanPrices,
  platformPricingErrorMessage,
  type PlanCatalogEntry,
} from "@/lib/api/platform-pricing";

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);

// ─── Row edit state ────────────────────────────────────────────────────────────

interface RowDraft {
  monthly: string;
  annual: string;
}

function draftFrom(plan: PlanCatalogEntry): RowDraft {
  return {
    monthly: plan.monthlyPrice ?? "",
    annual: plan.annualPrice ?? "",
  };
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function PlansPage() {
  const [planBreakdown, setPlanBreakdown] = React.useState<Record<string, number>>({});
  const [plans, setPlans] = React.useState<PlanCatalogEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [drafts, setDrafts] = React.useState<Record<string, RowDraft>>({});
  const [savingKey, setSavingKey] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<{ type: "success" | "error"; text: string } | null>(
    null,
  );

  const load = React.useCallback(() => {
    setLoading(true);
    setLoadError(null);
    Promise.all([
      superAdminClient.get("/platform-admin/stats").then((res) => res.data.planBreakdown ?? {}),
      fetchPlanCatalog().then((res) => res.plans),
    ])
      .then(([breakdown, catalogPlans]) => {
        const sorted = [...catalogPlans].sort((a, b) => a.sortOrder - b.sortOrder);
        setPlanBreakdown(breakdown);
        setPlans(sorted);
        setDrafts(Object.fromEntries(sorted.map((p) => [p.planKey, draftFrom(p)])));
      })
      .catch((err) => setLoadError(platformPricingErrorMessage(err, "Failed to load plans")))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const setDraft = (planKey: string, field: keyof RowDraft, value: string) => {
    setDrafts((prev) => ({ ...prev, [planKey]: { ...prev[planKey], [field]: value } }));
  };

  const saveRow = async (plan: PlanCatalogEntry) => {
    const draft = drafts[plan.planKey];
    if (!draft || draft.monthly.trim() === "") return;
    setSavingKey(plan.planKey);
    setToast(null);
    try {
      const result = await updatePlanPrices(plan.planKey, {
        monthly: Number(draft.monthly),
        annual: draft.annual.trim() === "" ? null : Number(draft.annual),
      });
      setToast({
        type: "success",
        text: `Saved ${plan.name} — ${result.updated} tenant${result.updated === 1 ? "" : "s"} updated, ${result.synced} synced to Stripe${result.failed ? `, ${result.failed} failed` : ""}.`,
      });
      load();
    } catch (err) {
      setToast({
        type: "error",
        text: platformPricingErrorMessage(err, `Failed to save ${plan.name}`),
      });
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Plans & Pricing</h1>
        <p className="mt-1 text-sm text-slate-400">
          Catalog prices for the latest plan version. Editing a row updates every tenant on that
          plan without a custom fee and pinned to the latest version — their live Stripe
          subscriptions sync automatically, from the next billing cycle.
        </p>
      </div>

      {toast && (
        <div
          className={`rounded-lg px-4 py-3 text-sm ring-1 break-words ${
            toast.type === "success"
              ? "bg-green-900/30 text-green-300 ring-green-700/50"
              : "bg-red-900/30 text-red-300 ring-red-700/50"
          }`}
        >
          {toast.text}
        </div>
      )}

      <AdminCard title="Catalog" noPadding>
        {loading ? (
          <p className="p-5 text-sm text-slate-500">Loading plans…</p>
        ) : loadError ? (
          <p className="p-5 text-sm text-red-400">{loadError}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-5 py-3 text-left">Plan</th>
                  <th className="px-5 py-3 text-left">Tenants</th>
                  <th className="px-5 py-3 text-left">Monthly (USD)</th>
                  <th className="px-5 py-3 text-left">Annual (USD)</th>
                  <th className="px-5 py-3 text-left"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {plans.map((plan) => {
                  const draft = drafts[plan.planKey] ?? draftFrom(plan);
                  const annualPlaceholder =
                    draft.monthly.trim() !== "" && !isNaN(Number(draft.monthly))
                      ? `= ${usd(Number(draft.monthly) * 10)} (10× monthly)`
                      : "= 10× monthly";
                  return (
                    <tr key={plan.planKey} className="hover:bg-slate-700/20">
                      <td className="px-5 py-3">
                        <div className="text-white">{plan.name}</div>
                        <div className="text-xs text-slate-500">
                          {plan.planKey}
                          {plan.isCustom ? " · custom-quoted" : ""}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-slate-400">
                        {planBreakdown[plan.planKey] ?? 0}
                      </td>
                      <td className="px-5 py-3">
                        <input
                          type="number"
                          min={0}
                          max={100000}
                          step="0.01"
                          value={draft.monthly}
                          onChange={(e) => setDraft(plan.planKey, "monthly", e.target.value)}
                          placeholder={plan.isCustom ? "Quoted per tenant" : "0.00"}
                          className="h-9 w-32 rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                        />
                      </td>
                      <td className="px-5 py-3">
                        <input
                          type="number"
                          min={0}
                          max={100000}
                          step="0.01"
                          value={draft.annual}
                          onChange={(e) => setDraft(plan.planKey, "annual", e.target.value)}
                          placeholder={annualPlaceholder}
                          className="h-9 w-40 rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                        />
                      </td>
                      <td className="px-5 py-3">
                        <button
                          type="button"
                          disabled={savingKey === plan.planKey || draft.monthly.trim() === ""}
                          onClick={() => saveRow(plan)}
                          className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-600 disabled:opacity-50"
                        >
                          {savingKey === plan.planKey ? "Saving…" : "Save"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>
    </div>
  );
}
