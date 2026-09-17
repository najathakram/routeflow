import { Module } from "@nestjs/common";
import { PlanCatalogService } from "./plan-catalog.service";
import { EntitlementsService } from "./entitlements.service";
import { MeterService } from "./meter.service";
import { PlanFlagGuard } from "./plan-flag.guard";
import { FeatureOverrideService } from "./feature-override.service";
import { FeatureResolverService } from "./feature-resolver.service";
import { EntitlementAuthority } from "./entitlement-authority.service";
import { EntitlementsModeService } from "./entitlements-mode.service";
import { FeatureDiffService } from "./feature-diff.service";
import { FeaturePreviewService } from "./feature-preview.service";

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
 *
 * Feature grants v2 brief A: FeatureResolverService/EntitlementAuthority/
 * EntitlementsModeService/FeatureDiffService/FeaturePreviewService live here too, for the
 * identical reason — PlanFlagGuard now depends on EntitlementAuthority, and PlanFlagGuard
 * can only live in a module every `@RequirePlanFlag`-gated domain module already imports
 * directly (not BillingModule; ~16 of them import EntitlementsModule alone). None of these
 * new services touch AddonService (BillingModule-only) — they query TenantAddon via the
 * global PrismaService directly instead, the same shortcut EntitlementsService.compute()
 * already takes, specifically to avoid a BillingModule -> EntitlementsModule ->
 * BillingModule cycle.
 */
@Module({
  providers: [
    PlanCatalogService,
    EntitlementsService,
    MeterService,
    PlanFlagGuard,
    FeatureOverrideService,
    FeatureResolverService,
    EntitlementAuthority,
    EntitlementsModeService,
    FeatureDiffService,
    FeaturePreviewService,
  ],
  exports: [
    PlanCatalogService,
    EntitlementsService,
    MeterService,
    PlanFlagGuard,
    FeatureOverrideService,
    FeatureResolverService,
    EntitlementAuthority,
    EntitlementsModeService,
    FeatureDiffService,
    FeaturePreviewService,
  ],
})
export class EntitlementsModule {}
