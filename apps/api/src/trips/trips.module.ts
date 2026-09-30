import { Module } from "@nestjs/common";
import { TripsService } from "./trips.service";
import { TripsController } from "./trips.controller";
import { AuthModule } from "../auth/auth.module";
import { SystemConfigModule } from "../system-config/system-config.module";
import { BillingModule } from "../billing/billing.module";

@Module({
  // BillingModule: AddonGuard + AddonService for the order_delivery/developer_mode gate
  imports: [AuthModule, SystemConfigModule, BillingModule],
  controllers: [TripsController],
  providers: [TripsService],
  exports: [TripsService],
})
export class TripsModule {}
