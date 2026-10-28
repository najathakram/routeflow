import { ForbiddenException } from "@nestjs/common";
import { promotionsOn } from "@routeflow/types";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { FeatureConfigService } from "../billing/feature-config.service";

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
