import { Module } from "@nestjs/common";
import { InvoicesModule } from "../invoices/invoices.module";
import { GatewaysModule } from "../gateways/gateways.module";
import { StripeConnectModule } from "../stripe-connect/stripe-connect.module";
import { PaymentRequestsService } from "./payment-requests.service";
import { PaymentRequestsController } from "./payment-requests.controller";
import { ConnectWebhookController } from "./connect-webhook.controller";
import { PAYMENT_PROVIDER } from "./provider/payment-provider.interface";
import { StripePaymentProvider } from "./provider/stripe-payment-provider";

/**
 * Buyer-initiated payments: request lifecycle, oldest-first allocation, the
 * connected-account webhook, and the tenant-side approve/reject.
 *
 * The buyer-facing controller (BuyerPaymentsController) is registered by
 * BuyerModule instead — it rides that module's auth guards and tenant
 * interceptor, which are not exported.
 *
 * Deliberately does NOT import BillingModule: card payments run through the
 * PAYMENT_PROVIDER port (StripePaymentProvider), which builds its own Stripe
 * client from env rather than borrowing the SaaS billing module's
 * StripeService — Connect buyer payments and platform billing are signed
 * with different webhook secrets and must stay decoupled failure domains.
 */
@Module({
  imports: [InvoicesModule, GatewaysModule, StripeConnectModule],
  controllers: [PaymentRequestsController, ConnectWebhookController],
  providers: [
    PaymentRequestsService,
    { provide: PAYMENT_PROVIDER, useClass: StripePaymentProvider },
  ],
  exports: [PaymentRequestsService],
})
export class PaymentRequestsModule {}
