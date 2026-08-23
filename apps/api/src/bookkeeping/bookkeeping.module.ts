import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { ConfigModule } from "@nestjs/config";
import { BookkeepingService } from "./bookkeeping.service";
import { BookkeepingController } from "./bookkeeping.controller";
import { InvoiceService } from "./invoice.service";
import { InvoiceProcessor } from "./invoice.processor";
import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module";
import { VendorBillsModule } from "../vendor-bills/vendor-bills.module";
import { SystemConfigModule } from "../system-config/system-config.module";
import { CommissionsModule } from "../sales-agents/commissions.module";

@Module({
  imports: [
    AuthModule,
    ConfigModule,
    StorageModule,
    VendorBillsModule,
    SystemConfigModule,
    CommissionsModule,
    BullModule.registerQueue({ name: "invoices" }),
  ],
  controllers: [BookkeepingController],
  providers: [BookkeepingService, InvoiceService, InvoiceProcessor],
  exports: [InvoiceService],
})
export class BookkeepingModule {}
