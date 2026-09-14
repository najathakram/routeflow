import { Module } from "@nestjs/common";
import { StripeService } from "./stripe.service";
import { BillingService } from "./billing.service";
import { PlatformPricingService } from "./platform-pricing.service";
import { AddonService } from "./addon.service";
import { AddonGuard } from "./addon.guard";
import { BillingController } from "./billing.controller";
import { BillingWebhookController } from "./billing-webhook.controller";
import { PlanCatalogController } from "./plan-catalog.controller";
import { PlanAdminController } from "./plan-admin.controller";
import { SettingsBillingController } from "./settings-billing.controller";
import { ProrationService } from "./proration.service";
import { SubscriptionService } from "./subscription.service";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { BillingEventService } from "./billing-event.service";
import { BillingCronService } from "./billing-cron.service";
import { MrrService } from "./mrr.service";
import { EmailModule } from "../email/email.module";
import { EntitlementsModule } from "./entitlements.module";

@Module({
  imports: [EmailModule, EntitlementsModule],
  controllers: [
    BillingController,
    BillingWebhookController,
    PlanCatalogController,
    PlanAdminController,
    SettingsBillingController,
  ],
  providers: [
    StripeService,
    BillingService,
    PlatformPricingService,
    AddonService,
    AddonGuard,
    ProrationService,
    SubscriptionService,
    SubscriptionMutationService,
    BillingEventService,
    BillingCronService,
    MrrService,
  ],
  exports: [
    StripeService,
    BillingService,
    PlatformPricingService,
    AddonService,
    AddonGuard,
    // Platform-admin plan changes move the snapshot MRR run-rate, so they must emit the
    // matching signed BillingEvent delta (see PlatformAdminService.updatePlan).
    BillingEventService,
    // ADMIN-UPDATEPLAN-1: PlatformAdminService.updatePlan() shares the same prorated-diff
    // math an admin upgrade uses as the tenant-facing upgrade() — exported so
    // PlatformAdminModule (which already imports BillingModule) can inject it.
    ProrationService,
    EntitlementsModule,
  ],
})
export class BillingModule {}
