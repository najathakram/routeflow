"use client";

import * as React from "react";
import { Check, Loader2, Sparkles } from "lucide-react";
import { Card, Button, Badge, useToast, cn } from "@routeflow/ui/web";
import {
  usePlans,
  useRecommendation,
  useQuote,
  useSubscribe,
  type Cycle,
  type PlanDef,
  type QuoteResult,
} from "@/lib/api/billing";

const money = (n: number | null | undefined) =>
  n == null ? "Custom" : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

function planLine(p: PlanDef): string[] {
  const caps: string[] = [];
  caps.push(
    p.seatsIncluded == null
      ? "Unlimited users"
      : `${p.seatsIncluded} user${p.seatsIncluded === 1 ? "" : "s"}`,
  );
  caps.push(
    p.routesConcurrent == null
      ? "Unlimited routes"
      : `${p.routesConcurrent} route${p.routesConcurrent === 1 ? "" : "s"}/day`,
  );
  caps.push(p.scansIncluded == null ? "Unlimited AI scans" : `${p.scansIncluded} AI scans/mo`);
  return caps;
}

export default function ChoosePlanPage() {
  const { toast } = useToast();
  const plans = usePlans();
  const rec = useRecommendation();
  const quote = useQuote();
  const subscribe = useSubscribe();

  const [cycle, setCycle] = React.useState<Cycle>("MONTHLY");
  const [selected, setSelected] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<QuoteResult | null>(null);

  const catalog = plans.data;
  const recommended = rec.data?.recommendedPlanKey;

  const pick = (planKey: string, isCustom: boolean) => {
    if (isCustom) {
      toast({ title: "Enterprise is custom", description: "Contact sales for a tailored quote." });
      return;
    }
    setSelected(planKey);
    quote.mutate({ planKey, cycle }, { onSuccess: setPreview });
  };

  // Recompute the quote when the cycle toggles for the selected plan.
  React.useEffect(() => {
    if (selected) quote.mutate({ planKey: selected, cycle }, { onSuccess: setPreview });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycle]);

  const commit = () => {
    if (!selected) return;
    subscribe.mutate(
      { planKey: selected, cycle },
      {
        onSuccess: () => {
          toast({ title: "Subscribed", description: `You're now on the ${selected} plan.` });
          window.location.href = "/settings/billing";
        },
        onError: () => toast({ title: "Could not subscribe", description: "Please try again." }),
      },
    );
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-slate-900">Choose your plan</h1>
        <p className="mt-1 text-sm text-slate-500">
          Start small, add modules and seats as you grow.
        </p>
        <div className="mt-4 inline-flex rounded-full bg-slate-100 p-1 text-sm">
          {(["MONTHLY", "ANNUAL"] as Cycle[]).map((c) => (
            <button
              key={c}
              onClick={() => setCycle(c)}
              className={cn(
                "rounded-full px-4 py-1.5 font-medium transition-colors",
                cycle === c ? "bg-white text-slate-900 shadow-sm" : "text-slate-500",
              )}
            >
              {c === "MONTHLY" ? "Monthly" : "Annual"}
              {c === "ANNUAL" && (
                <span className="ml-1 text-xs text-emerald-600">2 months free</span>
              )}
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
            const price = cycle === "ANNUAL" ? p.annualPrice : p.monthlyPrice;
            return (
              <Card
                key={p.planKey}
                className={cn(
                  "flex flex-col p-5 ring-1 transition-shadow",
                  isSel ? "ring-2 ring-indigo-500" : "ring-slate-200",
                )}
              >
                <div className="mb-1 flex items-center justify-between">
                  <h3 className="font-semibold text-slate-900">{p.name}</h3>
                  {isRec && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                      <Sparkles className="h-3 w-3" /> Best fit
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
                  disabled={quote.isPending && isSel}
                >
                  {p.isCustom ? "Contact sales" : isSel ? "Selected" : "Choose"}
                </Button>
              </Card>
            );
          })}
      </div>

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
              <span className="tabular-nums">{money(preview.dueToday)}</span>
            </div>
            {preview.annualSaving > 0 && (
              <p className="text-xs text-emerald-600">
                You save {money(preview.annualSaving)} a year.
              </p>
            )}
            <p className="text-xs text-slate-400">
              Renews {new Date(preview.renewalAt).toLocaleDateString()}.
            </p>
          </div>
          <Button className="mt-4 w-full" onClick={commit} disabled={subscribe.isPending}>
            {subscribe.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              `Subscribe to ${preview.planName}`
            )}
          </Button>
        </Card>
      )}
    </div>
  );
}
