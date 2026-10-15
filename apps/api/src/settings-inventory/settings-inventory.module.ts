import { Module } from "@nestjs/common";
import { PolicyModule } from "../policy/policy.module";
import { SettingsInventoryController } from "./settings-inventory.controller";
import { SettingsInventoryService } from "./settings-inventory.service";

/** Settings → Inventory & ordering (WS9): a typed face over the `orders.buyerOversell` policy. */
@Module({
  imports: [PolicyModule],
  controllers: [SettingsInventoryController],
  providers: [SettingsInventoryService],
})
export class SettingsInventoryModule {}
