"use client";

import * as React from "react";
import { CreditCard, Check, AlertTriangle, Loader2, Zap } from "lucide-react";
import { Card, Button, Badge, Modal, useToast, cn } from "@routeflow/ui/web";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useAuth } from "@/lib/auth-context";
import { formatMoney } from "@/lib/format";
import { BillingExportButton } from "./BillingExportButton";
import {
  useSubscription,
  useUsage,
  usePlans,
  useCancelSubscription,
  useResumeSubscription,
  useEnableAddon,
  useDisableAddon,
  useProrationPreview,
  useCreateCheckout,
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

/**
 * Confirm sheet for turning an add-on ON. The add-on is switched on at once and the prorated
 * amount is booked from the same server calculation the enable call applies
 * (`GET /billing/proration-preview`); `enableAddon` makes no card/Stripe call, so the sheet says
 * the amount lands on the next bill rather than claiming an immediate charge. Confirm stays
 * disabled until a FRESH figure is on screen (not a cached one still being re-checked) — a sheet
 * that lets you commit without seeing the money would defeat the point.
 */
function EnableAddonSheet({
  addon,
  busy,
  onConfirm,
  onClose,
}: {
  addon: AddonSkuDef | null;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const preview = useProrationPreview(addon?.sku ?? null);
  const p = preview.data;
  const ready = !!p && !preview.isFetching && !preview.isError;
  return (
    <Modal
      open={addon != null}
      onClose={onClose}
      title={addon ? `Enable ${addon.name}?` : "Enable add-on"}
      className="max-w-sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onConfirm} loading={busy} disabled={!ready || busy}>
            Enable add-on
          </Button>
        </>
      }
    >
      {addon && (
        <div className="space-y-3 text-sm text-slate-600">
          <div className="rounded-lg bg-slate-50 px-4 py-3 ring-1 ring-slate-200">
            <div className="flex justify-between">
              <span className="font-medium text-slate-800">{addon.name}</span>
              <span className="tabular-nums text-slate-800">
                {formatMoney(addon.monthlyPrice)}/mo
              </span>
            </div>
            {ready && (
              <div className="mt-2 flex justify-between border-t border-slate-200 pt-2 font-medium text-slate-900">
                <span>Prorated this cycle</span>
                <span className="tabular-nums">{formatMoney(p.proratedToday)}</span>
              </div>
            )}
          </div>
          {preview.isFetching && !preview.isError && (
            <p className="flex items-center gap-2 text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Working out today&apos;s charge…
            </p>
          )}
          {preview.isError && (
            <p className="text-red-700">
              We couldn&apos;t work out today&apos;s charge. Close this and try again.
            </p>
          )}
          {ready && (
            <p>
              Turns on right away. Prorated for the {p.daysRemaining} of {p.daysInCycle} days left
              in this cycle, added to your next bill, then {formatMoney(addon.monthlyPrice)}/mo
              after that. Your card is not charged when you confirm.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

export default function BillingSettingsPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === "TENANT_ADMIN";
  const sub = useSubscription();
  const usage = useUsage();
  const plans = usePlans();
  const cancel = useCancelSubscription();
  const resume = useResumeSubscription();
  const enable = useEnableAddon();
  const disable = useDisableAddon();
  const checkout = useCreateCheckout();
  const [endTrialOpen, setEndTrialOpen] = React.useState(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  // An add-on awaiting confirmation. Enabling bills at once and disabling stops a paid feature,
  // so a click only OPENS the matching confirm — the mutation fires from the confirm, never here.
  const [enableTarget, setEnableTarget] = React.useState<AddonSkuDef | null>(null);
  const [disableTarget, setDisableTarget] = React.useState<AddonSkuDef | null>(null);

  const activeSkus = new Set(
    (sub.data?.addons ?? []).map((a) => a.sku).filter(Boolean) as string[],
  );

  const toggleAddon = (addon: AddonSkuDef) => {
    if (activeSkus.has(addon.sku)) setDisableTarget(addon);
    else setEnableTarget(addon);
  };

  const confirmEnable = () => {
    const addon = enableTarget;
    if (!addon) return;
    enable.mutate(
      { sku: addon.sku },
      {
        onSuccess: (res) => {
          const prorated = (res as { proratedNow?: number })?.proratedNow;
          toast({
            title: `${addon.name} enabled`,
            description:
              prorated != null ? `Prorated ${formatMoney(prorated)} this cycle.` : undefined,
          });
        },
      },
    );
    setEnableTarget(null);
  };

  const confirmDisable = () => {
    const addon = disableTarget;
    if (!addon) return;
    disable.mutate(
      { sku: addon.sku },
      {
        onSuccess: () =>
          toast({ title: `${addon.name} disabled`, description: "History kept read-only." }),
      },
    );
    setDisableTarget(null);
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Plan &amp; Billing</h1>
          <p className="mt-1 text-sm text-slate-500">
            Manage your subscription, add-ons and usage.
          </p>
        </div>
        <BillingExportButton />
      </div>

      <TrialBanner sub={s} />
      <ReadOnlyBanner status={s.status} readOnlyReason={s.readOnlyReason} />

      {s.cancelAtPeriodEnd && s.status !== "READ_ONLY" && (
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
          {s.paymentRequired && (
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-slate-700">
                {s.planName} · {money(s.monthlyPrice)}/mo
              </span>
              <Button loading={checkout.isPending} onClick={() => checkout.mutate()}>
                Complete payment
              </Button>
            </div>
          )}
          <div className="flex gap-2">
            <a href="/choose-plan">
              <Button size="sm">Change plan</Button>
            </a>
            {s.status === "TRIAL" && isAdmin && (
              <Button size="sm" variant="ghost" onClick={() => setEndTrialOpen(true)}>
                End trial
              </Button>
            )}
            {!s.cancelAtPeriodEnd && s.status !== "TRIAL" && s.status !== "READ_ONLY" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCancelOpen(true)}
                disabled={cancel.isPending}
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
      </Card>

      <ConfirmDialog
        open={endTrialOpen}
        onClose={() => setEndTrialOpen(false)}
        onConfirm={() => {
          cancel.mutate(undefined, { onSuccess: () => toast({ title: "Trial ended" }) });
          setEndTrialOpen(false);
        }}
        title="End your trial now?"
        description="Your workspace becomes read-only immediately; exports still work."
        confirmLabel="End trial"
        variant="danger"
        loading={cancel.isPending}
      />

      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={() => {
          cancel.mutate(undefined, {
            onSuccess: () => toast({ title: "Cancellation scheduled" }),
          });
          setCancelOpen(false);
        }}
        title="Cancel your subscription?"
        description="Your plan stays active until the end of the current period, then your workspace becomes read-only (exports still work). You can keep your plan any time before then."
        confirmLabel="Cancel subscription"
        cancelLabel="Keep my plan"
        variant="danger"
        loading={cancel.isPending}
      />

      <EnableAddonSheet
        addon={enableTarget}
        busy={enable.isPending}
        onConfirm={confirmEnable}
        onClose={() => setEnableTarget(null)}
      />

      <ConfirmDialog
        open={disableTarget != null}
        onClose={() => setDisableTarget(null)}
        onConfirm={confirmDisable}
        title={disableTarget ? `Disable ${disableTarget.name}?` : "Disable add-on?"}
        description="Turns this add-on off for your whole workspace. Your history is kept read-only."
        confirmLabel="Disable add-on"
        variant="danger"
        loading={disable.isPending}
      />

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
