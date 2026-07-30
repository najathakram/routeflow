import { Module } from "@nestjs/common";
import { RegulatedController } from "./regulated.controller";
import { RegulatedService } from "./regulated.service";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import { RegulatedFilingService } from "./regulated-filing.service";
import { RegulatedReportService } from "./regulated-report.service";
import { RegulatedFilingCronService } from "./regulated-filing-cron.service";
import { StorageModule } from "../storage/storage.module";
import { AuditModule } from "../audit/audit.module";

@Module({
  imports: [StorageModule, AuditModule],
  controllers: [RegulatedController],
  providers: [
    RegulatedService,
    RegulatedLedgerService,
    RegulatedFilingService,
    // WP11: stateless range-preview + CSV report endpoints; also reused by
    // RegulatedFilingService.prepareFiling for TX_COMPTROLLER filings.
    RegulatedReportService,
    // RF-5: daily cron that auto-prepares closed-period filings. TenantContextService
    // is global (TenantModule) and PrismaService is global — no extra imports needed.
    RegulatedFilingCronService,
  ],
  // Exported so InvoicesModule can write/reverse ledger rows at invoice create/void.
  exports: [RegulatedLedgerService],
})
export class RegulatedModule {}
