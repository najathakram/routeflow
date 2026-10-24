import { Module } from "@nestjs/common";
import { OrderTemplatesService } from "./order-templates.service";
import { OrderTemplatesController } from "./order-templates.controller";
import { OrdersModule } from "../orders/orders.module";
import { AuthorizationsModule } from "../authorizations/authorizations.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { SellingRestrictionsModule } from "../selling-restrictions/selling-restrictions.module";
import { RegulatedVisibilityService } from "../buyer/regulated-visibility.service";
import { SystemConfigModule } from "../system-config/system-config.module";

@Module({
  imports: [
    OrdersModule,
    AuthorizationsModule,
    NotificationsModule,
    SystemConfigModule,
    SellingRestrictionsModule,
  ],
  controllers: [OrderTemplatesController],
  // RegulatedVisibilityService is stateless (PrismaService only); provided here, not imported from BuyerModule,
  // which already imports this module (no cycle).
  providers: [OrderTemplatesService, RegulatedVisibilityService],
  exports: [OrderTemplatesService],
})
export class OrderTemplatesModule {}
