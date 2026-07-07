import { Module } from "@nestjs/common";
import { ImportController } from "./import.controller";
import { ImportService } from "./import.service";
import { NumberingController } from "./numbering.controller";
import { NumberingService } from "./numbering.service";
import { PrismaModule } from "../prisma/prisma.module";
import { VendorBillsModule } from "../vendor-bills/vendor-bills.module";

@Module({
  imports: [PrismaModule, VendorBillsModule],
  controllers: [ImportController, NumberingController],
  providers: [ImportService, NumberingService],
  // NumberingService is exported so the deferred invoices/orders wiring (which
  // must call reserveNext at mint time) can consume it without duplicating it.
  exports: [NumberingService],
})
export class ImportModule {}
