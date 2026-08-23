import { Module } from "@nestjs/common";
import { ReturnsController } from "./returns.controller";
import { ReturnsService } from "./returns.service";
import { PrismaModule } from "../prisma/prisma.module";
import { GatewaysModule } from "../gateways/gateways.module";
import { RegulatedModule } from "../regulated/regulated.module";
import { CreditNotesModule } from "../credit-notes/credit-notes.module";
// EntitlementsModule depends only on the global PrismaService — it supplies
// PlanFlagGuard for the controller's @RequirePlanFlag("flag.returns") gate.
import { EntitlementsModule } from "../billing/entitlements.module";

@Module({
  imports: [PrismaModule, GatewaysModule, RegulatedModule, CreditNotesModule, EntitlementsModule],
  controllers: [ReturnsController],
  providers: [ReturnsService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
