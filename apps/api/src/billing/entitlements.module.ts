import { Module } from "@nestjs/common";
import { PlanCatalogService } from "./plan-catalog.service";
import { EntitlementsService } from "./entitlements.service";
import { MeterService } from "./meter.service";
import { PlanFlagGuard } from "./plan-flag.guard";
import { FeatureOverrideService } from "./feature-override.service";

/**
 * The lightweight Plans & Billing entitlements engine — plan catalog + entitlement
 * resolution + metering. Depends only on the (global) PrismaService, so it can be
 * imported by AuthModule (for JWT enrichment) and BillingModule alike without
 * pulling in Stripe, cron jobs, or controllers, and without a circular import.
 *
 * FeatureOverrideService lives here (not BillingModule) for the same reason: both
 * EntitlementsService.hasFlag and PlanFlagGuard consult it directly and are themselves
 * providers of this module. BillingModule already exports EntitlementsModule, so
 * AddonGuard (BillingModule) and platform-admin/tenants controllers (which import
 * BillingModule) reach it with zero new cross-module edges.
 */
@Module({
  providers: [
    PlanCatalogService,
    EntitlementsService,
    MeterService,
    PlanFlagGuard,
    FeatureOverrideService,
  ],
  exports: [
    PlanCatalogService,
    EntitlementsService,
    MeterService,
    PlanFlagGuard,
    FeatureOverrideService,
  ],
})
export class EntitlementsModule {}
