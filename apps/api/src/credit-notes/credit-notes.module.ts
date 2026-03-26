import { Module } from "@nestjs/common";
import { CreditNotesController } from "./credit-notes.controller";
import { CreditNotesService } from "./credit-notes.service";
import { PrismaModule } from "../prisma/prisma.module";
import { GatewaysModule } from "../gateways/gateways.module";

@Module({
  imports: [PrismaModule, GatewaysModule],
  controllers: [CreditNotesController],
  providers: [CreditNotesService],
  exports: [CreditNotesService],
})
export class CreditNotesModule {}
