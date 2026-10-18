import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { CustomerPriceLayerController } from "./customer-price-layer.controller";
import { CustomerUnitPricesController } from "./customer-unit-prices.controller";
import { CustomerUnitPricesService } from "./customer-unit-prices.service";

/** Units v2 Customer view (K6). Registered in app.module with one line. */
@Module({
  imports: [AuthModule, BillingModule],
  controllers: [CustomerUnitPricesController, CustomerPriceLayerController],
  providers: [CustomerUnitPricesService],
})
export class CustomerUnitPricesModule {}
