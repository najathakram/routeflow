import { Module } from "@nestjs/common";
import { DriversService } from "./drivers.service";
import { DriversController } from "./drivers.controller";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";

@Module({
  // BillingModule: AddonGuard + AddonService for the either-feature addon gate
  imports: [AuthModule, BillingModule],
  controllers: [DriversController],
  providers: [DriversService],
  exports: [DriversService],
})
export class DriversModule {}
