import { Module } from "@nestjs/common";
import {
  RouteOptimizationController,
  RouteTemplateOptimizationController,
} from "./route-optimization.controller";
import { RouteOptimizationService } from "./route-optimization.service";
import { RouteAnalysisService } from "./route-analysis.service";
import { AuthModule } from "../auth/auth.module";
import { SystemConfigModule } from "../system-config/system-config.module";
import { PlatformAdminModule } from "../platform-admin/platform-admin.module";
import { BillingModule } from "../billing/billing.module";
import { GatewaysModule } from "../gateways/gateways.module";

@Module({
  // BillingModule: AddonGuard + AddonService for the either-feature addon gate
  // GatewaysModule: route.progress after a run's stops are re-sequenced (#2095)
  imports: [AuthModule, SystemConfigModule, PlatformAdminModule, BillingModule, GatewaysModule],
  controllers: [RouteOptimizationController, RouteTemplateOptimizationController],
  providers: [RouteOptimizationService, RouteAnalysisService],
  exports: [RouteOptimizationService, RouteAnalysisService],
})
export class RouteOptimizationModule {}
