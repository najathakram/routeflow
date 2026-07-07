import { Module } from "@nestjs/common";
import { StripeService } from "./stripe.service";
import { BillingService } from "./billing.service";
import { AddonService } from "./addon.service";
import { AddonGuard } from "./addon.guard";
import { BillingController } from "./billing.controller";
import { BillingWebhookController } from "./billing-webhook.controller";
import { PlanCatalogController } from "./plan-catalog.controller";
import { PlanAdminController } from "./plan-admin.controller";
import { EmailModule } from "../email/email.module";
import { EntitlementsModule } from "./entitlements.module";

@Module({
  imports: [EmailModule, EntitlementsModule],
  controllers: [
    BillingController,
    BillingWebhookController,
    PlanCatalogController,
    PlanAdminController,
  ],
  providers: [StripeService, BillingService, AddonService, AddonGuard],
  exports: [StripeService, BillingService, AddonService, AddonGuard, EntitlementsModule],
})
export class BillingModule {}
