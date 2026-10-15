"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import type { SubscriptionView } from "@routeflow/types";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { SubscriptionStrip } from "@/components/SubscriptionStrip";
import { PaymentDueBanner } from "@/components/PaymentDueBanner";
import { usePaymentDue } from "@/lib/api/payment-due";
import { usePaidTransition } from "@/lib/billing-paid-notice";
import {
  bannerRoleOf,
  ownsBillingBanner,
  paymentDueSlot,
  subscriptionBannerState,
} from "@/lib/subscription-banner-state";

/**
 * The dashboard shell's one billing slot (SA-733r6 / B4). A workspace that owes an invoice (grace, last day,
 * paused) or whose card is about to expire gets the billing strip; every other read-only reason (trial ended,
 * cancelled) keeps the existing ReadOnlyBanner. Buyers and drivers never reach this (the shell only reads the
 * subscription for staff) and `bannerRoleOf` returns null for them anyway.
 */
const SHOWN_KEY = "rf.billing.strip-shown";
const shownKey = (scope: string | null) => `${SHOWN_KEY}.${scope ?? "unknown"}`;

/**
 * Reserves the strip's height while the subscription read is still loading, but ONLY for a viewer who had a strip
 * on their previous load (a per-viewer hint in storage): a content jump when the strip appears late is a layout
 * shift, and a permanent blank gap for every healthy workspace would be worse. Same minimum heights as the strip (which now wraps).
 */
export function BillingStripReserve({ scope }: { scope: string | null }) {
  const [reserve] = React.useState(() => {
    try {
      return !!scope && window.localStorage.getItem(shownKey(scope)) === "1";
    } catch {
      return false;
    }
  });
  if (!reserve) return null;
  return (
    <div
      data-testid="subscription-strip-reserve"
      aria-hidden="true"
      className="min-h-8 shrink-0 md:min-h-9"
    />
  );
}

function rememberStrip(scope: string | null, shown: boolean) {
  if (!scope) return;
  try {
    if (shown) window.localStorage.setItem(shownKey(scope), "1");
    else window.localStorage.removeItem(shownKey(scope));
  } catch {
    /* storage unavailable: no reservation next time */
  }
}

export function BillingShellBanner({
  view,
  userRole,
  scope,
}: {
  view: SubscriptionView;
  userRole: string | undefined;
  /** The workspace this viewer is in (tenant slug): scopes every per-viewer memory so a switch never leaks. */
  scope: string | null;
}) {
  usePaidTransition(view, scope);
  const onBillingPage = usePathname()?.startsWith("/settings/billing") ?? false;
  const role = bannerRoleOf(userRole);
  // Row 542: the server's "payment due" read; staff only (the endpoint's own role gate).
  const { data: paymentDue } = usePaymentDue({ enabled: role !== null });
  const state =
    role && (ownsBillingBanner(view) || view.status === "ACTIVE")
      ? subscriptionBannerState(view, role)
      : null;
  const showing =
    !!state?.inShell || (!!state && paymentDueSlot(state, paymentDue) === "payment-due");
  React.useEffect(() => rememberStrip(scope, showing), [scope, showing]);
  if (role && state) {
    const slot = paymentDueSlot(state, paymentDue);
    if (slot === "payment-due") {
      return (
        <PaymentDueBanner
          mode="payment-due"
          due={paymentDue}
          role={role}
          hideBillingLink={onBillingPage}
        />
      );
    }
    if (slot === "failed-renewal") {
      return (
        <PaymentDueBanner
          mode="failed-renewal"
          role={role}
          dismiss={state.dismiss}
          hideBillingLink={onBillingPage}
        />
      );
    }
    return state.inShell ? (
      <SubscriptionStrip view={view} role={role} state={state} hideBillingLink={onBillingPage} />
    ) : null;
  }
  if (ownsBillingBanner(view)) return null; // never "Choose a plan" while an invoice is owed
  return (
    <ReadOnlyBanner
      status={view.status}
      readOnlyReason={view.readOnlyReason}
      overdueAmount={view.openInvoiceAmount}
      billingContactEmail={view.billingContactEmail}
      isAdmin={userRole === "TENANT_ADMIN"}
      hideAction={onBillingPage && view.readOnlyReason !== "trial_expired"}
      compact
    />
  );
}
