import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { StockAlertService } from "./stock-alert.service";

/**
 * P5-03 stock alerts. Standalone module so BOTH InventoryModule (restock fire)
 * and BuyerModule (subscribe/unsubscribe endpoints) can import it without a
 * circular dependency. PrismaModule is @Global.
 */
@Module({
  imports: [NotificationsModule],
  providers: [StockAlertService],
  exports: [StockAlertService],
})
export class StockAlertsModule {}
