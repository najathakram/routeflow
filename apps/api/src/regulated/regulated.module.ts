import { Module } from "@nestjs/common";
import { RegulatedController } from "./regulated.controller";
import { RegulatedService } from "./regulated.service";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import { RegulatedFilingService } from "./regulated-filing.service";
import { StorageModule } from "../storage/storage.module";
import { AuditModule } from "../audit/audit.module";

@Module({
  imports: [StorageModule, AuditModule],
  controllers: [RegulatedController],
  providers: [RegulatedService, RegulatedLedgerService, RegulatedFilingService],
  // Exported so InvoicesModule can write/reverse ledger rows at invoice create/void.
  exports: [RegulatedLedgerService],
})
export class RegulatedModule {}
