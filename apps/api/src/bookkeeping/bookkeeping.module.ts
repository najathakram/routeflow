import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { BookkeepingService } from "./bookkeeping.service";
import { BookkeepingController } from "./bookkeeping.controller";
import { InvoiceService } from "./invoice.service";
import { InvoiceProcessor } from "./invoice.processor";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: "invoices" })],
  controllers: [BookkeepingController],
  providers: [BookkeepingService, InvoiceService, InvoiceProcessor],
  exports: [InvoiceService],
})
export class BookkeepingModule {}
