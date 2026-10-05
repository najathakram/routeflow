import { Injectable } from "@nestjs/common";
import { AddonService } from "../../billing/addon.service";
import { FeatureConfigService } from "../../billing/feature-config.service";
import { FeatureOverrideService } from "../../billing/feature-override.service";
import { readFulfilmentCapability } from "../../billing/fulfilment-capability";
import type { FulfilmentCapability } from "./capability-shape";

/** DI token for the reader the counter-sale gate asks "what can this tenant do?". */
export const FULFILMENT_CAPABILITY_READER = Symbol("FULFILMENT_CAPABILITY_READER");

export interface FulfilmentCapabilityReader {
  get(tenantId: string | null): Promise<FulfilmentCapability>;
}

/**
 * The real reader: the tenant's fulfilment_model / counter_sales modes and fleet, derived by the shared
 * `readFulfilmentCapability` (the same calls GET /tenants/me/features makes). Any read failure or a null
 * tenant answers counter "off".
 */
@Injectable()
export class DefaultFulfilmentCapabilityReader implements FulfilmentCapabilityReader {
  constructor(
    private readonly featureConfig: FeatureConfigService,
    private readonly addonService: AddonService,
    private readonly featureOverrides: FeatureOverrideService,
  ) {}

  get(tenantId: string | null): Promise<FulfilmentCapability> {
    return readFulfilmentCapability(
      {
        featureConfig: this.featureConfig,
        addonService: this.addonService,
        featureOverrides: this.featureOverrides,
      },
      tenantId,
    );
  }
}
