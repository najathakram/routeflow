import { BadgePercent, Handshake, MapPin, ShieldCheck, Store, Truck } from "lucide-react";
import { driverNavItemVisible } from "@/lib/portal-routing";
import { matchPlanGatedRoute, modeGatedVisible, planFlagVisible } from "@/lib/plan-gated-nav";
import {
  CUSTOMER_NAV,
  DRIVER_NAV,
  INSIGHTS_LEAF,
  OPERATOR_NAV,
  type NavEntry,
  type NavLeaf,
} from "./nav-config";

/**
 * Everything the sidebar needs to decide which entries exist. The dashboard layout reads these
 * from its hooks and passes them in; this module reads nothing itself, so the whole menu is one
 * pure function of its context (UX guide improvement 3; the seam improvement 10 will read).
 */
export type OperatorNavContext = {
  role: string | undefined;
  canActAsDriver: boolean | undefined;
  routesAccess: boolean;
  deliveryAccess: boolean;
  addonsLoading: boolean;
  hasSalesAgents: boolean;
  counterEnabled: boolean;
  regulatedLoading: boolean;
  regulatedSections: ReadonlyArray<{ id: string; name: string }> | undefined;
  /** useInsightsAccess(): may this viewer open Product insights? (the same predicate as every other entry to it) */
  insightsAccess: boolean;
  plan: { flags: readonly string[] | undefined; resolved: boolean; failed: boolean };
  modes?: Readonly<Record<string, string>>;
};

function getNavForRole(
  role: string | undefined,
  canActAsDriver: boolean | undefined,
  access: { routesAccess: boolean; deliveryAccess: boolean },
  addonsLoading = false,
): NavEntry[] {
  const { routesAccess, deliveryAccess } = access;
  if (role === "CUSTOMER") return CUSTOMER_NAV;
  if (role === "DRIVER") {
    // Drivers run both recurring routes and ad-hoc delivery trips, so "My
    // Routes"/"Today's route" need either surface unlocked — not just
    // recurring routes. GET /route-runs/my-runs is gated the same way
    // server-side (RouteRunsController's own @RequireAddon).
    return DRIVER_NAV.filter((e) => e.kind !== "leaf" || driverNavItemVisible(e.href, access));
  }

  // Tenants without either addon never see the Dispatch group — it's gated
  // on having at least one of the two features.
  const showDispatchGroup = routesAccess || deliveryAccess;
  let baseNav = OPERATOR_NAV.filter(
    (entry) => !(entry.kind === "group" && entry.label === "Dispatch" && !showDispatchGroup),
  ).map((entry): NavEntry => {
    if (entry.kind !== "group" || entry.label !== "Dispatch") return entry;
    // Inside a visible Dispatch group, the routes/delivery leaves are each
    // gated on their own feature; the Dispatch overview and Drivers are shared by both
    // and always render once the group itself is showing.
    return {
      ...entry,
      children: entry.children.filter((c) => {
        if (c.href === "/routes") return routesAccess;
        if (c.href === "/deliveries") return deliveryAccess;
        return true;
      }),
    };
  });

  // Shipments lives in Dispatch; a tenant without that group keeps it at the end of Orders so the page
  // is still one click away. While the addons query is in flight Dispatch is absent only because it is
  // unresolved, so Shipments waits for the answer instead of hopping groups.
  if (!showDispatchGroup && !addonsLoading) {
    baseNav = baseNav.map((entry): NavEntry => {
      if (entry.kind !== "group" || entry.label !== "Orders") return entry;
      return {
        ...entry,
        children: [
          ...entry.children,
          { kind: "leaf", label: "Shipments", href: "/shipments", icon: Truck },
        ],
      };
    });
  }

  // Operators who can also act as drivers get "My Routes" inside the
  // Dispatch group instead of as a stand-alone top-level item.
  if (canActAsDriver && showDispatchGroup) {
    baseNav = baseNav.map((entry): NavEntry => {
      if (entry.kind === "group" && entry.label === "Dispatch") {
        const alreadyHasMyRoutes = entry.children.some((c) => c.href === "/routes/my-runs");
        if (alreadyHasMyRoutes) return entry;
        return {
          ...entry,
          children: [
            ...entry.children,
            { kind: "leaf", label: "My Routes", href: "/routes/my-runs", icon: MapPin },
          ],
        };
      }
      return entry;
    });
  }

  return baseNav; // OPERATOR, SUPER_ADMIN, TENANT_ADMIN, unknown
}

/**
 * Lite-L2 (WP8): drop every nav leaf whose href is a plan-gated route
 * (`PLAN_GATED_NAV`) the current plan doesn't grant — `planFlagVisible` gives the
 * three-valued rule (hidden while loading, shown on a fetch failure). A leaf not in
 * PLAN_GATED_NAV is always kept. A group left with zero children after filtering is
 * dropped entirely (same precedent as the Dispatch-group filter above).
 */
function filterPlanGatedNav(
  entries: NavEntry[],
  planState: { flags: readonly string[] | undefined; resolved: boolean; failed: boolean },
  modes?: Readonly<Record<string, string>>,
): NavEntry[] {
  const isVisible = (href: string): boolean => {
    // SA-1032: a back-office config mode (e.g. promotions off) hides its page's entry.
    if (!modeGatedVisible(href, modes)) return false;
    const key = matchPlanGatedRoute(href);
    if (!key) return true;
    return planFlagVisible({
      enabled: planState.flags === undefined || planState.flags.includes(key),
      resolved: planState.resolved,
      failed: planState.failed,
    });
  };
  return entries.reduce<NavEntry[]>((acc, entry) => {
    if (entry.kind === "leaf") {
      if (isVisible(entry.href)) acc.push(entry);
      return acc;
    }
    if (entry.kind === "group") {
      const children = entry.children.filter((c) => isVisible(c.href));
      if (children.length > 0) acc.push({ ...entry, children });
      return acc;
    }
    acc.push(entry); // skeleton
    return acc;
  }, []);
}

/** Product insights is added, never removed: only a viewer who may use it gets the leaf (last child of Reports & analytics). */
function withInsights(entries: NavEntry[], insightsAccess: boolean): NavEntry[] {
  if (!insightsAccess) return entries;
  return entries.map((entry): NavEntry =>
    entry.kind === "group" && entry.label === "Reports & analytics"
      ? { ...entry, children: [...entry.children, INSIGHTS_LEAF] }
      : entry,
  );
}

export function buildOperatorNav(ctx: OperatorNavContext): NavEntry[] {
  const { role, counterEnabled, addonsLoading, hasSalesAgents, regulatedLoading } = ctx;
  const isStaff = role !== "CUSTOMER" && role !== "DRIVER";
  const nav = getNavForRole(
    role,
    ctx.canActAsDriver,
    { routesAccess: ctx.routesAccess, deliveryAccess: ctx.deliveryAccess },
    addonsLoading,
  );

  // CUSTOMER/DRIVER nav has neither a Dispatch nor a Sales Agents entry, so
  // the skeleton splicing below only applies to the operator-ish (isStaff)
  // branch. While the shared addons fetch is in flight, `enabled` defaults
  // false and getNavForRole already omitted Dispatch — hold a skeleton at
  // its position (right before Customers) so the rail doesn't grow once the
  // real answer resolves.
  let base = nav;
  if (isStaff && addonsLoading) {
    const idx = base.findIndex((e) => e.kind === "leaf" && e.href === "/customers");
    const skeleton: NavEntry = { kind: "skeleton", key: "dispatch-skeleton" };
    base = idx === -1 ? [...base, skeleton] : [...base.slice(0, idx), skeleton, ...base.slice(idx)];
  }

  if (!isStaff) return base;

  // POS-7a: "Counter" is the FIRST child of the Orders group (above All Orders): the single-active
  // matcher then lights only Counter on /orders/counter-sale; nothing else moves.
  if (counterEnabled) {
    base = base.map((entry): NavEntry =>
      entry.kind === "group" && entry.label === "Orders"
        ? {
            ...entry,
            children: [
              { kind: "leaf", label: "Counter", href: "/orders/counter-sale", icon: Store },
              ...entry.children,
            ],
          }
        : entry,
    );
  }

  // "Regulated Items" nav group — one child per active regulated section, each
  // opening that section's dashboard. Shown whenever the tenant has ≥1 section
  // (an empty group is never spliced); a skeleton holds its place while the
  // tracked-categories fetch is still in flight.
  const inject: NavEntry[] = [];
  const sections = ctx.regulatedSections ?? [];
  if (regulatedLoading) {
    inject.push({ kind: "skeleton", key: "regulated-skeleton" });
  } else if (sections.length > 0) {
    inject.push({
      kind: "group",
      label: "Regulated items",
      icon: ShieldCheck,
      children: sections.map((s) => ({
        kind: "leaf" as const,
        label: s.name,
        href: `/compliance/${s.id}`,
        icon: ShieldCheck,
      })),
    });
  }

  if (addonsLoading) {
    // Sales Agents (+ its Commissions child inside Finance) pops in off the
    // same addons fetch as Dispatch — hold a skeleton at the leaf's position
    // (right after Customers) meanwhile.
    const idx = base.findIndex((e) => e.kind === "leaf" && e.href === "/customers");
    const skeleton: NavEntry = { kind: "skeleton", key: "sales-agents-skeleton" };
    base =
      idx === -1
        ? [...base, skeleton]
        : [...base.slice(0, idx + 1), skeleton, ...base.slice(idx + 1)];
  } else if (hasSalesAgents) {
    // "Sales Agents" as a top-level leaf right after Customers; "Commissions"
    // at the end of the Finance group. Same splice style as
    // the canActAsDriver Dispatch rewrite above — never mutate OPERATOR_NAV.
    base = base.flatMap((entry): NavEntry[] => {
      if (entry.kind === "leaf" && entry.href === "/customers") {
        return [
          entry,
          { kind: "leaf", label: "Sales agents", href: "/sales-agents", icon: Handshake },
        ];
      }
      if (entry.kind === "group" && entry.label === "Finance") {
        const child: NavLeaf = {
          kind: "leaf",
          label: "Commissions",
          href: "/finance/commissions",
          icon: BadgePercent,
        };
        return [{ ...entry, children: [...entry.children, child] }];
      }
      return [entry];
    });
  }

  // Lite-L2 (WP8/R4.3): hide gated leaves before the Reports & analytics-relative inject index
  // is computed, so Regulated Items still lands in the right spot even when that group is hidden
  // (reports and analytics are both in PLAN_GATED_NAV).
  base = filterPlanGatedNav(withInsights(base, ctx.insightsAccess), ctx.plan, ctx.modes);

  if (inject.length === 0) return base;

  const idx = base.findIndex((e) => e.kind === "group" && e.label === "Reports & analytics");
  return idx === -1
    ? [...base, ...inject]
    : [...base.slice(0, idx + 1), ...inject, ...base.slice(idx + 1)];
}
