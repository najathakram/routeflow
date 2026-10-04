import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { FulfilmentCapability } from "@routeflow/types";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { AddonService } from "./addon.service";
import { FeatureConfigService } from "./feature-config.service";
import { FeatureOverrideService } from "./feature-override.service";
import { deriveFulfilmentCapability, isFleetHeld } from "./fulfilment-capability";

/**
 * Business profiles 1B: the fulfilment capability for a tenant OTHER than the caller's staff
 * session, i.e. a buyer's seller. The same derivation `GET /tenants/me/features` serves
 * (`deriveFulfilmentCapability` over the stored modes and the ONE fleet resolver).
 */
@Injectable()
export class FulfilmentCapabilityService {
  constructor(
    private readonly featureConfig: FeatureConfigService,
    private readonly addons: AddonService,
    private readonly featureOverrides: FeatureOverrideService,
  ) {}

  /** A failed mode read is `unset`: today's behaviour, never a 5xx. */
  private mode(tenantId: string, key: string): Promise<string> {
    return this.featureConfig.getEffectiveMode(tenantId, key).catch(() => "unset");
  }

  /**
   * The buyer portal's ORDER rule. Portal methods come from the mode alone, so this never reads
   * the fleet modules: a buyer order can't fail on a fleet read it doesn't need.
   */
  async portal(
    tenantId: string,
  ): Promise<Pick<FulfilmentCapability, "portalMethods" | "portalDefault">> {
    const mode = await this.mode(tenantId, "fulfilment_model");
    const { portalMethods, portalDefault } = deriveFulfilmentCapability({
      mode,
      counterSales: "unset",
      fleet: false,
    });
    return { portalMethods, portalDefault };
  }

  /** The full capability. A failed fleet read is the existing 503 (never a guessed fleet=false). */
  async forTenant(tenantId: string): Promise<FulfilmentCapability> {
    const [mode, counterSales, fleet] = await Promise.all([
      this.mode(tenantId, "fulfilment_model"),
      this.mode(tenantId, "counter_sales"),
      isFleetHeld(this.addons, this.featureOverrides, tenantId).catch(() => {
        throw new ServiceUnavailableException({
          code: API_ERROR_CODES.FEATURES_UNAVAILABLE,
          message: "Feature resolution is temporarily unavailable. Please retry.",
        });
      }),
    ]);
    return deriveFulfilmentCapability({ mode, counterSales, fleet });
  }
}
