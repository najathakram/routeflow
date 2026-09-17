import type { FlagKey } from "@routeflow/types";

/**
 * Lite-L2 (WP7): the web sidebar hrefs gated behind a plan feature flag — a subset of
 * OPERATOR_NAV (apps/web/app/(dashboard)/layout.tsx:90-153), limited to hrefs that actually
 * exist there today. `/sales-agents`, `/finance/commissions`, and the dispatch/routes/
 * deliveries/drivers surfaces stay on their existing addon hooks (useHasAddon/useRoutesAccess/
 * useDeliveryAccess) — they are NOT added here.
 */
export const PLAN_GATED_NAV: Readonly<Record<string, FlagKey>> = {
  "/returns": "flag.returns",
  "/suppliers": "flag.suppliers",
  "/vendor-bills": "flag.ap_bills",
  "/estimates": "flag.estimates",
  "/credit-notes": "flag.credit_notes",
  "/finance/reports": "flag.reports",
  "/analytics": "flag.analytics",
  // P0 lock-mirror hotfix: recurring invoices has no sidebar entry (it's reached from
  // within Invoices, not its own nav item) but IS its own route and its own
  // @RequirePlanFlag("flag.recurring_invoices") gate server-side — PLAN_GATED_NAV had
  // no entry for it at all, so a denied tenant deep-linking to /invoices/recurring got
  // an unhandled 403 instead of the graceful lock every other plan-gated route shows.
  "/invoices/recurring": "flag.recurring_invoices",
};

export type PlanFlagState = { enabled: boolean; resolved: boolean; failed: boolean };

/** Three-valued visibility rule (mirrors lib/api/addons.ts): resolved ⇒ go by the flag;
 *  unresolved (still loading) ⇒ hidden (no flash of a soon-to-vanish item); the fetch
 *  itself failed ⇒ shown (client fails OPEN — the server guard remains the authority and
 *  fails CLOSED, so a transient 5xx never stalls a paying tenant out of their own nav). */
export const planFlagVisible = (s: PlanFlagState) => (s.resolved ? s.enabled : s.failed);

/** The PLAN_GATED_NAV entry matching `pathname` (exact or prefix), if any. */
export function matchPlanGatedRoute(pathname: string): FlagKey | null {
  for (const [prefix, key] of Object.entries(PLAN_GATED_NAV))
    if (pathname === prefix || pathname.startsWith(prefix + "/")) return key;
  return null;
}
