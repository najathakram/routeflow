import { ForbiddenException, Logger } from "@nestjs/common";
import type { EntitlementsService } from "./entitlements.service";
import type { PlanCatalogService } from "./plan-catalog.service";
import type { FeatureOverrideService } from "./feature-override.service";
import { buildPlanGateBody } from "./plan-gate";
import { isDarkFlag } from "./plan-flag-policy";
import { API_ERROR_CODES } from "../common/api-error-codes";

/** No self-service fix exists for an admin override — an upgrade CTA would be misleading. */
const NO_UPGRADE = {
  planKey: null,
  planMonthlyPrice: null,
  addonSku: null,
  addonMonthlyPrice: null,
};

export interface PlanFlagDenialDeps {
  featureOverrides: Pick<FeatureOverrideService, "get">;
  entitlements: Pick<EntitlementsService, "resolve">;
  catalog: Pick<PlanCatalogService, "upgradeTargetForFlag">;
  logger: Pick<Logger, "warn" | "error">;
}

/**
 * The ONE place a plan-flag denial's 403 is shaped, AFTER the caller's
 * `EntitlementAuthority.can()` already said no (this never changes the decision). Shared by
 * PlanFlagGuard and every service-side gate that must answer exactly as the guard would
 * (ProductsService.assertReorderAllowed, SA-322/SA-329 N1), so the two can never drift:
 *   - an admin override DENY → PLAN_GATE with NO upgrade target (no self-service fix exists)
 *   - entitlements unresolvable → PLAN_GATE_UNAVAILABLE (retryable, never an upgrade CTA)
 *   - otherwise → PLAN_GATE with the catalog's upgrade target for the flag
 * Returns the exception; the caller throws it.
 */
export async function buildPlanFlagDenial(
  deps: PlanFlagDenialDeps,
  tenantId: string,
  flagKey: string,
): Promise<ForbiddenException> {
  const override = await deps.featureOverrides.get(tenantId, flagKey);
  if (override === "DENY") {
    if (isDarkFlag(flagKey)) {
      deps.logger.warn(
        `plan flag gate override-denied on a dark flag: flag=${flagKey} tenant=${tenantId}`,
      );
    }
    return new ForbiddenException(buildPlanGateBody(flagKey, NO_UPGRADE));
  }

  try {
    await deps.entitlements.resolve(tenantId);
  } catch (err) {
    deps.logger.error(`Entitlement resolution failed for tenant ${tenantId}`, err as Error);
    return new ForbiddenException({
      code: API_ERROR_CODES.PLAN_GATE_UNAVAILABLE,
      message: "Entitlements are temporarily unavailable. Please retry.",
    });
  }

  const upgrade = await deps.catalog.upgradeTargetForFlag(flagKey).catch(() => ({
    planKey: null,
    planMonthlyPrice: null,
    addonSku: null,
    addonMonthlyPrice: null,
  }));
  return new ForbiddenException(buildPlanGateBody(flagKey, upgrade));
}
