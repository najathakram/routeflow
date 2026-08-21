import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { GatewaysModule } from "../gateways/gateways.module";
import { StripeConnectModule } from "../stripe-connect/stripe-connect.module";
import { PaymentRequestsService } from "./payment-requests.service";
import { PaymentRequestsController } from "./payment-requests.controller";
import { ConnectWebhookController } from "./connect-webhook.controller";

/**
 * Buyer-initiated payments: request lifecycle, oldest-first allocation, the
 * connected-account webhook, and the tenant-side approve/reject.
 *
 * The buyer-facing controller (BuyerPaymentsController) is registered by
 * BuyerModule instead — it rides that module's auth guards and tenant
 * interceptor, which are not exported.
 */
@Module({
  imports: [BillingModule, InvoicesModule, GatewaysModule, StripeConnectModule],
  controllers: [PaymentRequestsController, ConnectWebhookController],
  providers: [PaymentRequestsService],
  exports: [PaymentRequestsService],
})
export class PaymentRequestsModule {}
