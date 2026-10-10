"use client";

import * as React from "react";
import { CheckCircle2 } from "lucide-react";
import type { SubscriptionView } from "@routeflow/types";
import { Button, Card } from "@routeflow/ui/web";
import { useBillingPortal } from "@/lib/api/billing";
import { usePaidNotice } from "@/lib/billing-paid-notice";
import { bannerRoleOf, subscriptionBannerState } from "@/lib/subscription-banner-state";

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
}: {
  sub: SubscriptionView;
  userRole: string | undefined;
}) {
  const role = bannerRoleOf(userRole);
  const [paid, clearPaid] = usePaidNotice();
  const portal = useBillingPortal();
  if (!role) return null;
  const state = subscriptionBannerState(sub, role);
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
      {owedCopy && (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="min-w-0 flex-1 text-sm text-slate-800">{owedCopy}</p>
          {state.cardPay && (
            <Button loading={portal.isPending} onClick={() => portal.mutate({ intent: "pay" })}>
              {state.cardPay.label}
            </Button>
          )}
        </Card>
      )}
      {state.cardLine && (
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
