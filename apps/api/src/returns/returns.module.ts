import { Module } from "@nestjs/common";
import { ReturnsController } from "./returns.controller";
import { ReturnsService } from "./returns.service";
import { PrismaModule } from "../prisma/prisma.module";
import { GatewaysModule } from "../gateways/gateways.module";
import { RegulatedModule } from "../regulated/regulated.module";
import { CreditNotesModule } from "../credit-notes/credit-notes.module";

@Module({
  imports: [PrismaModule, GatewaysModule, RegulatedModule, CreditNotesModule],
  controllers: [ReturnsController],
  providers: [ReturnsService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
