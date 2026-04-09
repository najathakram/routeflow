import { Module } from "@nestjs/common";
import { StripeService } from "./stripe.service";
import { BillingService } from "./billing.service";
import { AddonService } from "./addon.service";
import { BillingController } from "./billing.controller";
import { BillingWebhookController } from "./billing-webhook.controller";
import { EmailModule } from "../email/email.module";

@Module({
  imports: [EmailModule],
  controllers: [BillingController, BillingWebhookController],
  providers: [StripeService, BillingService, AddonService],
  exports: [StripeService, BillingService, AddonService],
})
export class BillingModule {}
