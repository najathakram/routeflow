import { Module } from "@nestjs/common";
import { CreditNotesController } from "./credit-notes.controller";
import { CreditNotesService } from "./credit-notes.service";
import { PrismaModule } from "../prisma/prisma.module";
import { GatewaysModule } from "../gateways/gateways.module";
import { RegulatedModule } from "../regulated/regulated.module";
import { CommissionsModule } from "../sales-agents/commissions.module";
import { NumberingModule } from "../import/numbering.module";

@Module({
  imports: [
    PrismaModule,
    GatewaysModule,
    RegulatedModule,
    CommissionsModule,
    // REG-B267/cause-ruling.md §2 D2: reserveNext("CREDIT_NOTE", …) mints credit
    // note numbers through the shared NumberingService.
    NumberingModule,
  ],
  controllers: [CreditNotesController],
  providers: [CreditNotesService],
  exports: [CreditNotesService],
})
export class CreditNotesModule {}
