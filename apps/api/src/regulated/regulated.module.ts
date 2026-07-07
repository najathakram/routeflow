import { Module } from "@nestjs/common";
import { RegulatedController } from "./regulated.controller";
import { RegulatedService } from "./regulated.service";
import { RegulatedLedgerService } from "./regulated-ledger.service";

@Module({
  controllers: [RegulatedController],
  providers: [RegulatedService, RegulatedLedgerService],
  // Exported so InvoicesModule can write/reverse ledger rows at invoice create/void.
  exports: [RegulatedLedgerService],
})
export class RegulatedModule {}
