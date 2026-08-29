import { Module } from "@nestjs/common";
import { RoutesService } from "./routes.service";
import { RoutesController, RouteRunsController } from "./routes.controller";
import { AuthModule } from "../auth/auth.module";
import { GatewaysModule } from "../gateways/gateways.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { MessagingModule } from "../messaging/messaging.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { BillingModule } from "../billing/billing.module";
import { StorageModule } from "../storage/storage.module";

@Module({
  imports: [
    AuthModule,
    GatewaysModule,
    NotificationsModule,
    MessagingModule,
    InvoicesModule,
    // AddonGuard + AddonService for the driver_payments gate on complete-with-payment
    BillingModule,
    // StorageService for durable POD artifacts (photos/signatures)
    StorageModule,
  ],
  controllers: [RoutesController, RouteRunsController],
  providers: [RoutesService],
  exports: [RoutesService],
})
export class RoutesModule {}
