import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { VendorBillsController } from "./vendor-bills.controller";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaModule } from "../prisma/prisma.module";

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [VendorBillsController],
  providers: [VendorBillsService],
  exports: [VendorBillsService],
})
export class VendorBillsModule {}
