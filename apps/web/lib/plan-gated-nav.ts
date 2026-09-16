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
