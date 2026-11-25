"use client";

import * as React from "react";
import { Check, Loader2, Sparkles } from "lucide-react";
import { Card, Button, Badge, useToast, cn } from "@routeflow/ui/web";
import { fmtDate } from "@/lib/formatting";
import {
  usePlans,
  useRecommendation,
  useSubscription,
  useQuote,
  useSubscribe,
  useUpgrade,
  useDowngrade,
  useResumeSubscription,
  dispatchPlanChange,
  type Cycle,
  type PlanDef,
  type QuoteResult,
} from "@/lib/api/billing";

const money = (n: number | null | undefined) =>
  n == null ? "Custom" : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/** The sales hand-off already used elsewhere in the app — a CONTACT_SALES quote (a custom
 *  plan on either side) links here instead of posting a plan change. */
const SALES_CONTACT_HREF = "mailto:hello@routeflow.info?subject=Enterprise%20plan%20enquiry";

function planLine(p: PlanDef): string[] {
  // Only what is enforced: no plan limits seats, and routes and scans are not capped.
  return [
    p.customersIncluded == null
      ? "Unlimited customers"
      : `${p.customersIncluded} customers included`,
  ];
}

export default function ChoosePlanPage() {
  const { toast } = useToast();
  const plans = usePlans();
  const rec = useRecommendation();
  const subscription = useSubscription();
  const quote = useQuote();
  const subscribe = useSubscribe();
  const upgrade = useUpgrade();
  const downgrade = useDowngrade();
  const resume = useResumeSubscription();

  const [cycle, setCycle] = React.useState<Cycle>("MONTHLY");
  const [selected, setSelected] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<QuoteResult | null>(null);
  const applyPreview = React.useCallback((q: QuoteResult) => {
    setPreview(q);
  }, []);

  // A failed quote must leave NO preview behind: a stale one still carries the previous
  // plan and action while the cycle toggle has already moved, so the commit body could be
  // a {planKey, cycle} pair the server never quoted. No preview = no commit control.
  const clearPreview = React.useCallback(() => setPreview(null), []);

  const catalog = plans.data;
  const recommended = rec.data?.recommendedPlanKey;

  const pick = (planKey: string, isCustom: boolean) => {
    if (isCustom) {
      toast({ title: "Enterprise is custom", description: "Contact sales for a tailored quote." });
      return;
    }
    setSelected(planKey);
    quote.mutate({ planKey, cycle }, { onSuccess: applyPreview, onError: clearPreview });
  };

  // Recompute the quote when the cycle toggles for the selected plan.
  React.useEffect(() => {
    if (selected)
      quote.mutate(
        { planKey: selected, cycle },
        { onSuccess: applyPreview, onError: clearPreview },
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycle]);

  const changeAction = preview?.change?.action ?? "SUBSCRIBE";
  const isCommitting =
    subscribe.isPending || upgrade.isPending || downgrade.isPending || resume.isPending;
  // The plan the tenant is on right now, normalized past legacy aliases server-side.
  // UX guide B10: the server's own answer (the recommendation read) is known on load; the quote's
  // `fromPlanKey` only exists after a pick, so it is the fallback, not the source.
  const currentPlanKey = rec.data?.currentPlanKey ?? preview?.change?.fromPlanKey ?? null;
  // Picking your own plan is NOT always a no-op. The server treats it as a real SUBSCRIBE (a conversion to paid)
  // unless the business is ACTIVE with a period end, so only then do the other cases apply: with a scheduled
  // downgrade or cancellation it is the way to call that off, and on the other billing cycle it is the cycle
  // switch. Everywhere else (a trial, an expired trial, no period end, or the read not loaded yet) the button
  // is the plain "Choose". It stops, as "Current plan", only for an ACTIVE business on this very cycle with
  // nothing scheduled.
  const sub = subscription.data;
  const ownPlanActive = sub != null && sub.status === "ACTIVE" && sub.renewalAt != null;
  // When it stays live, the label says what pressing it does.
  const ownPlanLiveLabel = !ownPlanActive
    ? "Choose"
    : sub.cancelAtPeriodEnd || sub.downgradeToPlanKey != null
      ? "Keep this plan"
      : cycle === "ANNUAL"
        ? "Switch to annual billing"
        : "Switch to monthly billing";
  const ownPlanIsNoChange =
    ownPlanActive &&
    sub.cycle === cycle &&
    !sub.cancelAtPeriodEnd &&
    sub.downgradeToPlanKey == null;
  const commit = () => {
    // CONTACT_SALES commits nowhere: its control is a link to sales, so this is only
    // reached if something else calls commit() — post nothing.
    if (!selected || !preview || changeAction === "NOOP" || changeAction === "CONTACT_SALES") {
      return;
    }
    const planName = preview.planName;
    const successCopy =
      changeAction === "UPGRADE"
        ? { title: "Upgraded", description: `You're now on the ${planName} plan.` }
        : changeAction === "DOWNGRADE"
          ? {
              title: "Downgrade scheduled",
              description: `You'll move to the ${planName} plan at the end of your current cycle.`,
            }
          : changeAction === "KEEP_CURRENT"
            ? {
                title: "Plan kept",
                description: `Your scheduled change is cancelled — you stay on the ${planName} plan.`,
              }
            : { title: "Subscribed", description: `You're now on the ${planName} plan.` };
    const errorCopy =
      changeAction === "UPGRADE"
        ? "Could not upgrade"
        : changeAction === "DOWNGRADE"
          ? "Could not schedule downgrade"
          : changeAction === "KEEP_CURRENT"
            ? "Could not keep your current plan"
            : "Could not subscribe";
    const handlers = {
      onSuccess: () => {
        toast(successCopy);
        window.location.href = "/settings/billing";
      },
      // Surface the server's own message (e.g. the B58 guard's "use upgrade or downgrade to
      // change plan") — a fixed "try again" reads as a transient glitch and the tenant retries
      // forever against a refusal that will never change (L-071).
      onError: (err?: unknown) => {
        const serverMessage = (err as { response?: { data?: { message?: string } } })?.response
          ?.data?.message;
        toast({
          title: errorCopy,
          description:
            typeof serverMessage === "string" && serverMessage
              ? serverMessage
              : "Please try again.",
        });
      },
    };
    // KEEP_CURRENT is the undo for a scheduled downgrade/cancellation, not a plan change —
    // the tenant is already on this plan/cycle, so it commits through resume(). subscribe()
    // (the historical undo) would reset periodStart/periodEnd and jump the renewal date.
    if (changeAction === "KEEP_CURRENT") {
      resume.mutate(undefined, handlers);
      return;
    }
    // `cycle` is the LIVE toggle, never `preview.cycle` (the last quote's echo): a commit
    // fired after a toggle but before — or after a failed — re-quote must not subscribe on
    // the cycle the tenant just moved away from.
    dispatchPlanChange(
      preview,
      {
        cycle,
        upgrade: upgrade.mutate,
        downgrade: downgrade.mutate,
        subscribe: subscribe.mutate,
      },
      handlers,
    );
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-slate-900">Choose your plan</h1>
        <p className="mt-1 text-sm text-slate-500">Start small. Add customers as you grow.</p>
        <div className="mt-4 inline-flex rounded-full bg-slate-100 p-1 text-sm">
          {(["MONTHLY", "ANNUAL"] as Cycle[]).map((c) => (
            <button
              key={c}
              onClick={() => setCycle(c)}
              // Locked while a commit is in flight: the request already carries a cycle,
              // and letting the toggle move under it only misreports what was bought.
              disabled={isCommitting}
              className={cn(
                "rounded-full px-4 py-1.5 font-medium transition-colors",
                cycle === c ? "bg-white text-slate-900 shadow-sm" : "text-slate-500",
                isCommitting && "cursor-not-allowed opacity-50",
              )}
            >
              {/* No "2 months free" label: yearly Stripe checkout is refused
                  (CHECKOUT_ANNUAL_NOT_SUPPORTED), so the offer is not honored (B1392). */}
              {c === "MONTHLY" ? "Monthly" : "Annual"}
            </button>
          ))}
        </div>
      </div>

      {plans.isLoading && (
        <div className="flex justify-center p-8 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {catalog?.plans
          .slice()
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((p) => {
            const isRec = p.planKey === recommended;
            const isSel = p.planKey === selected;
            const isCurrent = currentPlanKey != null && p.planKey === currentPlanKey;
            const price = cycle === "ANNUAL" ? p.annualPrice : p.monthlyPrice;
            return (
              <Card
                key={p.planKey}
                className={cn(
                  "flex flex-col p-5 ring-1 transition-shadow",
                  isSel ? "ring-2 ring-indigo-500" : "ring-slate-200",
                )}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <h3 className="font-semibold text-slate-900">{p.name}</h3>
                  {isCurrent && <Badge variant="info" label="Current plan" />}
                  {isRec && !isCurrent && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                      <Sparkles className="h-3 w-3" /> Fits your usage
                    </span>
                  )}
                </div>
                <div className="mb-3">
                  <span className="text-2xl font-bold text-slate-900">{money(price)}</span>
                  {!p.isCustom && (
                    <span className="text-sm text-slate-400">
                      /{cycle === "ANNUAL" ? "yr" : "mo"}
                    </span>
                  )}
                </div>
                <ul className="mb-4 flex-1 space-y-1.5 text-sm text-slate-600">
                  {planLine(p).map((l) => (
                    <li key={l} className="flex items-center gap-2">
                      <Check className="h-3.5 w-3.5 shrink-0 text-indigo-500" /> {l}
                    </li>
                  ))}
                </ul>
                <Button
                  variant={isSel ? "primary" : "secondary"}
                  onClick={() => pick(p.planKey, p.isCustom)}
                  disabled={(quote.isPending && isSel) || (isCurrent && ownPlanIsNoChange)}
                >
                  {p.isCustom
                    ? "Contact sales"
                    : isCurrent && ownPlanIsNoChange
                      ? "Current plan"
                      : isSel
                        ? "Selected"
                        : isCurrent
                          ? ownPlanLiveLabel
                          : "Choose"}
                </Button>
              </Card>
            );
          })}
      </div>

      {recommended && recommended !== currentPlanKey && (
        <p className="text-center text-xs text-slate-400">
          &ldquo;Fits your usage&rdquo; marks the cheapest plan that covers your current customers.
          It is a hint, not advice to change.
        </p>
      )}

      {/* Quote summary */}
      {preview && !preview.isCustom && (
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Summary
          </h2>
          <div className="space-y-1 text-sm">
            {preview.lines.map((l) => (
              <div key={l.key} className="flex justify-between">
                <span className="text-slate-600">
                  {l.name}
                  {l.quantity > 1 ? ` ×${l.quantity}` : ""}
                  {l.included && <span className="ml-1 text-emerald-600">included</span>}
                </span>
                <span className="tabular-nums text-slate-800">{money(l.cyclePrice)}</span>
              </div>
            ))}
            <div className="mt-2 flex justify-between border-t border-slate-100 pt-2 font-semibold">
              <span>Due today</span>
              <span className="tabular-nums">
                {money(
                  changeAction === "DOWNGRADE" || changeAction === "KEEP_CURRENT"
                    ? 0
                    : changeAction === "CONTACT_SALES"
                      ? null
                      : (preview.change?.proratedNow ?? preview.dueToday),
                )}
              </span>
            </div>
            {/* No "You save $X a year" line: annualSaving is the 2-months-free offer, off while
                yearly checkout is refused (CHECKOUT_ANNUAL_NOT_SUPPORTED, B1392). */}
            {changeAction === "DOWNGRADE" && preview.change?.effectiveAt ? (
              <p className="text-xs text-slate-400">
                Takes effect {fmtDate(preview.change.effectiveAt)}.
              </p>
            ) : (
              <p className="text-xs text-slate-400">Renews {fmtDate(preview.renewalAt)}.</p>
            )}
            {preview.change?.warning && (
              <p className="text-xs text-amber-600">{preview.change.warning}</p>
            )}
          </div>
          <Button
            className="mt-4 w-full"
            // CONTACT_SALES is a hand-off, not a commit: the control becomes a link and
            // posts nothing (Button renders an <a> when `href` is set).
            href={changeAction === "CONTACT_SALES" ? SALES_CONTACT_HREF : undefined}
            onClick={changeAction === "CONTACT_SALES" ? undefined : commit}
            disabled={
              isCommitting ||
              // A quote in flight means `preview` (plan, cycle, action) is stale — committing
              // it would buy the previous selection.
              quote.isPending ||
              changeAction === "NOOP"
            }
          >
            {isCommitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : changeAction === "CONTACT_SALES" ? (
              "Contact sales"
            ) : changeAction === "UPGRADE" ? (
              `Upgrade to ${preview.planName}`
            ) : changeAction === "DOWNGRADE" ? (
              "Schedule downgrade"
            ) : changeAction === "KEEP_CURRENT" ? (
              "Keep current plan"
            ) : changeAction === "NOOP" ? (
              "Current plan"
            ) : (
              `Subscribe to ${preview.planName}`
            )}
          </Button>
        </Card>
      )}
    </div>
  );
}
