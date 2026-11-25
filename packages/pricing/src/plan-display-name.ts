/**
 * SA-1254 V7 / SA-1261 rule 9 (P-45): the ONE display name of a plan key, for every customer-facing
 * text (errors, banners, emails), shared by the API, the web and mobile. No customer text prints a
 * raw plan key. CORE reads "Essentials" and ALL_IN reads "Pro"; every other key reads as it does
 * today. The old $249 Growth's label (TEAM rows, "Growth (original)" if the census is above zero)
 * waits for the census, so a legacy alias has no name here yet.
 *
 * It lives here, not in @routeflow/types, because this is the one shared package the API may
 * value-import (it ships a compiled `dist`; see no-runtime-workspace-imports.spec.ts).
 *
 * Every plan key must have a name: apps/api/src/billing/plan-display-name.parity.spec.ts fails
 * when a PLAN_KEYS member is missing here, so the PLUS PR (if the census is above zero) names it
 * in the same diff.
 */
export const PLAN_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  LITE: "Lite",
  STARTER: "Starter",
  CORE: "Essentials",
  GROWTH: "Growth",
  ALL_IN: "Pro",
  SCALE: "Scale",
  ENTERPRISE: "Enterprise",
});

/**
 * The plan's display name ("Essentials" for CORE), or undefined for a key this build does not
 * name (a legacy alias, a custom or misspelled key). A caller writes its own fallback words
 * ("your plan") and never the key itself.
 */
export function planDisplayName(planKey: string | null | undefined): string | undefined {
  if (!planKey || !Object.prototype.hasOwnProperty.call(PLAN_DISPLAY_NAMES, planKey))
    return undefined;
  return PLAN_DISPLAY_NAMES[planKey];
}
