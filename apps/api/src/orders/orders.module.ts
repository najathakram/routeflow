import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { OrdersService } from "./orders.service";
import { ChangeRequestsService } from "./change-requests.service";
import { OrdersController } from "./orders.controller";
import { AuthModule } from "../auth/auth.module";
import { GatewaysModule } from "../gateways/gateways.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { SystemConfigModule } from "../system-config/system-config.module";
import { InventoryModule } from "../inventory/inventory.module";
import { AuthorizationsModule } from "../authorizations/authorizations.module";
import { PromotionsModule } from "../promotions/promotions.module";
import { MessagingModule } from "../messaging/messaging.module";
import { CreditNotesModule } from "../credit-notes/credit-notes.module";
import { CommissionsModule } from "../sales-agents/commissions.module";

@Module({
  imports: [
    AuthModule,
    BullModule.registerQueue({ name: "invoices" }),
    GatewaysModule,
    NotificationsModule,
    InvoicesModule,
    SystemConfigModule,
    InventoryModule,
    AuthorizationsModule,
    PromotionsModule,
    MessagingModule,
    CreditNotesModule,
    CommissionsModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService, ChangeRequestsService],
  exports: [OrdersService, ChangeRequestsService],
})
export class OrdersModule {}
