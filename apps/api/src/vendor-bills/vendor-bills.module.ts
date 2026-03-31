import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { VendorBillsController } from "./vendor-bills.controller";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaModule } from "../prisma/prisma.module";
import { SystemConfigModule } from "../system-config/system-config.module";

@Module({
  imports: [PrismaModule, ConfigModule, SystemConfigModule],
  controllers: [VendorBillsController],
  providers: [VendorBillsService],
  exports: [VendorBillsService],
})
export class VendorBillsModule {}
