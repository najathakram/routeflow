import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { BuyerSellerCapability } from "@routeflow/types";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { AddonService } from "./addon.service";
import { FeatureConfigService } from "./feature-config.service";
import { FeatureOverrideService } from "./feature-override.service";
import { capabilityFromInputs, readFulfilmentInputs } from "./fulfilment-capability";

/**
 * Business profiles 1B: what a BUYER may know about its seller's fulfilment — the portal methods,
 * the portal default and whether the seller runs a fleet. The same derivation
 * `GET /tenants/me/features` serves (`deriveFulfilmentCapability` over the stored mode and the ONE
 * fleet resolver), trimmed to the buyer-safe fields.
 */
@Injectable()
export class FulfilmentCapabilityService {
  constructor(
    private readonly featureConfig: FeatureConfigService,
    private readonly addons: AddonService,
    private readonly featureOverrides: FeatureOverrideService,
  ) {}

  /**
   * A failed mode read is `unset` (today's screens). A failed fleet read is the existing 503,
   * never a guessed `fleet: false`.
   */
  async forBuyer(tenantId: string): Promise<Omit<BuyerSellerCapability, "acceptingOrders">> {
    // The ONE input read (shared with GET /tenants/me/features and the counter gate): a failed mode read
    // already answers "unset"; a failed fleet read answers null, which is this endpoint's 503.
    const inputs = await readFulfilmentInputs(
      {
        featureConfig: this.featureConfig,
        addonService: this.addons,
        featureOverrides: this.featureOverrides,
      },
      tenantId,
    );
    const fleet = inputs.fleet;
    if (fleet === null) {
      throw new ServiceUnavailableException({
        code: API_ERROR_CODES.FEATURES_UNAVAILABLE,
        message: "Feature resolution is temporarily unavailable. Please retry.",
      });
    }
    // counter_sales never changes the portal fields, so it is derived as "unset".
    const { portalMethods, portalDefault } = capabilityFromInputs({
      ...inputs,
      counterSales: "unset",
      fleet,
    });
    return { portalMethods, portalDefault, fleet };
  }
}
