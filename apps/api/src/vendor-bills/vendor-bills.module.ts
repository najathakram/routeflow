import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { VendorBillsController } from "./vendor-bills.controller";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaModule } from "../prisma/prisma.module";
import { SystemConfigModule } from "../system-config/system-config.module";
import { DuplicateMatchModule } from "../import/duplicate-match.module";
import { StorageModule } from "../storage/storage.module";
import { InventoryModule } from "../inventory/inventory.module";

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    SystemConfigModule,
    DuplicateMatchModule,
    StorageModule,
    InventoryModule,
  ],
  controllers: [VendorBillsController],
  providers: [VendorBillsService],
  exports: [VendorBillsService],
})
export class VendorBillsModule {}
