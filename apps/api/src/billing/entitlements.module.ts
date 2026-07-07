import { Module } from "@nestjs/common";
import { PlanCatalogService } from "./plan-catalog.service";
import { EntitlementsService } from "./entitlements.service";
import { MeterService } from "./meter.service";
import { PlanFlagGuard } from "./plan-flag.guard";

/**
 * The lightweight Plans & Billing entitlements engine — plan catalog + entitlement
 * resolution + metering. Depends only on the (global) PrismaService, so it can be
 * imported by AuthModule (for JWT enrichment) and BillingModule alike without
 * pulling in Stripe, cron jobs, or controllers, and without a circular import.
 */
@Module({
  providers: [PlanCatalogService, EntitlementsService, MeterService, PlanFlagGuard],
  exports: [PlanCatalogService, EntitlementsService, MeterService, PlanFlagGuard],
})
export class EntitlementsModule {}
