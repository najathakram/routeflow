import { Module } from "@nestjs/common";
import { EstimatesController } from "./estimates.controller";
import { EstimatesService } from "./estimates.service";
import { PrismaModule } from "../prisma/prisma.module";
import { EntitlementsModule } from "../billing/entitlements.module";

@Module({
  imports: [PrismaModule, EntitlementsModule],
  controllers: [EstimatesController],
  providers: [EstimatesService],
  exports: [EstimatesService],
})
export class EstimatesModule {}
