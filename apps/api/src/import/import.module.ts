import { Module } from "@nestjs/common";
import { ImportController } from "./import.controller";
import { ImportService } from "./import.service";
import { PrismaModule } from "../prisma/prisma.module";
import { VendorBillsModule } from "../vendor-bills/vendor-bills.module";

@Module({
  imports: [PrismaModule, VendorBillsModule],
  controllers: [ImportController],
  providers: [ImportService],
})
export class ImportModule {}
