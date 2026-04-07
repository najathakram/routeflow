import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { OrdersService } from "./orders.service";
import { OrdersController, RouteRunDeliveryController } from "./orders.controller";
import { AuthModule } from "../auth/auth.module";
import { GatewaysModule } from "../gateways/gateways.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { SystemConfigModule } from "../system-config/system-config.module";

@Module({
  imports: [
    AuthModule,
    BullModule.registerQueue({ name: "invoices" }),
    GatewaysModule,
    NotificationsModule,
    InvoicesModule,
    SystemConfigModule,
  ],
  controllers: [OrdersController, RouteRunDeliveryController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
