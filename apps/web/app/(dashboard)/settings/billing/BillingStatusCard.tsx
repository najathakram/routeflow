"use client";

import * as React from "react";
import { CheckCircle2 } from "lucide-react";
import type { SubscriptionView } from "@routeflow/types";
import { Badge, Button, Card } from "@routeflow/ui/web";
import { useBillingPortal } from "@/lib/api/billing";
import { usePaidNotice } from "@/lib/billing-paid-notice";
import { bannerRoleOf, subscriptionBannerState } from "@/lib/subscription-banner-state";
import { billingCardModel } from "@/lib/billing-card-model";

/**
 * SA-733r6 (B4): the Settings > Billing card's status block, rendered from the same `subscriptionBannerState` as
 * the shell strip (no second copy).
 *  - "Pay $149.00" primary at the top whenever an invoice is owed - admins only (Stripe in <= 2 clicks);
 *  - the autopay line ("Autopay is on. Next charge: ...") or the expiring-card line, admins only;
 *  - operators, while a state shows, read the same sentence as the strip with NO pay control in the DOM;
 *  - "You're all set. Thanks for your payment." once, after a payment clears.
 */
export function BillingStatusCard({
  sub,
  userRole,
  scope,
}: {
  sub: SubscriptionView;
  userRole: string | undefined;
  /** The workspace (tenant slug): scopes the one-time "all set" notice. */
  scope: string | null;
}) {
  const role = bannerRoleOf(userRole);
  const [paid, clearPaid] = usePaidNotice(scope);
  const portal = useBillingPortal();
  if (!role) return null;
  const model = billingCardModel(sub, role);
  // SA-777: the server's state drives ONE card (pill, amount, buttons). When the server could not say, the legacy
  // autopay / expiring-card block below renders exactly as before - never a guessed "Current".
  const state = subscriptionBannerState(sub, role);
  const payNow = (pay: { url?: string }) => {
    if (pay.url?.startsWith("https://")) window.open(pay.url, "_blank", "noopener,noreferrer");
    else portal.mutate({ intent: "pay" });
  };
  const owedCopy =
    state.kind === "grace" || state.kind === "final-day" || state.kind === "read-only"
      ? state.copy
      : null;

  return (
    <div className="space-y-3" data-testid="billing-status-card">
      {paid && (
        <div
          role="status"
          className="flex items-center justify-between gap-2 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900 ring-1 ring-emerald-200"
        >
          <span className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            You&apos;re all set. Thanks for your payment.
          </span>
          <Button size="sm" variant="ghost" onClick={clearPaid}>
            OK
          </Button>
        </div>
      )}
      {model && (
        <Card
          data-testid="billing-card"
          data-state={model.state}
          className="mx-auto w-full max-w-[720px] p-4 md:p-5"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold leading-5 text-slate-900">Subscription</h2>
            <Badge variant={model.pill.tone} label={model.pill.label} />
          </div>
          {model.amountLine && (
            <p className="mt-3 text-[28px] font-semibold leading-[34px] tabular-nums text-slate-900">
              {model.amountLine}
            </p>
          )}
          {model.subLine && (
            <p
              className={
                model.subTone === "amber"
                  ? "mt-1 text-[13px] leading-[18px] text-amber-800"
                  : "mt-1 text-[13px] leading-[18px] text-slate-500"
              }
            >
              {model.subLine}
            </p>
          )}
          {model.state === "read-only" && owedCopy && (
            <p className="mt-3 text-sm leading-5 text-slate-800">{owedCopy}</p>
          )}
          {(model.pay || model.portal) && (
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              {model.pay && (
                <Button
                  className="min-h-[44px] w-full sm:w-auto"
                  loading={portal.isPending}
                  onClick={() => payNow(model.pay!)}
                >
                  {model.pay.label}
                </Button>
              )}
              {model.portal && (
                <Button
                  variant="secondary"
                  className="min-h-[44px] w-full sm:w-auto"
                  aria-label="Payment methods & invoices (opens Stripe)"
                  loading={portal.isPending}
                  onClick={() => portal.mutate({ intent: "update-payment" })}
                >
                  Payment methods &amp; invoices ↗
                </Button>
              )}
            </div>
          )}
          {model.contact && (
            <p className="mt-3 text-[13px] leading-[18px] text-slate-600">
              Only an admin can pay.
              {model.contact.email ? (
                <>
                  {" Your admin: "}
                  <a className="underline" href={`mailto:${model.contact.email}`}>
                    {model.contact.email}
                  </a>
                </>
              ) : (
                " Ask your admin."
              )}
            </p>
          )}
        </Card>
      )}
      {!model && owedCopy && (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="min-w-0 flex-1 text-sm text-slate-800">{owedCopy}</p>
          {state.cardPay && (
            <Button loading={portal.isPending} onClick={() => portal.mutate({ intent: "pay" })}>
              {state.cardPay.label}
            </Button>
          )}
        </Card>
      )}
      {!model && state.cardLine && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
          <p>{state.cardLine}</p>
          {state.kind === "card-expiring" && (
            <Button
              size="sm"
              variant="secondary"
              loading={portal.isPending}
              onClick={() => portal.mutate({ intent: "update-payment" })}
            >
              Update payment
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
