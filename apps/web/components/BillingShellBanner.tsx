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
export function BillingShellBanner({
  view,
  userRole,
}: {
  view: SubscriptionView;
  userRole: string | undefined;
}) {
  usePaidTransition(view);
  const role = bannerRoleOf(userRole);
  if (role && (ownsBillingBanner(view) || view.status === "ACTIVE")) {
    const state = subscriptionBannerState(view, role);
    return state.inShell ? <SubscriptionStrip view={view} role={role} state={state} /> : null;
  }
  if (ownsBillingBanner(view)) return null; // never "Choose a plan" while an invoice is owed
  return <ReadOnlyBanner status={view.status} readOnlyReason={view.readOnlyReason} compact />;
}
