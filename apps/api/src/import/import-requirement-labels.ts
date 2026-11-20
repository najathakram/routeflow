import { Injectable } from "@nestjs/common";
import type { ImportColumnRequirement } from "@routeflow/types";
import { EntitlementsService } from "../billing/entitlements.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import {
  FLAG_TO_ADDON_SKU,
  LEGACY_ADDON_KEY_TO_SKU,
  type AddonSkuCode,
} from "../billing/plan-catalog.constants";
import { PrismaService } from "../prisma/prisma.service";

/**
 * SA-1193 A1-2 (B1377): the catalog SKU behind each requirement, read through the billing module's own bridges from the
 * key each import gate checks (`flag.msrp`, the legacy `tobacco_dealer` add-on, `flag.forecasting`). Never a typed SKU.
 */
export const IMPORT_REQUIREMENT_SKU: Record<ImportColumnRequirement, AddonSkuCode> = {
  MSRP: FLAG_TO_ADDON_SKU["flag.msrp"],
  TOBACCO_DEALER: LEGACY_ADDON_KEY_TO_SKU.tobacco_dealer,
  FORECASTING: FLAG_TO_ADDON_SKU["flag.forecasting"],
};

export type ImportRequirementLabels = Record<ImportColumnRequirement, string>;

/**
 * The name the billing page shows for each requirement: the `name` of its SKU in the catalog version the tenant is on,
 * the same field `GET /billing/subscription` returns for an add-on. A SKU the tenant's version lacks falls back to the
 * published version, then to the SKU code (what that route falls back to).
 */
export function requirementLabels(
  addonSkus: readonly { sku: string; name: string }[],
  published: readonly { sku: string; name: string }[] = [],
): ImportRequirementLabels {
  const name = (sku: string) =>
    addonSkus.find((s) => s.sku === sku)?.name ?? published.find((s) => s.sku === sku)?.name ?? sku;
  return {
    MSRP: name(IMPORT_REQUIREMENT_SKU.MSRP),
    TOBACCO_DEALER: name(IMPORT_REQUIREMENT_SKU.TOBACCO_DEALER),
    FORECASTING: name(IMPORT_REQUIREMENT_SKU.FORECASTING),
  };
}

/** Resolves the labels once per import, from the tenant's catalog version (the lookup the billing route makes). */
@Injectable()
export class ImportRequirementLabelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly catalog: PlanCatalogService,
  ) {}

  async labels(): Promise<ImportRequirementLabels> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new Error("ImportRequirementLabelService: no tenant in context");
    const ent = await this.entitlements.resolve(tenantId);
    const version = await this.catalog.getVersionForTenant(ent.planVersionId);
    const labels = requirementLabels(version.addonSkus);
    const missing = Object.values(IMPORT_REQUIREMENT_SKU).some(
      (sku) => !version.addonSkus.some((s) => s.sku === sku),
    );
    if (!missing) return labels;
    const published = await this.catalog.getPublishedCatalog();
    return requirementLabels(version.addonSkus, published.addonSkus);
  }
}
