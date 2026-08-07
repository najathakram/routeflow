import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { VendorBillsController } from "./vendor-bills.controller";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaModule } from "../prisma/prisma.module";
import { SystemConfigModule } from "../system-config/system-config.module";
import { DuplicateMatchModule } from "../import/duplicate-match.module";

@Module({
  imports: [PrismaModule, ConfigModule, SystemConfigModule, DuplicateMatchModule],
  controllers: [VendorBillsController],
  providers: [VendorBillsService],
  exports: [VendorBillsService],
})
export class VendorBillsModule {}
