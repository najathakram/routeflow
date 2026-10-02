import { Injectable } from "@nestjs/common";
import { AddonService } from "./addon.service";
import { EntitlementsService } from "./entitlements.service";
import { FeatureOverrideService, type FeatureOverrideEffect } from "./feature-override.service";
import { addonGateState } from "./addon-gate-registry";

/**
 * The single add-on access decision, shared by `AddonGuard` (HTTP routes) and every non-HTTP
 * entry point that must honour the same gate (e.g. the connected-mailbox send path). One rule:
 * an active GRANT override allows; a held add-on (not DENY-overridden) allows; a key set whose
 * every remaining key is registered `dark` allows with `wouldDeny` (observe-first) unless the
 * tenant is always-enforced; everything else is denied.
 */
export type AddonAccessOutcome = "granted" | "dark" | "denied";

export interface AddonAccessDecision {
  outcome: AddonAccessOutcome;
  /** Active overrides for the keys, so a caller can trace a DENY without a second query. */
  overrides: Map<string, FeatureOverrideEffect>;
}

export interface AddonAccessDeps {
  addonService: Pick<AddonService, "getActiveAddons">;
  entitlements: Pick<EntitlementsService, "isAlwaysEnforcedTenant">;
  featureOverrides: Pick<FeatureOverrideService, "getMany">;
}

export async function decideAddonAccess(
  deps: AddonAccessDeps,
  tenantId: string,
  keys: string[],
): Promise<AddonAccessDecision> {
  // An active override is absolute — decided before the held-addon/dark check, regardless
  // of gate mode. A DENY on one key of an any-of set only rules OUT that key.
  const overrides = await deps.featureOverrides.getMany(tenantId, keys);
  if (keys.some((k) => overrides.get(k) === "GRANT")) return { outcome: "granted", overrides };

  const active = await deps.addonService.getActiveAddons(tenantId, { onlyKeys: keys });
  if (keys.some((k) => overrides.get(k) !== "DENY" && active.includes(k))) {
    return { outcome: "granted", overrides };
  }

  // Keys already ruled out by their own DENY override can never contribute to the dark
  // courtesy allow; an always-enforced tenant (today just LITE) never gets it either.
  const remaining = keys.filter((k) => overrides.get(k) !== "DENY");
  if (
    remaining.length > 0 &&
    remaining.every((k) => addonGateState(k) === "dark") &&
    !(await deps.entitlements.isAlwaysEnforcedTenant(tenantId))
  ) {
    return { outcome: "dark", overrides };
  }
  return { outcome: "denied", overrides };
}

/** Injectable wrapper for non-guard callers (the guard keeps its own constructor). */
@Injectable()
export class AddonAccessService {
  constructor(
    private readonly addonService: AddonService,
    private readonly entitlements: EntitlementsService,
    private readonly featureOverrides: FeatureOverrideService,
  ) {}

  decide(tenantId: string, keys: string[]): Promise<AddonAccessDecision> {
    return decideAddonAccess(
      {
        addonService: this.addonService,
        entitlements: this.entitlements,
        featureOverrides: this.featureOverrides,
      },
      tenantId,
      keys,
    );
  }
}
