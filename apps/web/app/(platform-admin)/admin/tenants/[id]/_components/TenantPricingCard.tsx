"use client";

import * as React from "react";
import { AdminCard } from "../../../../_components/AdminCard";
import { AdminModal } from "../../../../_components/AdminModal";
import {
  fetchTenantPricing,
  updateTenantPriceOverride,
  createTenantCheckout,
  platformPricingErrorMessage,
  type TenantPricingResponse,
  type BillingInterval,
  type PriceOverrideEffective,
  type PriceSyncResult,
} from "@/lib/api/platform-pricing";

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

/** What the admin is told after a save: the chosen mode, and what Stripe actually did with it. */
function savedMessage(sync: PriceSyncResult, asked: PriceOverrideEffective): string {
  if (!sync.synced) return `Saved (${sync.reason ?? "no live subscription to sync"}).`;
  if (sync.unchanged)
    return "Saved - Stripe already billed this amount, so nothing was sent to it.";
  if (asked === "now_prorated" && sync.proration === "none") {
    return "Saved - this subscription isn't active (trial, past due or unpaid), so the change was not prorated: it applies from the next invoice.";
  }
  if (sync.proration === "create_prorations") {
    return "Saved - the live Stripe subscription was repriced now; the prorated adjustment lands on the next invoice.";
  }
  return "Saved - the live Stripe subscription will bill the new price at the next billing date.";
}

/**
 * Resolved tenant pricing (catalog vs custom fee) + Stripe checkout, mounted on the
 * tenant detail page's Billing & Subscription tab. This is the SOLE checkout entry
 * point for a tenant — it absorbs the page's former plain "Create Checkout Session"
 * button, which had no interval and used the retired env-price path.
 */
export function TenantPricingCard({ tenantId }: { tenantId: string }) {
  const [pricing, setPricing] = React.useState<TenantPricingResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [monthlyInput, setMonthlyInput] = React.useState("");
  const [annualInput, setAnnualInput] = React.useState("");
  const [effective, setEffective] = React.useState<PriceOverrideEffective>("next_cycle");
  const [saving, setSaving] = React.useState(false);
  const [confirmAction, setConfirmAction] = React.useState<"set" | "clear" | null>(null);
  const [msg, setMsg] = React.useState<{ type: "success" | "error"; text: string } | null>(null);

  const [billingInterval, setBillingInterval] = React.useState<BillingInterval>("month");
  const [checkoutLoading, setCheckoutLoading] = React.useState(false);
  const [checkoutUrl, setCheckoutUrl] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    setLoading(true);
    setLoadError(null);
    fetchTenantPricing(tenantId)
      .then((data) => {
        setPricing(data);
        // Prefill from the RAW override columns the endpoint returns — never from the
        // resolved figures. Blanking the annual input here would make the next save
        // send `annual: null` and silently destroy a negotiated annual price (the
        // resolver would then re-derive it as 10× monthly and push that to Stripe).
        setMonthlyInput(data.override.monthly == null ? "" : String(data.override.monthly));
        setAnnualInput(data.override.annual == null ? "" : String(data.override.annual));
      })
      .catch((err) => setLoadError(platformPricingErrorMessage(err, "Failed to load pricing")))
      .finally(() => setLoading(false));
  }, [tenantId]);

  React.useEffect(() => {
    load();
  }, [load]);

  const applyOverride = async (clear: boolean) => {
    setSaving(true);
    setMsg(null);
    try {
      // Without a live subscription there is nothing to prorate: always the default.
      const asked: PriceOverrideEffective = hasLiveSubscription ? effective : "next_cycle";
      const body = clear
        ? { monthly: null, annual: null, effective: asked }
        : {
            monthly: monthlyInput.trim() === "" ? null : Number(monthlyInput),
            annual: annualInput.trim() === "" ? null : Number(annualInput),
            effective: asked,
          };
      const result = await updateTenantPriceOverride(tenantId, body);
      setMsg({ type: "success", text: savedMessage(result.sync, asked) });
      load();
    } catch (err) {
      setMsg({
        type: "error",
        text: platformPricingErrorMessage(err, "Failed to save the custom fee"),
      });
    } finally {
      setSaving(false);
      setConfirmAction(null);
    }
  };

  const doCheckout = async () => {
    setCheckoutLoading(true);
    setMsg(null);
    setCheckoutUrl(null);
    try {
      const res = await createTenantCheckout(tenantId, billingInterval);
      setCheckoutUrl(res.checkoutUrl);
    } catch (err) {
      setMsg({
        type: "error",
        text: platformPricingErrorMessage(err, "Failed to create checkout session"),
      });
    } finally {
      setCheckoutLoading(false);
    }
  };

  const hasLiveSubscription = pricing != null && pricing.subscription.status !== "none";
  const hasOverride =
    pricing != null && (pricing.override.monthly != null || pricing.override.annual != null);
  // A plan the catalog can't price (ENTERPRISE / isCustom, no custom fee yet) has no
  // resolved figures — the custom-fee editor below still renders, because those are
  // exactly the tenants that need it.
  const resolved =
    pricing != null && pricing.resolvable && pricing.monthly != null && pricing.annual != null;

  return (
    <AdminCard title="Pricing" className="lg:col-span-2">
      {loading ? (
        <p className="text-sm text-slate-400">Loading pricing…</p>
      ) : (
        <div className="flex flex-col gap-5">
          {loadError && (
            <div className="rounded-lg bg-red-900/30 px-4 py-3 text-sm text-red-300 ring-1 ring-red-700/50">
              {loadError}
            </div>
          )}

          {pricing && !pricing.resolvable && (
            <div className="rounded-lg bg-amber-900/20 px-4 py-3 text-sm text-amber-300 ring-1 ring-amber-700/40">
              This plan{pricing.planKey ? ` (${pricing.planKey})` : ""} has no catalog price — it is
              billed at a negotiated custom fee. Set one below before creating a checkout session
              for this tenant.
            </div>
          )}

          {/* Resolved price */}
          {resolved && pricing && (
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-white">{usd(pricing.monthly ?? 0)}</span>
                  <span className="text-sm text-slate-400">/mo</span>
                  <span className="text-sm text-slate-400">·</span>
                  <span className="text-sm text-slate-300">{usd(pricing.annual ?? 0)}/yr</span>
                </div>
                <p className="mt-0.5 text-xs text-slate-400">
                  {pricing.planName} ({pricing.planKey})
                </p>
              </div>
              <span
                className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${
                  hasOverride
                    ? "bg-amber-900/30 text-amber-400 ring-amber-600/30"
                    : "bg-slate-700 text-slate-300 ring-slate-600/30"
                }`}
              >
                {hasOverride ? "Custom fee" : "Catalog"}
              </span>
            </div>
          )}

          {/* Live subscription state */}
          {pricing && (
            <div className="rounded-lg bg-slate-700/30 px-3 py-2 text-xs text-slate-400">
              {pricing.subscription.status !== "none" ? (
                <>
                  Live Stripe subscription{" "}
                  <span className="font-mono text-slate-300">
                    {pricing.subscription.stripeSubId}
                  </span>
                  {" — "}
                  {pricing.subscription.status}. Choose below when a price change takes effect.
                </>
              ) : (
                "No live Stripe subscription yet — changes below only update the resolved price shown here."
              )}
            </div>
          )}

          {msg && (
            <div
              className={`rounded-lg px-4 py-3 text-sm ring-1 break-all ${
                msg.type === "success"
                  ? "bg-green-900/30 text-green-300 ring-green-700/50"
                  : "bg-red-900/30 text-red-300 ring-red-700/50"
              }`}
            >
              {msg.text}
            </div>
          )}

          {/* Custom fee editor */}
          <div className="border-t border-slate-700 pt-4">
            <p className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-400">
              Custom fee override
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">
                  Monthly (USD)
                </label>
                <input
                  aria-label="Monthly (USD)"
                  type="number"
                  min={0}
                  max={100000}
                  step="0.01"
                  value={monthlyInput}
                  onChange={(e) => setMonthlyInput(e.target.value)}
                  placeholder="Catalog price"
                  className="h-9 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">
                  Annual (USD){" "}
                  <span className="text-slate-400">(optional — defaults to 10× monthly)</span>
                </label>
                <input
                  aria-label="Annual (USD)"
                  type="number"
                  min={0}
                  max={100000}
                  step="0.01"
                  value={annualInput}
                  onChange={(e) => setAnnualInput(e.target.value)}
                  placeholder="10× monthly"
                  className="h-9 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </div>
            {hasLiveSubscription && (
              <fieldset className="mt-3">
                <legend className="mb-1 text-xs font-medium text-slate-400">
                  When should the new price apply?
                </legend>
                <div className="flex flex-col gap-1.5 sm:flex-row sm:gap-5">
                  <label className="flex items-center gap-2 text-sm text-slate-200">
                    <input
                      type="radio"
                      name="price-override-effective"
                      checked={effective === "next_cycle"}
                      onChange={() => setEffective("next_cycle")}
                    />
                    Next billing date
                  </label>
                  <label className="flex items-center gap-2 text-sm text-slate-200">
                    <input
                      type="radio"
                      name="price-override-effective"
                      checked={effective === "now_prorated"}
                      onChange={() => setEffective("now_prorated")}
                    />
                    Now, prorated
                  </label>
                </div>
              </fieldset>
            )}
            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                disabled={saving || monthlyInput.trim() === ""}
                onClick={() => setConfirmAction("set")}
                className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-600 disabled:opacity-50"
              >
                Save custom fee
              </button>
              {hasOverride && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setConfirmAction("clear")}
                  className="rounded-lg bg-slate-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-500 disabled:opacity-50"
                >
                  Clear (revert to catalog)
                </button>
              )}
            </div>
          </div>

          {/* Checkout — only once a price actually resolves; a checkout on an
              unpriceable plan would 400 at Stripe anyway. */}
          {resolved && pricing && (
            <div className="border-t border-slate-700 pt-4">
              <p className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-400">
                Checkout
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <select
                  aria-label="Billing interval"
                  value={billingInterval}
                  onChange={(e) => setBillingInterval(e.target.value as BillingInterval)}
                  className="h-9 rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
                >
                  <option value="month">Monthly — {usd(pricing.monthly ?? 0)}/mo</option>
                  <option value="year">Annual — {usd(pricing.annual ?? 0)}/yr</option>
                </select>
                <button
                  type="button"
                  disabled={checkoutLoading}
                  onClick={doCheckout}
                  className="rounded-lg bg-slate-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-500 disabled:opacity-50"
                >
                  {checkoutLoading ? "Creating…" : "Create checkout session"}
                </button>
              </div>
              {checkoutUrl && (
                <p className="mt-3 break-all text-xs text-slate-400">
                  Checkout URL:{" "}
                  <a
                    href={checkoutUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="admin-inline text-indigo-400 hover:underline"
                  >
                    {checkoutUrl}
                  </a>
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <AdminModal
        open={confirmAction !== null}
        onClose={() => setConfirmAction(null)}
        title={confirmAction === "clear" ? "Clear custom fee?" : "Save custom fee?"}
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmAction(null)}
              className="rounded-lg px-4 py-2 text-sm font-medium text-slate-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => applyOverride(confirmAction === "clear")}
              className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-600 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Confirm"}
            </button>
          </>
        }
      >
        <p className="text-sm text-slate-300">
          {confirmAction === "clear"
            ? "This tenant will revert to the catalog price for its plan — both the monthly and the annual custom fee are cleared."
            : `This tenant will be billed ${monthlyInput.trim() === "" ? "the catalog price" : usd(Number(monthlyInput))}/mo` +
              `${
                annualInput.trim() !== ""
                  ? ` and ${usd(Number(annualInput))}/yr`
                  : monthlyInput.trim() === ""
                    ? ""
                    : ` and ${usd(Number(monthlyInput) * 10)}/yr (10× monthly — the annual custom fee is cleared)`
              }.`}{" "}
          {hasLiveSubscription && effective === "now_prorated" ? (
            <>
              It applies <strong className="text-white">now</strong>, prorated for the rest of the
              current period (the adjustment lands on the next invoice).
            </>
          ) : (
            <>
              It applies from the <strong className="text-white">next billing date</strong> - the
              current period is never prorated.
            </>
          )}
        </p>
      </AdminModal>
    </AdminCard>
  );
}
