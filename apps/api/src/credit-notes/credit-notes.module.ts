import { Module } from "@nestjs/common";
import { CreditNotesController } from "./credit-notes.controller";
import { CreditNotesService } from "./credit-notes.service";
import { PrismaModule } from "../prisma/prisma.module";
import { GatewaysModule } from "../gateways/gateways.module";
import { RegulatedModule } from "../regulated/regulated.module";
import { CommissionsModule } from "../sales-agents/commissions.module";

@Module({
  imports: [PrismaModule, GatewaysModule, RegulatedModule, CommissionsModule],
  controllers: [CreditNotesController],
  providers: [CreditNotesService],
  exports: [CreditNotesService],
})
export class CreditNotesModule {}
