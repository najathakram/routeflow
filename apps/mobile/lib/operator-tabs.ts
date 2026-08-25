/**
 * Which bottom-nav tab "owns" the operator route you're currently on.
 *
 * The operator bar is rendered in `(operator)/_layout.tsx`, OUTSIDE the `(tabs)`
 * navigator, so it has no navigator state to read a focused index from — 88 of
 * the ~106 operator screens aren't children of that navigator at all. Instead we
 * derive the active tab from the route segments, which works at any depth and
 * for both on-tab and off-tab routes.
 *
 * Pure on purpose: mobile Jest is node-only with no renderer, so this is the
 * part that can actually be tested. See `__tests__/operator-tabs.test.ts`.
 */

export type OperatorTabKey = "home" | "dispatch" | "orders" | "warehouse" | "more";

/** Left-to-right order in the bar. */
export const OPERATOR_TABS: readonly OperatorTabKey[] = [
  "home",
  "dispatch",
  "orders",
  "warehouse",
  "more",
] as const;

export const OPERATOR_TAB_ROOT: Record<OperatorTabKey, string> = {
  home: "/(operator)/(tabs)/home",
  dispatch: "/(operator)/(tabs)/dispatch",
  orders: "/(operator)/(tabs)/orders",
  warehouse: "/(operator)/(tabs)/warehouse",
  more: "/(operator)/(tabs)/more",
};

/**
 * First route segment under `(operator)` → the tab that owns that section.
 *
 * Only sections reachable from a tab's own screens are listed. Everything else
 * falls through to "more", which is correct rather than lazy: `(tabs)/more.tsx`
 * is a hub linking to 27 sections, and every unlisted section here is one of
 * them — so More is literally where the operator came from.
 */
const SECTION_TO_TAB: Readonly<Record<string, OperatorTabKey>> = {
  home: "home",

  dispatch: "dispatch",
  routes: "dispatch",
  "route-runs": "dispatch",
  drivers: "dispatch",
  driver: "dispatch",
  fleet: "dispatch",
  trips: "dispatch",

  orders: "orders",
  "new-order": "orders",

  warehouse: "warehouse",
  products: "warehouse",
  movements: "warehouse",
  pick: "warehouse",
  "purchase-orders": "warehouse",

  more: "more",
};

/**
 * Which tabs the bar should render for the current tenant/loading state.
 *
 * Per-tenant addons gate the Dispatch tab: it fronts the driver/route/fleet
 * surfaces AND the ad-hoc order-delivery entry, so `dispatchAccess` is EITHER
 * feature's access — `recurring_routes || order_delivery || developer_mode`
 * (the master switch). Pure — pass `false` while the addon fetch is loading so
 * the tab never flashes then vanishes (see `OperatorTabBar`, which composes it
 * from `useRoutesAccess`/`useDeliveryAccess`).
 */
export function visibleOperatorTabs(dispatchAccess: boolean): OperatorTabKey[] {
  return dispatchAccess ? [...OPERATOR_TABS] : OPERATOR_TABS.filter((t) => t !== "dispatch");
}

/** expo-router segments keep their parens: "(operator)", "(tabs)". */
const isGroup = (s: string) => s.startsWith("(") && s.endsWith(")");

/**
 * Never returns null — an operator route with no mapping highlights More. A bar
 * with nothing lit reads as broken.
 */
export function activeOperatorTab(segments: readonly string[]): OperatorTabKey {
  const start = segments.indexOf("(operator)");
  if (start === -1) return "more";
  // The owning section is segments[start+2] inside (tabs) and segments[start+1]
  // outside it — "first non-group" covers both without hardcoding either, and
  // survives someone adding another route group later.
  const section = segments.slice(start + 1).find((s) => !isGroup(s));
  if (!section) return "home"; // bare /(operator)
  return SECTION_TO_TAB[section] ?? "more";
}
