"use client";

import * as React from "react";
import type { SubscriptionView } from "@routeflow/types";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { SubscriptionStrip } from "@/components/SubscriptionStrip";
import { usePaidTransition } from "@/lib/billing-paid-notice";
import {
  bannerRoleOf,
  ownsBillingBanner,
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
 * shift, and a permanent blank gap for every healthy workspace would be worse. Same fixed heights as the strip.
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
      className="h-8 shrink-0 md:h-9"
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
  const role = bannerRoleOf(userRole);
  const state =
    role && (ownsBillingBanner(view) || view.status === "ACTIVE")
      ? subscriptionBannerState(view, role)
      : null;
  const showing = !!state?.inShell;
  React.useEffect(() => rememberStrip(scope, showing), [scope, showing]);
  if (role && state) {
    return state.inShell ? <SubscriptionStrip view={view} role={role} state={state} /> : null;
  }
  if (ownsBillingBanner(view)) return null; // never "Choose a plan" while an invoice is owed
  return <ReadOnlyBanner status={view.status} readOnlyReason={view.readOnlyReason} compact />;
}
