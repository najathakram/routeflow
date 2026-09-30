"use client";

import * as React from "react";
import { Card, useToast } from "@routeflow/ui/web";
import type { FlagKey } from "@routeflow/types";
import type { SubscriptionView } from "@/lib/api/billing";
import { setRouteLocked } from "@/lib/plan-gate-lock";
import { LockedPage } from "./PlanGates";

/**
 * The plan-flag gate decision for one route, isolated from RouteGuard's addon-redirect
 * effect so it's unit-testable on its own (PlanGateBoundary.test.tsx). Lives in its own
 * file (not layout.tsx) because a named export from an App Router `layout.tsx` fails
 * `next build`'s layout-file export check (B449 fix-round finding 1).
 *
 * B449: while `planGateKey` is set and the answer is still resolving, this must render
 * NEITHER the real page NOR the lock — mounting the page here would fire its data
 * queries and let a LITE tenant see a flash of gated content (plus whatever inline
 * error those 403s produce) before the lock appears a moment later. Once resolved
 * (success OR error — a fetch failure fails OPEN, same as before), render exactly one
 * of: the lock (children never mount, so the gated page's own queries never fire) or
 * the real page.
 *
 * B449 fix-round finding 2: when this decides "locked", it is the ONLY source of the
 * navigation's plan-gate notice — it fires the toast itself, naming THIS route's own
 * gate tier, and marks the pathname locked via `setRouteLocked` so `PlanGateNotice`
 * refuses to let a stray 403 from some other widget add a second, possibly
 * contradictory one. The notice never comes from a 403 here.
 */
export function PlanGateBoundary({
  planGateKey,
  pathname,
  subscription,
  subscriptionResolved,
  subscriptionErrored,
  children,
}: {
  planGateKey: FlagKey | null;
  pathname: string;
  subscription: SubscriptionView | undefined;
  subscriptionResolved: boolean;
  subscriptionErrored: boolean;
  children: React.ReactNode;
}) {
  const { toast } = useToast();
  const flags = subscription?.flags;
  const planLocked =
    !!planGateKey && subscriptionResolved && flags !== undefined && !flags.includes(planGateKey);
  const gateMessage = `This feature isn't included in the ${subscription?.planName ?? "current"} plan.`;
  const secondary = "Want it? Contact us to upgrade.";

  React.useEffect(() => {
    if (!planLocked) return;
    setRouteLocked(pathname, true);
    toast({ title: gateMessage, description: secondary, variant: "warning" });
    return () => setRouteLocked(pathname, false);
    // `toast` is a stable useCallback identity (Toast.tsx's ToastProvider), so
    // including it here never causes an extra re-toast on its own.
  }, [planLocked, pathname, gateMessage, toast]);

  if (planGateKey && !subscriptionResolved && !subscriptionErrored) {
    return (
      <div className="flex min-h-[60vh] w-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (planLocked) {
    return (
      <LockedPage
        gate={{
          code: "PLAN_GATE",
          flag: planGateKey as string,
          message: gateMessage,
          upgrade: {
            planKey: null,
            planMonthlyPrice: null,
            addonSku: null,
            addonMonthlyPrice: null,
          },
        }}
        secondary={secondary}
      >
        <Card className="h-64" />
      </LockedPage>
    );
  }

  return <>{children}</>;
}
