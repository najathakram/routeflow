import { Module } from "@nestjs/common";
import { StripeService } from "./stripe.service";
import { BillingService } from "./billing.service";
import { AddonService } from "./addon.service";
import { AddonGuard } from "./addon.guard";
import { BillingController } from "./billing.controller";
import { BillingWebhookController } from "./billing-webhook.controller";
import { EmailModule } from "../email/email.module";

@Module({
  imports: [EmailModule],
  controllers: [BillingController, BillingWebhookController],
  providers: [StripeService, BillingService, AddonService, AddonGuard],
  exports: [StripeService, BillingService, AddonService, AddonGuard],
})
export class BillingModule {}
