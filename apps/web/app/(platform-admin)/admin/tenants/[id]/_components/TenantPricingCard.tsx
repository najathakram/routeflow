"use client";

import * as React from "react";
import { AdminCard } from "../../../../_components/AdminCard";
import { AdminModal } from "../../../../_components/AdminModal";
import { planLabel } from "../../../../_components/AdminBadge";
import {
  fetchTenantPricing,
  updateTenantPriceOverride,
  createTenantCheckout,
  tenantCheckoutErrorMessage,
  platformPricingErrorMessage,
  type TenantPricingResponse,
  type PriceOverrideEffective,
  type PriceSyncResult,
} from "@/lib/api/platform-pricing";
import {
  fetchCatchupPlan,
  openCatchupCheckout,
  isCatchupAmountChanged,
  type CatchupReportView,
} from "@/lib/api/platform-catchup";
import { API_ERROR_CODES } from "@routeflow/types";
import { fromCents } from "@routeflow/pricing";
import { formatMoney } from "@/lib/format";
import { fmtCalendarDate } from "@/lib/formatting";
import { codedToastCopy, genericToastCopy } from "@/lib/generic-toast-copy";
import { CopyButton } from "@/components/CopyButton";

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

/** Whole cents from the plan JSON, printed through the one money formatter. No arithmetic on the figure. */
const usdCents = (cents: number) => formatMoney(fromCents(cents));

const CLAIM_HELD_COPY =
  "A payment link is already open for this business. Wait for it to be paid or to expire.";
const NOT_ELIGIBLE_COPY = "This business can't be moved to card payment yet.";
const PLAN_READ_FAILED_COPY = "Couldn't check how this business pays. Try again.";
/** The planner reads paid coverage from invoices and activation markers. A bank payment recorded on neither is the super admin's to catch before sending (SA-1210 G1). */
const PAID_THROUGH_CHECK_COPY =
  "Check that 'Paid through' matches what this business has paid. If they paid by bank and it isn't shown, record it first with Activate manually.";
const AMOUNT_CHANGED_COPY = "The amount changed. Check the new amount and try again.";

/** True when the plan read says this business is invoiced by hand with no Stripe subscription: the card-link path. */
const isInvoicedByHand = (r: CatchupReportView) => r.externalPayment && !r.hasStripeSubscription;

/** One plain sentence per refusal: a held claim by its own sentence, every code by the web's code-to-copy map. */
function refusalSentences(r: CatchupReportView): string[] {
  const out: string[] = [];
  const claimOnly = r.ineligible.length === 1 && r.ineligible[0] === "claim_held";
  if (r.ineligible.includes("claim_held")) out.push(CLAIM_HELD_COPY);
  for (const code of r.refusals) {
    if (code === API_ERROR_CODES.CATCHUP_NOT_ELIGIBLE && claimOnly) continue;
    out.push(codedToastCopy({ response: { status: 409, data: { code } } }) ?? NOT_ELIGIBLE_COPY);
  }
  if (out.length === 0) out.push(NOT_ELIGIBLE_COPY);
  return [...new Set(out)];
}

/** What the plan charges and when, in plain words, from the plan JSON only. */
function previewLines(r: CatchupReportView): string[] {
  const p = r.plan;
  if (!p.ok) return [];
  const lines = [`Paid through ${fmtCalendarDate(p.paidThrough)}`];
  const nothingToday = p.shape === "trial" || p.stub.belowStripeMinimum;
  lines.push(
    nothingToday
      ? "Nothing is charged today"
      : `When they pay, they're charged ${usdCents(p.stub.totalCents)} for the ${p.stub.label}`,
  );
  if (r.recurringCents != null) {
    lines.push(`${usdCents(r.recurringCents)}/month from ${fmtCalendarDate(p.trialEndAt)}`);
  }
  const n = p.voidInvoiceIds.length;
  if (n > 0) {
    lines.push(
      n === 1
        ? "1 open RouteFlow invoice is closed when they pay"
        : `${n} open RouteFlow invoices are closed when they pay`,
    );
  }
  return lines;
}

/**
 * SA-1206 R2: the card payment link for a business invoiced by hand. Everything shown is the plan JSON from
 * `GET …/billing/catchup-plan`; the confirm posts the plan's own `stub.totalCents`, exactly as read. The link
 * comes back once, is shown once, and is never logged, toasted or sent anywhere else.
 */
function CardPaymentLinkSection({
  tenantId,
  report,
  checkoutUrl,
  onLink,
  onDone,
  onReread,
}: {
  tenantId: string;
  report: CatchupReportView | null;
  checkoutUrl: string | null;
  onLink: (url: string) => void;
  onDone: () => void;
  onReread: () => void;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const linkRef = React.useRef<HTMLElement | null>(null);
  const plan = report?.plan;
  const eligible = !!report && report.eligible && !!plan?.ok;

  const create = async () => {
    if (!plan || !plan.ok) return;
    setCreating(true);
    setError(null);
    try {
      const res = await openCatchupCheckout(tenantId, plan.stub.totalCents);
      setConfirming(false);
      if (res.checkoutUrl) onLink(res.checkoutUrl);
      else
        setError(
          "A payment link was created but could not be shown. Wait for it to expire, then try again.",
        );
    } catch (err) {
      setConfirming(false);
      if (isCatchupAmountChanged(err)) {
        // Never retried on its own: the admin reads the new amount first.
        setError(AMOUNT_CHANGED_COPY);
        onReread();
      } else {
        setError(genericToastCopy(err));
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="border-t border-slate-700 pt-4" data-testid="card-payment-link">
      <p className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-400">
        Card payment link
      </p>
      {error && (
        <div
          role="alert"
          className="mb-3 rounded-lg bg-red-900/30 px-4 py-3 text-sm text-red-300 ring-1 ring-red-700/50"
        >
          {error}
        </div>
      )}
      {checkoutUrl ? (
        <div className="rounded-lg bg-slate-700/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-white">Payment link ready</p>
            <CopyButton
              value={checkoutUrl}
              label="Copy payment link"
              failedText="Copy failed. Select the link"
              selectOnFail={linkRef}
              className="admin-tap inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-indigo-300 hover:bg-indigo-900/40"
            />
          </div>
          <code
            ref={linkRef}
            className="mt-2 block break-all font-mono text-xs text-indigo-300"
            data-testid="card-payment-link-url"
          >
            {checkoutUrl}
          </code>
          <p className="mt-2 text-xs text-amber-300">Copy it now. It can&apos;t be shown again.</p>
          <button
            type="button"
            onClick={onDone}
            className="mt-3 rounded-lg bg-slate-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-500"
          >
            Done
          </button>
        </div>
      ) : eligible ? (
        <>
          <ul className="mb-3 flex list-none flex-col gap-1 text-sm text-slate-200">
            {(report ? previewLines(report) : []).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <button
            type="button"
            disabled={creating}
            onClick={() => setConfirming(true)}
            className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-600 disabled:opacity-50"
          >
            Create payment link
          </button>
        </>
      ) : (
        <ul className="flex list-none flex-col gap-1 text-sm text-amber-300">
          {(report ? refusalSentences(report) : []).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      )}
      <AdminModal
        open={confirming && !!plan?.ok}
        onClose={() => setConfirming(false)}
        title="Create payment link?"
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-lg px-4 py-2 text-sm font-medium text-slate-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={creating}
              onClick={() => void create()}
              className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-600 disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create payment link"}
            </button>
          </>
        }
      >
        <ul className="flex list-none flex-col gap-1 text-sm text-slate-300">
          {(report ? previewLines(report) : []).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-slate-300">{PAID_THROUGH_CHECK_COPY}</p>
        <p className="mt-3 text-sm text-slate-300">
          The link opens Stripe&apos;s payment page. It is shown once, so copy it right away.
        </p>
      </AdminModal>
    </div>
  );
}

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

  const [confirmingLink, setConfirmingLink] = React.useState(false);
  const linkRef = React.useRef<HTMLElement | null>(null);
  const [checkoutLoading, setCheckoutLoading] = React.useState(false);
  const [checkoutUrl, setCheckoutUrl] = React.useState<string | null>(null);

  // SA-1206 R2: how this business pays, from GET catchup-plan alone. Until it is read, neither block shows.
  const [payReport, setPayReport] = React.useState<CatchupReportView | null>(null);
  const [payReadFailed, setPayReadFailed] = React.useState(false);
  const [paymentLink, setPaymentLink] = React.useState<string | null>(null);

  const loadPayReport = React.useCallback(() => {
    setPayReadFailed(false);
    fetchCatchupPlan(tenantId)
      .then((r) => setPayReport(r))
      .catch(() => {
        // Never fall back to the ordinary Checkout: a business invoiced by hand would be refused there.
        setPayReport(null);
        setPayReadFailed(true);
      });
  }, [tenantId]);

  React.useEffect(() => {
    loadPayReport();
  }, [loadPayReport]);

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
      // the card link's amounts follow the price just saved
      if (!paymentLink) loadPayReport();
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
    setConfirmingLink(false);
    setCheckoutLoading(true);
    setMsg(null);
    setCheckoutUrl(null);
    try {
      // Monthly only: the API refuses Annual (SA-733 D6), so no interval is offered or sent.
      const res = await createTenantCheckout(tenantId);
      setCheckoutUrl(res.checkoutUrl);
    } catch (err) {
      setMsg({
        type: "error",
        text: tenantCheckoutErrorMessage(err),
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
              This plan{pricing.planKey ? ` (${planLabel(pricing.planKey)})` : ""} has no catalog
              price — it is billed at a negotiated custom fee. Set one below before creating a
              checkout session for this tenant.
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

          {/* How this business pays is read once (catchup-plan). Until then, and if the read fails, neither
              the card payment link nor the ordinary Checkout shows. */}
          {payReport == null && !payReadFailed && !paymentLink && (
            <p className="border-t border-slate-700 pt-4 text-sm text-slate-400">
              Checking how this business pays…
            </p>
          )}
          {payReport == null && payReadFailed && !paymentLink && (
            <div className="flex flex-wrap items-center gap-3 border-t border-slate-700 pt-4">
              <p role="alert" className="text-sm text-amber-300">
                {PLAN_READ_FAILED_COPY}
              </p>
              <button
                type="button"
                onClick={loadPayReport}
                className="rounded-lg bg-slate-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-slate-500"
              >
                Try again
              </button>
            </div>
          )}
          {(paymentLink || (payReport && isInvoicedByHand(payReport))) && (
            <CardPaymentLinkSection
              tenantId={tenantId}
              report={payReport}
              checkoutUrl={paymentLink}
              onLink={setPaymentLink}
              onDone={() => {
                setPaymentLink(null);
                loadPayReport();
              }}
              onReread={loadPayReport}
            />
          )}

          {/* Checkout — only once a price actually resolves; a checkout on an
              unpriceable plan would 400 at Stripe anyway. Only for a business that is NOT invoiced by hand
              (the ordinary checkout refuses one: EXTERNAL_PAYMENT_USE_CATCHUP). */}
          {payReport && !isInvoicedByHand(payReport) && resolved && pricing && (
            <div className="border-t border-slate-700 pt-4">
              <p className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-400">
                Checkout
              </p>
              <button
                type="button"
                disabled={checkoutLoading}
                onClick={() => setConfirmingLink(true)}
                className="rounded-lg bg-slate-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-500 disabled:opacity-50"
              >
                {checkoutLoading ? "Creating…" : "Create link"}
              </button>
              {checkoutUrl && (
                <div className="mt-3 rounded-lg bg-slate-700/30 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-white">Link ready</p>
                    <CopyButton
                      value={checkoutUrl}
                      label="Copy link"
                      failedText="Copy failed. Select the link"
                      selectOnFail={linkRef}
                      className="admin-tap inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-indigo-300 hover:bg-indigo-900/40"
                    />
                  </div>
                  <a
                    ref={linkRef as React.RefObject<HTMLAnchorElement>}
                    href={checkoutUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="admin-inline mt-2 block break-all text-xs text-indigo-400 hover:underline"
                  >
                    {checkoutUrl}
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <AdminModal
        open={confirmingLink}
        onClose={() => setConfirmingLink(false)}
        title="Create a payment link?"
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmingLink(false)}
              className="rounded-lg px-4 py-2 text-sm font-medium text-slate-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={checkoutLoading}
              onClick={() => void doCheckout()}
              className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-600 disabled:opacity-50"
            >
              Create link
            </button>
          </>
        }
      >
        <p className="text-sm text-slate-300">
          It opens Stripe&apos;s payment page. The link stops working within 24 hours.
        </p>
      </AdminModal>

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
