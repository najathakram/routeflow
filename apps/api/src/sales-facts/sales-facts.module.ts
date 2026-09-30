import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { EntitlementsModule } from "../billing/entitlements.module";
import { SalesFactsService } from "./sales-facts.service";
import { ProductInsightsService } from "./product-insights.service";
import { ProductInsightsController } from "./product-insights.controller";

/**
 * #2118 (plan A1) — the sales-facts layer. `EntitlementsModule` provides `PlanFlagGuard` for
 * the controller's `@RequirePlanFlag` (see `plan-flag-guard-module-import.spec.ts`).
 * `AnalyticsModule` imports this module for the `getProductSales`/`getProductDemand`
 * delegates.
 */
@Module({
  imports: [PrismaModule, EntitlementsModule],
  controllers: [ProductInsightsController],
  providers: [SalesFactsService, ProductInsightsService],
  exports: [SalesFactsService, ProductInsightsService],
})
export class SalesFactsModule {}
