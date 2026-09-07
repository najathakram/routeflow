"use client";

import * as React from "react";
import { CreditCard, Check, AlertTriangle, Loader2, Zap } from "lucide-react";
import { Card, Button, Badge, useToast, cn } from "@routeflow/ui/web";
import {
  useSubscription,
  useUsage,
  usePlans,
  useCancelSubscription,
  useResumeSubscription,
  useEnableAddon,
  useDisableAddon,
  type MeterReading,
  type SubscriptionView,
  type AddonSkuDef,
} from "@/lib/api/billing";

const money = (n: number | null | undefined) =>
  n == null
    ? "—"
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const METER_LABEL: Record<string, string> = {
  SEATS: "Seats",
  ROUTES: "Routes / day",
  SCANS: "AI scans",
  MSGS: "Messages",
};

function MeterBar({ m }: { m: MeterReading }) {
  const unlimited = m.included == null;
  const pct = unlimited
    ? 0
    : Math.min(100, Math.round((m.used / Math.max(1, m.included as number)) * 100));
  const over = !unlimited && m.used > (m.included as number);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-slate-700">{METER_LABEL[m.meter] ?? m.meter}</span>
        <span className={cn("tabular-nums", over ? "text-red-600" : "text-slate-500")}>
          {m.used}
          {unlimited ? " · Unlimited" : ` / ${m.included}`}
        </span>
      </div>
      {!unlimited && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className={cn("h-full rounded-full", over ? "bg-red-500" : "bg-indigo-500")}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {m.resetsAt && (
        <p className="text-xs text-slate-400">Resets {new Date(m.resetsAt).toLocaleDateString()}</p>
      )}
    </div>
  );
}

function TrialBanner({ sub }: { sub: SubscriptionView }) {
  if (sub.status !== "TRIAL" || !sub.trialEndsAt) return null;
  const days = Math.max(
    0,
    Math.ceil((new Date(sub.trialEndsAt).getTime() - Date.now()) / 86_400_000),
  );
  return (
    <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
      <Zap className="h-4 w-4 shrink-0" />
      <span>
        Trial ends in{" "}
        <strong>
          {days} day{days === 1 ? "" : "s"}
        </strong>{" "}
        — pick a plan to keep full access. After it expires your workspace goes read-only (exports
        still work).
      </span>
    </div>
  );
}

export default function BillingSettingsPage() {
  const { toast } = useToast();
  const sub = useSubscription();
  const usage = useUsage();
  const plans = usePlans();
  const cancel = useCancelSubscription();
  const resume = useResumeSubscription();
  const enable = useEnableAddon();
  const disable = useDisableAddon();

  const activeSkus = new Set(
    (sub.data?.addons ?? []).map((a) => a.sku).filter(Boolean) as string[],
  );

  const toggleAddon = (addon: AddonSkuDef) => {
    if (activeSkus.has(addon.sku)) {
      disable.mutate(
        { sku: addon.sku },
        {
          onSuccess: () =>
            toast({ title: `${addon.name} disabled`, description: "History kept read-only." }),
        },
      );
    } else {
      enable.mutate(
        { sku: addon.sku },
        {
          onSuccess: (res) => {
            const prorated = (res as { proratedNow?: number })?.proratedNow;
            toast({
              title: `${addon.name} enabled`,
              description: prorated != null ? `Prorated ${money(prorated)} today.` : undefined,
            });
          },
        },
      );
    }
  };

  if (sub.isLoading) {
    return (
      <div className="flex items-center justify-center p-12 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (sub.isError || !sub.data) {
    return (
      <div className="p-6">
        <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">
          Could not load your billing details. Please retry.
        </div>
      </div>
    );
  }

  const s = sub.data;
  const priceForCycle = s.cycle === "ANNUAL" ? s.annualPrice : s.monthlyPrice;
  // À-la-carte add-ons the tenant can toggle (skip ones bundled into the plan).
  const addonCatalog = (plans.data?.addons ?? []).filter((a) => a.sku !== "SEAT_EXTRA");
  const catalogSkus = new Set(addonCatalog.map((a) => a.sku));
  // Add-ons RouteFlow enabled for this workspace ("ships dark" SKUs like MSRP or
  // Regulated items): absent from the self-service catalog but still active and still
  // billed, so list them read-only — hiding them would hide the charge. Enable/Disable
  // is a 403 on these, hence no button. Rows with no canonical SKU (client-only legacy
  // keys such as developer_mode) are not billing lines and stay out.
  const managedAddons = s.addons.filter((a) => a.sku && !catalogSkus.has(a.sku));

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Plan &amp; Billing</h1>
        <p className="mt-1 text-sm text-slate-500">Manage your subscription, add-ons and usage.</p>
      </div>

      <TrialBanner sub={s} />

      {s.cancelAtPeriodEnd && (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> Cancellation scheduled for{" "}
            {s.renewalAt ? new Date(s.renewalAt).toLocaleDateString() : "period end"}.
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => resume.mutate()}
            disabled={resume.isPending}
          >
            Keep my plan
          </Button>
        </div>
      )}

      {s.downgradeToPlanKey && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
          <span>
            Scheduled to change to <strong>{s.downgradeToPlanKey}</strong> on{" "}
            {s.downgradeEffectiveAt
              ? new Date(s.downgradeEffectiveAt).toLocaleDateString()
              : "period end"}
            . Nothing is deleted — over-cap data becomes read-only.
          </span>
          {/* The only self-service undo: resume() clears downgradeToPlanKey without touching
              the plan or the period (re-subscribing would reset periodStart/periodEnd). */}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => resume.mutate()}
            disabled={resume.isPending}
          >
            Keep current plan
          </Button>
        </div>
      )}

      {/* Current plan */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-indigo-50 p-2 text-indigo-600">
              <CreditCard className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-semibold text-slate-900">{s.planName}</span>
                <Badge label={s.status} />
                <Badge variant="neutral" label={s.cycle === "ANNUAL" ? "Annual" : "Monthly"} />
              </div>
              <p className="mt-0.5 text-sm text-slate-500">
                {s.isCustom
                  ? "Custom pricing"
                  : `${money(priceForCycle)}/${s.cycle === "ANNUAL" ? "yr" : "mo"}`}
                {s.renewalAt && ` · renews ${new Date(s.renewalAt).toLocaleDateString()}`}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <a href="/choose-plan">
              <Button size="sm">Change plan</Button>
            </a>
            {!s.cancelAtPeriodEnd && s.status !== "TRIAL" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  cancel.mutate(undefined, {
                    onSuccess: () => toast({ title: "Cancellation scheduled" }),
                  })
                }
                disabled={cancel.isPending}
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* Usage */}
      <Card className="p-5">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Usage this cycle
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {usage.data?.map((m) => (
            <MeterBar key={m.meter} m={m} />
          ))}
          {usage.isLoading && <p className="text-sm text-slate-400">Loading usage…</p>}
        </div>
      </Card>

      {/* Add-ons */}
      <Card className="p-5">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Add-ons
        </h2>
        <div className="divide-y divide-slate-100">
          {addonCatalog.map((a) => {
            const on = activeSkus.has(a.sku);
            const busy =
              (enable.isPending || disable.isPending) &&
              (enable.variables?.sku === a.sku || disable.variables?.sku === a.sku);
            return (
              <div key={a.sku} className="flex items-center justify-between gap-4 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-800">{a.name}</span>
                    {on && (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                        <Check className="h-3 w-3" /> Active
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-slate-500">
                    {money(a.monthlyPrice)}/mo
                    {a.includedAtPlan ? ` · included on ${a.includedAtPlan}+` : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={on ? "ghost" : "secondary"}
                  onClick={() => toggleAddon(a)}
                  disabled={busy}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : on ? "Disable" : "Enable"}
                </Button>
              </div>
            );
          })}
          {managedAddons.map((a) => (
            <div key={a.sku ?? a.name} className="flex items-center justify-between gap-4 py-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-800">{a.name}</span>
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                    <Check className="h-3 w-3" /> Active
                  </span>
                </div>
                <p className="text-sm text-slate-500">
                  {a.monthly != null ? `${money(a.monthly)}/mo · ` : ""}Managed by RouteFlow
                </p>
              </div>
              <span className="shrink-0 text-xs text-slate-400">Contact support to change</span>
            </div>
          ))}
          {addonCatalog.length === 0 && managedAddons.length === 0 && (
            <p className="py-2 text-sm text-slate-400">No add-ons available.</p>
          )}
        </div>
      </Card>
    </div>
  );
}
