import { Module } from "@nestjs/common";
import { StockAlertsModule } from "../stock-alerts/stock-alerts.module";
import { InventoryService } from "./inventory.service";
import { InventoryController } from "./inventory.controller";

@Module({
  imports: [StockAlertsModule],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
