"use client";

import * as React from "react";
import { Card } from "@routeflow/ui/web";
import type { FlagKey } from "@routeflow/types";
import type { SubscriptionView } from "@/lib/api/billing";
import { setRouteLocked } from "@/lib/plan-gate-lock";
import { usePageTitle } from "@/lib/page-title-context";
import { navLabelForPath } from "../nav-config";
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
 * navigation's plan-gate notice. The lock card names THIS route and the plan ("Supplier Bills
 * isn't on the Lite plan") and the top-bar title is set here too, since the gated page never
 * mounts. No toast repeats the card; the pathname is still marked locked via `setRouteLocked`
 * so `PlanGateNotice` refuses to let a stray 403 from some other widget add a second, possibly
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
  const { setTitle } = usePageTitle();
  const flags = subscription?.flags;
  const planLocked =
    !!planGateKey && subscriptionResolved && flags !== undefined && !flags.includes(planGateKey);
  const routeLabel = navLabelForPath(pathname);
  const planName = subscription?.planName ?? "current";
  const gateMessage = routeLabel
    ? `${routeLabel} isn't on the ${planName} plan.`
    : `This feature isn't included in the ${planName} plan.`;
  const secondary = "Want it? Contact us to upgrade.";

  React.useEffect(() => {
    if (!planLocked) return;
    // The lock card below is the one notice: no toast repeating it. Marking the pathname locked
    // still stops a stray 403 from some other widget adding a second, contradictory one.
    setRouteLocked(pathname, true);
    // The gated page never mounts, so it cannot set its own top-bar title.
    if (routeLabel) setTitle(routeLabel);
    return () => setRouteLocked(pathname, false);
  }, [planLocked, pathname, routeLabel, setTitle]);

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
        title={routeLabel ? `${routeLabel} isn't on your plan` : undefined}
        secondary={secondary}
      >
        <Card className="h-64" />
      </LockedPage>
    );
  }

  return <>{children}</>;
}
