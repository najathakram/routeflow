import { Controller, HttpCode, HttpStatus, Logger, Post, Req, Res } from "@nestjs/common";
import { ApiExcludeEndpoint, ApiTags } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { StripeService } from "../billing/stripe.service";
import { StripeConnectService } from "../stripe-connect/stripe-connect.service";
import { PaymentRequestsService } from "./payment-requests.service";
import { AppConfig } from "../config/configuration";

/**
 * Webhooks for events ON CONNECTED ACCOUNTS (buyer card payments), separate
 * from /billing/webhook (platform SaaS billing) because Stripe signs the two
 * endpoints with different secrets.
 *
 * Unauthenticated by design — the signature IS the authentication, verified
 * against STRIPE_CONNECT_WEBHOOK_SECRET with the raw body (rawBody: true is
 * already set in main.ts for the billing webhook).
 *
 * Contract with Stripe: 2xx acknowledges, anything else redelivers. A
 * settlement failure therefore returns 500 ON PURPOSE — the request row is
 * reopened and the retry settles it. An event we don't care about is 200.
 */
@ApiTags("billing-webhooks")
@Controller("billing/webhook/connect")
export class ConnectWebhookController {
  private readonly logger = new Logger(ConnectWebhookController.name);

  constructor(
    private readonly stripe: StripeService,
    private readonly connect: StripeConnectService,
    private readonly payments: PaymentRequestsService,
    private readonly config: ConfigService<AppConfig>,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async handle(@Req() req: Request & { rawBody?: Buffer }, @Res() res: Response): Promise<void> {
    const signature = req.headers["stripe-signature"] as string | undefined;
    const secret = this.config.get<AppConfig["stripe"]>("stripe")?.connectWebhookSecret;
    if (!signature) {
      // No signature = not a Stripe delivery. Drop it.
      res.status(HttpStatus.OK).json({ received: true });
      return;
    }
    if (!secret || !this.stripe.isConfigured || !req.rawBody) {
      // A REAL Stripe delivery while the secret/key is not yet configured. A
      // 200 here would permanently acknowledge the event — a payment made in
      // that window would be charged but never recorded. 503 instead: Stripe
      // redelivers with backoff for days, so events survive until the env vars
      // land. (Review finding — the earlier 200-ACK silently lost money.)
      this.logger.error(
        `Connect webhook arrived but Stripe is not configured (secret=${!!secret} key=${this.stripe.isConfigured} rawBody=${!!req.rawBody}) — returning 503 so Stripe redelivers`,
      );
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({ error: "Webhook not configured yet" });
      return;
    }

    let event: any;
    try {
      event = this.stripe.client.webhooks.constructEvent(req.rawBody, signature, secret);
    } catch (err: any) {
      this.logger.error(`Connect webhook signature verification failed: ${err?.message}`);
      res.status(HttpStatus.BAD_REQUEST).json({ error: "Invalid signature" });
      return;
    }

    try {
      switch (event.type) {
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded":
          await this.payments.settleCardBySession(event.data.object);
          break;
        case "checkout.session.async_payment_failed":
          await this.payments.failCardBySession(event.data.object, "Payment method failed");
          break;
        case "account.updated":
          await this.connect.syncAccountStatus(event.data.object);
          break;
        default:
          break; // acknowledged, ignored
      }
      res.status(HttpStatus.OK).json({ received: true });
    } catch (err: any) {
      this.logger.error(`Connect webhook ${event.type} failed: ${err?.message}`);
      // Non-2xx → Stripe redelivers; settlement claims make the retry safe.
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: "Processing failed" });
    }
  }
}
