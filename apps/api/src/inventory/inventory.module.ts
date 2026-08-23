import { Module } from "@nestjs/common";
import { StockAlertsModule } from "../stock-alerts/stock-alerts.module";
// EntitlementsModule depends only on the global PrismaService — it supplies
// PlanFlagGuard for the forecasting handlers' @RequirePlanFlag("flag.forecasting") gate.
import { EntitlementsModule } from "../billing/entitlements.module";
import { InventoryService } from "./inventory.service";
import { InventoryController } from "./inventory.controller";

@Module({
  imports: [StockAlertsModule, EntitlementsModule],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
