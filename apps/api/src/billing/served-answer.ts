import { isDefaultGrantedAddon, type FeatureDef } from "./feature-registry";
import { addonGateState } from "./addon-gate-registry";
import { allowsFlag, isDarkFlag } from "./plan-flag-policy";
import { creditLimitCheckApplies } from "../orders/credit-limit-guard";

/**
 * The ONE "what do today's guards serve for this registry key" function (the sweep's `old` column and the
 * explain trace read it through `EntitlementAuthority.computeOldPathAll`; SA-1100 §1's pilot-ending rule reads
 * the same function with the ending override left out). It is a pure function of the facts below, so a caller
 * can ask "and what if this override were gone?" without a second copy of the rules.
 *
 * The env-switched service gate (the credit check) goes FIRST, with its own rule (SA-1099 A-1): the guard
 * runs the check for everyone unless the switch is exactly "on", and ignores overrides while it does
 * (`creditLimitCheckApplies`). Every other key: override first and absolute (GRANT serves, DENY refuses);
 * then an add-on keyed gate serves a held row, a default grant, or the dark-gate courtesy for a plan that
 * is not always enforced; every other key is a plan flag (`allowsFlag`, which folds in the dark-flag
 * courtesy).
 */
export interface ServedAnswerFacts {
  /** The plan's entitlements, or null when they could not be resolved (an add-on default grant then fails closed). */
  ent: { planKey: string; flags: readonly string[] } | null;
  /** The ACTIVE overrides that count for this answer. */
  overrides: ReadonlyMap<string, "GRANT" | "DENY">;
  /** `addonKey` of every active `TenantAddon` row (paid or comp). */
  activeAddonKeys: ReadonlySet<string>;
  /** The plan never gets the dark-gate courtesy (`isAlwaysEnforcedPlan`). */
  isAlwaysEnforced: boolean;
}

export function servedAnswer(
  feature: Pick<FeatureDef, "key" | "gate" | "defaultGranted" | "requires">,
  facts: ServedAnswerFacts,
  env = process.env,
): boolean {
  const { ent, overrides, activeAddonKeys, isAlwaysEnforced } = facts;
  const override = overrides.get(feature.key);

  if (feature.gate.via === "service" && feature.gate.envSwitched) {
    // SA-1099 A-1: the guard's own rule over the guard's own read (EntitlementsService.hasFlag:
    // override first, then the plan flag; a failed resolve runs the check, as the guard's catch does)
    const tenantHasFlag = override
      ? override === "GRANT"
      : ent
        ? ent.flags.includes(feature.key)
        : true;
    return creditLimitCheckApplies(env.PLAN_FLAG_ENFORCEMENT, tenantHasFlag);
  }

  if (override === "GRANT") return true;
  if (override === "DENY") return false;

  const isAddonKeyed = feature.gate.via === "RequireAddon" || feature.gate.via === "guard";
  if (isAddonKeyed) {
    // SA-540 / Opus review of fa6186b9 (M1): the SAME default-grant rule as computeOldPath and
    // AddonService. Fails closed when entitlements could not resolve (ent === null).
    const active =
      activeAddonKeys.has(feature.key) ||
      (ent !== null && isDefaultGrantedAddon(feature, activeAddonKeys, ent.flags, overrides));
    return active || (addonGateState(feature.key) === "dark" && !isAlwaysEnforced);
  }

  return ent ? allowsFlag(ent, feature.key, env) : isDarkFlag(feature.key, env);
}
