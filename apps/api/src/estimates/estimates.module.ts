import { Module } from "@nestjs/common";
import { EstimatesController } from "./estimates.controller";
import { EstimatesService } from "./estimates.service";
import { PrismaModule } from "../prisma/prisma.module";
import { EntitlementsModule } from "../billing/entitlements.module";
import { NumberingModule } from "../import/numbering.module";

@Module({
  imports: [
    PrismaModule,
    EntitlementsModule,
    // B100/F16b: reserveNext("INVOICE", …) mints invoice numbers through the
    // shared NumberingService (used by convertToInvoice).
    NumberingModule,
  ],
  controllers: [EstimatesController],
  providers: [EstimatesService],
  exports: [EstimatesService],
})
export class EstimatesModule {}
