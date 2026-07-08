import { Module } from "@nestjs/common";
import { OrderTemplatesService } from "./order-templates.service";
import { OrderTemplatesController } from "./order-templates.controller";
import { OrdersModule } from "../orders/orders.module";
import { AuthorizationsModule } from "../authorizations/authorizations.module";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [OrdersModule, AuthorizationsModule, NotificationsModule],
  controllers: [OrderTemplatesController],
  providers: [OrderTemplatesService],
  exports: [OrderTemplatesService],
})
export class OrderTemplatesModule {}
