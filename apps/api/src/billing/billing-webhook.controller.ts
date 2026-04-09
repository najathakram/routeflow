import { Controller, Post, Req, Res, HttpCode, HttpStatus, Logger } from "@nestjs/common";
import { ApiTags, ApiExcludeEndpoint } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { StripeService } from "./stripe.service";
import { BillingService } from "./billing.service";

/**
 * Handles Stripe webhook events.
 *
 * This controller is NOT protected by JwtAuthGuard or any tenant guard.
 * Authentication is done via Stripe webhook signature verification.
 *
 * IMPORTANT: The NestFactory.create() call in main.ts must set `rawBody: true`
 * so that `req.rawBody` is available for Stripe signature verification.
 */
@ApiTags("billing-webhooks")
@Controller("billing/webhook")
export class BillingWebhookController {
  private readonly logger = new Logger(BillingWebhookController.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly billingService: BillingService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async handleWebhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
  ): Promise<void> {
    const signature = req.headers["stripe-signature"] as string | undefined;
    if (!signature) {
      this.logger.warn("Webhook request missing stripe-signature header");
      res.status(HttpStatus.BAD_REQUEST).json({ error: "Missing signature" });
      return;
    }

    if (!this.stripeService.isConfigured) {
      this.logger.warn("Stripe not configured — ignoring webhook");
      res.status(HttpStatus.OK).json({ received: true });
      return;
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      this.logger.error("Raw body not available — ensure NestFactory.create() has rawBody: true");
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: "Raw body not available" });
      return;
    }

    try {
      const event = this.stripeService.constructWebhookEvent(rawBody, signature);

      await this.billingService.handleWebhookEvent(event);

      res.status(HttpStatus.OK).json({ received: true });
    } catch (err: any) {
      this.logger.error(`Webhook signature verification failed: ${err.message}`);
      res.status(HttpStatus.BAD_REQUEST).json({ error: "Webhook signature verification failed" });
    }
  }
}
