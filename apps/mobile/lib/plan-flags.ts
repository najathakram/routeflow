import type { FlagKey } from "@routeflow/types";

/**
 * Lite-L2 (WP11): the operator route-group sections gated behind a plan feature flag.
 * `expenses`, `finance`, `purchase-orders`, and `statements` are NOT gated. Mirrors web's
 * `lib/plan-gated-nav.ts` PLAN_GATED_NAV, adapted to mobile's route-group segments
 * instead of web hrefs.
 */
export const PLAN_GATED_SECTIONS: Readonly<Record<string, FlagKey>> = {
  estimates: "flag.estimates",
  "recurring-invoices": "flag.recurring_invoices",
  "credit-notes": "flag.credit_notes",
  returns: "flag.returns",
  suppliers: "flag.suppliers",
  "vendor-bills": "flag.ap_bills",
  analytics: "flag.analytics",
  reports: "flag.reports",
  messages: "flag.messaging",
};

/**
 * Which PLAN_GATED_SECTIONS key (if any) `segments` — expo-router's useSegments() —
 * denies, given the tenant's resolved flags. Mirrors (operator)/_layout.tsx's own
 * sectionNeed(): the section is the first path component after "(operator)" that
 * isn't itself a route group (doesn't start with "("). Unknown/unresolved/failed all
 * fail OPEN (never lock on an unknown answer) — only a POSITIVELY resolved-and-denied
 * flag locks the screen.
 */
export function planLockedSection(
  segments: readonly string[],
  s: { flags: readonly string[]; resolved: boolean; failed: boolean },
): FlagKey | null {
  const section = segments
    .slice(segments.indexOf("(operator)") + 1)
    .find((x) => !x.startsWith("("));
  const key = section ? PLAN_GATED_SECTIONS[section] : undefined;
  if (!key || !s.resolved || s.failed) return null; // unknown => fail OPEN
  return s.flags.includes(key) ? null : key;
}

/** Same {enabled, resolved, failed} contract as web's `lib/plan-gated-nav.ts` — needed
 *  here too for WP12's More-screen row hiding (`planFlagVisible(usePlanFlag(key))`). */
export type PlanFlagState = { enabled: boolean; resolved: boolean; failed: boolean };

/** Three-valued visibility rule (mirrors lib/api/addons.ts): resolved ⇒ go by the flag;
 *  unresolved ⇒ hidden (no flash of a soon-to-vanish row); fetch failed ⇒ shown (client
 *  fails OPEN — the server guard remains the authority and fails CLOSED). */
export const planFlagVisible = (s: PlanFlagState) => (s.resolved ? s.enabled : s.failed);
