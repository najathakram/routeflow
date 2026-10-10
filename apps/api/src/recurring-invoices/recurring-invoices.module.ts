import { Module } from "@nestjs/common";
import { RecurringInvoicesController } from "./recurring-invoices.controller";
import { RecurringInvoicesService } from "./recurring-invoices.service";
import { PrismaModule } from "../prisma/prisma.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { SellingRestrictionsModule } from "../selling-restrictions/selling-restrictions.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { EntitlementsModule } from "../billing/entitlements.module";

@Module({
  imports: [
    PrismaModule,
    InvoicesModule,
    EntitlementsModule,
    SellingRestrictionsModule,
    NotificationsModule,
  ],
  controllers: [RecurringInvoicesController],
  providers: [RecurringInvoicesService],
})
export class RecurringInvoicesModule {}
