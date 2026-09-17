import { isAlwaysEnforcedPlan } from "./plan-catalog.constants";

/**
 * Flags whose server-side enforcement the 2026-08-23 rollout (and the WP2 Lite
 * extension of it) introduces — these, and ONLY these, are muted by the
 * PLAN_FLAG_ENFORCEMENT kill switch for a tenant that is NOT on an always-enforced
 * plan (see {@link isAlwaysEnforcedPlan}). Any gate not listed here was already live
 * before the switch existed (flag.msrp, shipped in #411) and must keep enforcing
 * regardless of the env. REMOVE this set along with the switch by 2026-10-01.
 */
export const DARK_PLAN_FLAGS: ReadonlySet<string> = new Set([
  "flag.analytics",
  "flag.ap_bills",
  "flag.import_integrations",
  "flag.forecasting",
  "flag.pricing_tiers",
  "flag.reports",
  "flag.returns",
  "flag.estimates",
  "flag.recurring_invoices",
  "flag.credit_notes",
  "flag.suppliers",
  "flag.messaging",
  "addon.buyer_portal",
]);

/**
 * P0 2026-09-17: production flipped PLAN_FLAG_ENFORCEMENT on with #777's five new
 * flags (flag.estimates, flag.recurring_invoices, flag.credit_notes, flag.suppliers,
 * flag.messaging) still missing from the pinned v11 plan catalogs — every non-LITE
 * tenant without a manually-granted flag was denied these features outright. These
 * five stay unconditionally dark (the courtesy allow applies regardless of the kill
 * switch) until the catalog is re-pinned with them. REMOVE this set once that lands.
 */
const PREPIN_DARK_FLAGS: ReadonlySet<string> = new Set([
  "flag.estimates",
  "flag.recurring_invoices",
  "flag.credit_notes",
  "flag.suppliers",
  "flag.messaging",
]);

/** Release toggle: "on" = enforce every gate; anything else (including unset) = dark. */
export const isPlanFlagEnforcementOn = (env = process.env): boolean =>
  (env.PLAN_FLAG_ENFORCEMENT ?? "off") === "on";

/** True when `flagKey` is muted by the PLAN_FLAG_ENFORCEMENT kill switch right now. */
export const isDarkFlag = (flagKey: string, env = process.env): boolean =>
  PREPIN_DARK_FLAGS.has(flagKey) || (DARK_PLAN_FLAGS.has(flagKey) && !isPlanFlagEnforcementOn(env));

/**
 * Whether `ent`'s tenant may pass `flagKey`, folding in the dark-flag courtesy allow —
 * EXCEPT for an always-enforced plan (R3a.7), which never gets the courtesy allow and
 * must actually carry the flag.
 */
export function allowsFlag(
  ent: { planKey: string; flags: readonly string[] },
  flagKey: string,
  env = process.env,
): boolean {
  if (isDarkFlag(flagKey, env) && !isAlwaysEnforcedPlan(ent.planKey)) return true;
  return ent.flags.includes(flagKey);
}
