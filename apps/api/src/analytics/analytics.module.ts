import { Module } from "@nestjs/common";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsService } from "./analytics.service";
import { PrismaModule } from "../prisma/prisma.module";
import { BillingModule } from "../billing/billing.module";
import { SystemConfigModule } from "../system-config/system-config.module";

@Module({
  imports: [PrismaModule, BillingModule, SystemConfigModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
