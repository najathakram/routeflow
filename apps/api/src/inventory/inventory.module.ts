import { Module } from "@nestjs/common";
import { StockAlertsModule } from "../stock-alerts/stock-alerts.module";
// EntitlementsModule depends only on the global PrismaService — it supplies
// PlanFlagGuard for the forecasting handlers' @RequirePlanFlag("flag.forecasting") gate.
import { EntitlementsModule } from "../billing/entitlements.module";
import { EmailModule } from "../email/email.module";
import { InventoryService } from "./inventory.service";
import { InventoryController } from "./inventory.controller";
import { LowStockDigestService } from "./low-stock-digest.service";

@Module({
  imports: [StockAlertsModule, EntitlementsModule, EmailModule],
  controllers: [InventoryController],
  providers: [InventoryService, LowStockDigestService],
  exports: [InventoryService],
})
export class InventoryModule {}
