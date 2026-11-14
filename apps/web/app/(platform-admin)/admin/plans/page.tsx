"use client";

import * as React from "react";
import { superAdminClient } from "@/lib/admin-api";
import { AdminCard } from "../../_components/AdminCard";
import { planLabel } from "../../_components/AdminBadge";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  fetchPlanCatalog,
  fetchPlanPriceImpact,
  isPlanPriceImpactChanged,
  updatePlanPrices,
  platformPricingErrorMessage,
  type PlanCatalogEntry,
  type PlanPriceImpact,
} from "@/lib/api/platform-pricing";

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);

/** `$149` or `$149.50`: whole dollars stay whole, cents show only when there are some. */
const priceLabel = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(n);

const businesses = (n: number) => `${n} ${n === 1 ? "business" : "businesses"}`;

/** R24: the confirm's body. Who is re-priced, by how much in total, and who keeps their own price. */
function priceConfirmBody(i: PlanPriceImpact, changed = false): string {
  const parts: string[] = [];
  // SA-1100 §2: the count moved between the first look and Confirm; the admin reads the new number first.
  if (changed) parts.push("The number of businesses changed since you looked.");
  if (i.affected === 0) {
    parts.push("No business pays this price yet.");
  } else {
    parts.push(`This changes the bill for ${businesses(i.affected)} on their next renewal.`);
    const total = priceLabel(Math.abs(i.monthlyDelta));
    parts.push(
      i.monthlyDelta > 0
        ? `${total} more each month in total.`
        : i.monthlyDelta < 0
          ? `${total} less each month in total.`
          : "The monthly total stays the same.",
    );
  }
  if (i.ownPrice > 0) {
    parts.push(
      i.ownPrice === 1
        ? "1 with its own price is not affected."
        : `${i.ownPrice} with their own price are not affected.`,
    );
  }
  // UX guide B4: say what happens to live subscriptions (the server syncs them after the save).
  if (i.affected > 0) parts.push("Live Stripe subscriptions update from the next billing cycle.");
  return parts.join(" ");
}

interface PendingPriceChange {
  plan: PlanCatalogEntry;
  monthly: number;
  annual: number | null;
  impact: PlanPriceImpact;
  /** The server's 409: the count moved after the admin first looked, and this impact is the fresh one. */
  changed?: boolean;
}

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

/** Compare two price fields as numbers ("100" and "100.00" are the same price; blank is "none"). */
function samePrice(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (x === "" || y === "") return x === y;
  return Number(x) === Number(y);
}

/** UX guide B4: a row is dirty only when a price differs from the catalog's stored one. */
function isDirty(plan: PlanCatalogEntry, draft: RowDraft): boolean {
  const stored = draftFrom(plan);
  return !samePrice(draft.monthly, stored.monthly) || !samePrice(draft.annual, stored.annual);
}

/** The confirm's title: an annual-only change is not "from $100 to $100 a month". */
function priceConfirmTitle(p: PendingPriceChange): string {
  const monthlyChanged = p.monthly !== p.impact.currentMonthly;
  const storedAnnual = p.plan.annualPrice === null ? null : Number(p.plan.annualPrice);
  if (!monthlyChanged && p.annual !== storedAnnual) {
    const from = storedAnnual === null ? "none" : priceLabel(storedAnnual);
    const to = p.annual === null ? "none" : priceLabel(p.annual);
    return `Change ${p.plan.name} annual price from ${from} to ${to} a year?`;
  }
  return `Change ${p.plan.name} from ${priceLabel(p.impact.currentMonthly)} to ${priceLabel(p.monthly)} a month?`;
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function PlansPage() {
  const [planBreakdown, setPlanBreakdown] = React.useState<Record<string, number>>({});
  const [plans, setPlans] = React.useState<PlanCatalogEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [drafts, setDrafts] = React.useState<Record<string, RowDraft>>({});
  const [savingKey, setSavingKey] = React.useState<string | null>(null);
  // R24: the count is fetched before anything is saved; the PATCH only runs after Confirm.
  const [checkingKey, setCheckingKey] = React.useState<string | null>(null);
  const [checkFailedKey, setCheckFailedKey] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<PendingPriceChange | null>(null);
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

  const startSave = async (plan: PlanCatalogEntry) => {
    const draft = drafts[plan.planKey];
    if (!draft || draft.monthly.trim() === "") return;
    if (checkingKey || savingKey) return;
    const monthly = Number(draft.monthly);
    const annual = draft.annual.trim() === "" ? null : Number(draft.annual);
    setCheckingKey(plan.planKey);
    setCheckFailedKey(null);
    setToast(null);
    try {
      const impact = await fetchPlanPriceImpact(plan.planKey, monthly);
      setPending({ plan, monthly, annual, impact });
    } catch {
      // Fixed copy; a failed check blocks the confirm (nothing opens) and offers Retry.
      setCheckFailedKey(plan.planKey);
    } finally {
      setCheckingKey(null);
    }
  };

  const confirmSave = async () => {
    if (!pending || savingKey) return;
    const { plan, monthly, annual, impact } = pending;
    setSavingKey(plan.planKey);
    try {
      // SA-1100 §2: the PATCH carries the count the admin confirmed; the server re-checks it before any write.
      const result = await updatePlanPrices(plan.planKey, {
        monthly,
        annual,
        expectedAffected: impact.affected,
      });
      setToast({
        type: "success",
        text: `Saved ${plan.name} — ${result.updated} tenant${result.updated === 1 ? "" : "s"} updated, ${result.synced} synced to Stripe${result.failed ? `, ${result.failed} failed` : ""}.`,
      });
      load();
      setPending(null);
    } catch (err) {
      if (isPlanPriceImpactChanged(err)) {
        // Nothing was saved. Fetch the count again and keep the dialog open on the new number, so the
        // admin confirms what will really happen. If the fresh count cannot be read, never save blind.
        try {
          const fresh = await fetchPlanPriceImpact(plan.planKey, monthly);
          setPending({ plan, monthly, annual, impact: fresh, changed: true });
          return;
        } catch {
          setCheckFailedKey(plan.planKey);
          setPending(null);
          return;
        }
      }
      setToast({
        type: "error",
        text: platformPricingErrorMessage(err, `Failed to save ${plan.name}`),
      });
      setPending(null);
    } finally {
      setSavingKey(null);
    }
  };

  const checkFailedPlan = plans.find((p) => p.planKey === checkFailedKey);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Plans & pricing</h1>
        <p className="mt-1 text-sm text-slate-400">
          Catalog prices for the latest plan version. Editing a row updates every tenant on that
          plan without a custom fee and pinned to the latest version — their live Stripe
          subscriptions sync automatically, from the next billing cycle.
        </p>
      </div>

      {checkFailedPlan && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg bg-red-900/30 px-4 py-3 text-sm text-red-300 ring-1 ring-red-700/50"
        >
          <span>Couldn&apos;t check how many businesses this changes. Try again.</span>
          <button
            type="button"
            onClick={() => startSave(checkFailedPlan)}
            className="rounded-lg bg-slate-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-600"
          >
            Retry
          </button>
        </div>
      )}

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
          <p className="p-5 text-sm text-slate-400">Loading plans…</p>
        ) : loadError ? (
          <p className="p-5 text-sm text-red-400">{loadError}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-400">
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
                        <div className="text-xs text-slate-400">
                          {planLabel(plan.planKey)}
                          {plan.isCustom ? " · custom-quoted" : ""}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-slate-400">
                        {planBreakdown[plan.planKey] ?? 0}
                      </td>
                      <td className="px-5 py-3">
                        <input
                          aria-label={`${plan.name} monthly price (USD)`}
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
                          aria-label={`${plan.name} annual price (USD)`}
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
                          disabled={
                            checkingKey !== null ||
                            savingKey !== null ||
                            draft.monthly.trim() === "" ||
                            !isDirty(plan, draft)
                          }
                          onClick={() => startSave(plan)}
                          className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-600 disabled:opacity-50"
                        >
                          {checkingKey === plan.planKey
                            ? "Checking…"
                            : savingKey === plan.planKey
                              ? "Saving…"
                              : "Save"}
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

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={confirmSave}
        variant="danger"
        title={pending ? priceConfirmTitle(pending) : ""}
        description={pending ? priceConfirmBody(pending.impact, pending.changed) : undefined}
        confirmLabel={
          pending && pending.impact.affected > 0
            ? `Change price for ${businesses(pending.impact.affected)}`
            : "Change price"
        }
        loading={savingKey !== null}
      />
    </div>
  );
}
