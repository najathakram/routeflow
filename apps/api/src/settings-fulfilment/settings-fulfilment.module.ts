import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { EmailModule } from "../email/email.module";
import { SettingsFulfilmentController } from "./settings-fulfilment.controller";
import { SettingsFulfilmentService } from "./settings-fulfilment.service";
import { FulfilmentEditGuard } from "./fulfilment-edit";
import { FirstRunService } from "./first-run.service";

/**
 * Settings → Fulfillment (dark behind FULFILMENT_SELF_SERVE): a typed, audited face over the
 * `fulfilment_model` and `counter_sales` tenant config rows. `FeatureConfigService` / `FeatureConfigStore`
 * come from the global FeatureConfigModule; the add-on and override services from BillingModule.
 */
@Module({
  imports: [BillingModule, EmailModule],
  controllers: [SettingsFulfilmentController],
  providers: [SettingsFulfilmentService, FirstRunService, FulfilmentEditGuard],
})
export class SettingsFulfilmentModule {}
