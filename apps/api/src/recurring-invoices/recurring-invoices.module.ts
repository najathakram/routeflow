import { Module } from "@nestjs/common";
import { RecurringInvoicesController } from "./recurring-invoices.controller";
import { RecurringInvoicesService } from "./recurring-invoices.service";
import { PrismaModule } from "../prisma/prisma.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { EntitlementsModule } from "../billing/entitlements.module";

@Module({
  imports: [PrismaModule, InvoicesModule, EntitlementsModule],
  controllers: [RecurringInvoicesController],
  providers: [RecurringInvoicesService],
})
export class RecurringInvoicesModule {}
