import { Module } from "@nestjs/common";
import { TobaccoController } from "./tobacco.controller";
import { TobaccoService } from "./tobacco.service";
import { TobaccoReportService } from "./tobacco-report.service";
import { BillingModule } from "../billing/billing.module";
import { SystemConfigModule } from "../system-config/system-config.module";
import { AuditModule } from "../audit/audit.module";
import { StorageModule } from "../storage/storage.module";

@Module({
  imports: [BillingModule, SystemConfigModule, AuditModule, StorageModule],
  controllers: [TobaccoController],
  providers: [TobaccoService, TobaccoReportService],
  exports: [TobaccoService, TobaccoReportService],
})
export class TobaccoModule {}
