import { isAlwaysEnforcedPlan, FLAG_KEYS } from "./plan-catalog.constants";
import { addonGateState, featureDefByKey, gateVia } from "./feature-registry";
import { creditLimitCheckApplies } from "../orders/credit-limit-guard";

/**
 * Flags whose server-side enforcement the 2026-08-23 rollout (and the WP2 Lite
 * extension of it) introduces — these, and ONLY these, are muted by the
 * PLAN_FLAG_ENFORCEMENT kill switch for a tenant that is NOT on an always-enforced
 * plan (see {@link isAlwaysEnforcedPlan}). Any gate not listed here was already live
 * before the switch existed (flag.msrp, shipped in #411) and must keep enforcing
 * regardless of the env. REMOVE this set along with the switch (review by 2027-01-31).
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

/**
 * Feature grants v2 (design 2026-09-17 §2), Opus review of 9923b87c item 2: the EXACT
 * algorithm `SubscriptionService.getSubscription()` uses to build its `flags` array,
 * extracted so `/tenants/me/features`'s `served` field can call the SAME function —
 * provably identical by construction, not a re-derivation that could silently drift from
 * it. Order matters: dark-flag courtesy first (FLAG_KEYS ∪ entFlags), THEN the
 * RequirePlanFlag-gated override merge (GRANT adds, DENY removes) — an override on an
 * addon-keyed or unrouted key never belongs in this array (see gateVia's own doc comment).
 */
export function computeServedFlags(
  planKey: string,
  entFlags: readonly string[],
  overrides: ReadonlyMap<string, "GRANT" | "DENY">,
  env = process.env,
): string[] {
  const flagSet = new Set<string>([
    ...FLAG_KEYS.filter((k) => allowsFlag({ planKey, flags: entFlags }, k, env)),
    ...entFlags,
  ]);
  for (const [key, effect] of overrides) {
    if (gateVia(key) !== "RequirePlanFlag") continue;
    if (effect === "GRANT") flagSet.add(key);
    else flagSet.delete(key);
  }
  return Array.from(flagSet);
}

/**
 * SA-1100 §3 — the ONE courtesy predicate: "the answer today's guards serve for this key (or any-of
 * key set) came from the courtesy allow", not from the plan, an add-on or an override. The
 * entitlement sweep puts it on the wire as `SweepBits.courtesy` (the compare script cannot import the
 * API), and WP2's resolver imports this same function — never a second copy of the clauses.
 *
 * Three clauses, by gate:
 *  1. the credit check (`gate.via === "service" && gate.envSwitched`, SA-1099 §1 third clause):
 *     courtesy while `creditLimitCheckApplies(switch, false)` — the check runs for everyone unless
 *     the switch is exactly "on" — with NO always-enforced exception and no override reading (the
 *     guard ignores both while the switch is not "on");
 *  2. an add-on keyed gate (`RequireAddon` / `guard`): exactly `decideAddonAccess`'s "dark"
 *     outcome — no GRANT override, no key held (row or default grant) that a DENY does not rule out,
 *     every key left a dark gate, and a plan that is not always enforced;
 *  3. a plan-flag keyed gate (everything else): no override, a dark flag (`isDarkFlag`) on a plan
 *     that is not always enforced and does not carry the flag (`allowsFlag`'s courtesy line).
 */
export interface CourtesyFacts {
  /** One registry key, or the keys of one any-of `@RequireAddon(a, b, ...)` set. */
  keys: readonly string[];
  planKey: string;
  /** The plan's own flags (`Entitlements.flags`), no courtesy folded in. */
  planFlags: readonly string[];
  /** Active overrides (`FeatureOverrideService.allActive`). */
  overrides: ReadonlyMap<string, "GRANT" | "DENY">;
  /** Add-on keys held through a row or a default grant (`AddonService.getActiveAddons`). */
  held: ReadonlySet<string>;
}

export function isCourtesyServed(facts: CourtesyFacts, env = process.env): boolean {
  const { keys, planKey, planFlags, overrides, held } = facts;
  if (keys.length === 0) return false;
  const first = keys[0];

  const gate = featureDefByKey(first)?.gate;
  if (gate?.via === "service" && gate.envSwitched) {
    return creditLimitCheckApplies(env.PLAN_FLAG_ENFORCEMENT, false);
  }

  if (isAlwaysEnforcedPlan(planKey)) return false;

  const via = gateVia(first);
  if (via === "RequireAddon" || via === "guard") {
    if (keys.some((k) => overrides.get(k) === "GRANT")) return false;
    if (keys.some((k) => overrides.get(k) !== "DENY" && held.has(k))) return false;
    const remaining = keys.filter((k) => overrides.get(k) !== "DENY");
    return remaining.length > 0 && remaining.every((k) => addonGateState(k) === "dark");
  }

  if (overrides.has(first)) return false;
  return isDarkFlag(first, env) && !planFlags.includes(first);
}
