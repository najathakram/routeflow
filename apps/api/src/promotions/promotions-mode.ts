import { ForbiddenException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { FeatureConfigService } from "../billing/feature-config.service";

/**
 * SA-1032: true unless the business turned promotions off (no row = on). API mirror of
 * `promotionsOn` in `packages/types/api/features.ts`: the API never value-imports
 * `@routeflow/types` (see no-runtime-workspace-imports.spec.ts); the structure spec pins parity.
 */
export function promotionsOn(mode?: string | null): boolean {
  return mode !== "off";
}

/**
 * SA-1032: refuse a promotion write while the business has promotions turned off. A write with
 * no tenant context is refused too; every real write runs inside one.
 */
export async function assertPromotionsOn(
  featureConfig: FeatureConfigService,
  tenantId: string | null,
): Promise<void> {
  const mode = tenantId ? await featureConfig.getEffectiveMode(tenantId, "promotions") : "off";
  if (!promotionsOn(mode)) {
    throw new ForbiddenException({
      code: API_ERROR_CODES.PROMOTIONS_OFF,
      message: "Promotions are turned off for this business.",
    });
  }
}
