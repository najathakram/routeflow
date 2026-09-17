"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { useSubscription } from "@/lib/api/billing";
import { useRoutesAccess, useDeliveryAccess } from "@/lib/api/addons";
import { matchPlanGatedRoute } from "@/lib/plan-gated-nav";
import { PlanGateBoundary } from "./PlanGateBoundary";

/**
 * Moved out of `(dashboard)/layout.tsx` (B449 fix-round finding 1/5): a named export
 * from an App Router `layout.tsx` fails `next build`'s layout-file export check, and
 * this needs to be importable on its own for a wiring test (RouteGuard.test.tsx) that
 * proves it never wraps `children` inside `LockedPage` itself — the composition bug
 * that shipped in #777 and B449 fixed.
 */

// ─── Role-based route guard ───────────────────────────────────────────────────

/** Paths that CUSTOMER users may access (prefix-matched) */
const CUSTOMER_ALLOWED: string[] = ["/dashboard", "/orders", "/returns", "/invoices", "/settings"];
/** Paths that DRIVER users may access (prefix-matched) */
const DRIVER_ALLOWED: string[] = ["/dashboard", "/routes", "/settings"];
/**
 * In-development surfaces gated per-feature addon (owner decision 2026-08-25:
 * recurring routes and ad-hoc order delivery are separate addons; owner
 * decision 2026-08-28: `devMode` no longer unlocks either one client-side).
 * `/drivers` is shared by both features ("either").
 */
const GATED_PREFIXES: { prefix: string; need: "routes" | "delivery" | "either" }[] = [
  { prefix: "/dispatch", need: "either" },
  { prefix: "/routes", need: "routes" },
  { prefix: "/deliveries", need: "delivery" },
  { prefix: "/drivers", need: "either" },
];

function isPathAllowed(pathname: string, allowed: string[]): boolean {
  return allowed.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/**
 * The `/routes` paths that are recurring-routes surfaces in their own right.
 * Everything else under `/routes` is a single run/template/my-runs detail page
 * shared by BOTH features: an ad-hoc delivery has no detail page of its own —
 * a dispatched one opens its run at `/routes/:id` (where the builder also lands
 * after a successful dispatch) and a draft opens the template it was built as
 * at `/routes/templates/:id`. Gating those on "routes" would bounce a
 * delivery-only tenant to /dashboard from every delivery it opens.
 */
const RECURRING_ROUTES_PATHS = new Set(["/routes", "/routes/create"]);

/**
 * Find the GATED_PREFIXES entry matching `pathname`, if any. The legacy
 * `/routes/trips*` pages are redirect stubs to `/deliveries`/`/deliveries/new`
 * — they must NOT be bounced by the `/routes` gate, or a delivery-only tenant
 * deep-linking there would land on /dashboard before the stub ever gets to
 * redirect it to the (correctly gated) /deliveries surface.
 *
 * `role` matters for `/routes` itself: a DRIVER's whole nav is "My Routes" →
 * `/routes`, shown whenever EITHER feature is unlocked (drivers run ad-hoc
 * deliveries too), so for that role the landing page must be "either" as well
 * or the only link a delivery-only tenant's driver has bounces to /dashboard.
 */
function matchGatedPrefix(
  pathname: string,
  role?: string,
): { prefix: string; need: "routes" | "delivery" | "either" } | null {
  for (const gated of GATED_PREFIXES) {
    if (pathname !== gated.prefix && !pathname.startsWith(gated.prefix + "/")) continue;
    if (gated.prefix === "/routes") {
      if (pathname === "/routes/trips" || pathname.startsWith("/routes/trips/")) continue;
      if (role === "DRIVER" || !RECURRING_ROUTES_PATHS.has(pathname))
        return { ...gated, need: "either" };
    }
    return gated;
  }
  return null;
}

export function RouteGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const { enabled: routesAccess, resolved: routesResolved } = useRoutesAccess();
  const { enabled: deliveryAccess, resolved: deliveryResolved } = useDeliveryAccess();
  // Lite-L2 (WP8): CUSTOMER/DRIVER branches are untouched by plan-flag gating — the
  // GATED_PREFIXES/CUSTOMER_ALLOWED/DRIVER_ALLOWED checks below already cover their
  // access. `enabled: isStaffRole` mirrors the endpoint's own @Roles(OPERATOR) gate.
  const isStaffRole = user?.role !== "CUSTOMER" && user?.role !== "DRIVER";
  // `isError` is read too (B449): while a plan-gated route's flags are still
  // resolving we must show neither the real page nor the lock — only once we
  // know which applies. An errored fetch counts as "done deciding" the same
  // way success does (fail OPEN, render the page), so it must not be stuck on
  // the resolving branch forever.
  const {
    data: subscription,
    isSuccess: subscriptionResolved,
    isError: subscriptionErrored,
  } = useSubscription({
    staleTime: 60_000,
    enabled: isStaffRole,
  });

  React.useEffect(() => {
    const role = user?.role;
    if (!role) return;
    let allowed: string[] | null = null;
    if (role === "CUSTOMER") allowed = CUSTOMER_ALLOWED;
    if (role === "DRIVER") allowed = DRIVER_ALLOWED;
    if (allowed && !isPathAllowed(pathname, allowed)) {
      router.replace("/dashboard");
      return;
    }
    // Tenants without the relevant addon can't deep-link into
    // dispatch/routes/deliveries/drivers either — gated per-feature.
    const gate = matchGatedPrefix(pathname, role);
    if (!gate) return;
    // Gating on `resolved` (not just "not loading") is mandatory: it fails OPEN
    // while the addons query is in flight AND when it errored, so a tenant that
    // actually has access is never bounced on an unknown answer.
    const resolved =
      gate.need === "routes"
        ? routesResolved
        : gate.need === "delivery"
          ? deliveryResolved
          : routesResolved || deliveryResolved;
    if (!resolved) return;
    const allowedByGate =
      gate.need === "routes"
        ? routesAccess
        : gate.need === "delivery"
          ? deliveryAccess
          : routesAccess || deliveryAccess;
    if (!allowedByGate) {
      router.replace("/dashboard");
    }
  }, [
    user?.role,
    pathname,
    router,
    routesAccess,
    routesResolved,
    deliveryAccess,
    deliveryResolved,
  ]);

  // Lite-L2 (WP8/R4.5): a deep link/bookmark into a plan-gated route the tenant's
  // current plan doesn't grant renders the locked panel in place of the page — never
  // a redirect (unlike the addon-gated prefixes above), so the URL stays intact and
  // "See plans" is one click away.
  const planGateKey = isStaffRole ? matchPlanGatedRoute(pathname) : null;

  return (
    <PlanGateBoundary
      planGateKey={planGateKey}
      pathname={pathname}
      subscription={subscription}
      subscriptionResolved={subscriptionResolved}
      subscriptionErrored={subscriptionErrored}
    >
      {children}
    </PlanGateBoundary>
  );
}
