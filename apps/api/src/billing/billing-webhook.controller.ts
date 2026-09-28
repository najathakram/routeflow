import { Controller, Post, Req, Res, HttpCode, HttpStatus, Logger } from "@nestjs/common";
import { ApiTags, ApiExcludeEndpoint } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "./stripe.service";
import { BillingService } from "./billing.service";

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Handles Stripe webhook events.
 *
 * This controller is NOT protected by JwtAuthGuard or any tenant guard.
 * Authentication is done via Stripe webhook signature verification.
 *
 * IMPORTANT: The NestFactory.create() call in main.ts must set `rawBody: true`
 * so that `req.rawBody` is available for Stripe signature verification.
 *
 * #2442 — @SkipThrottle: Stripe, not a browser, is the caller; its retry/backoff must never collide
 * with the per-IP rate limiter (the Connect webhook already skips it).
 *
 * #2442 — EVENT LEDGER (as ConnectWebhookController's): every verified event is inserted into
 * `StripeBillingEvent` BEFORE it is handled. A redelivery collides on the Stripe event id and is
 * acked as a duplicate only when the first delivery COMPLETED (a non-null, non-`error:` outcome) —
 * so a redelivered invoice.payment_failed never increments failedPaymentCount twice. A collision
 * whose row shows no outcome or an `error:` one is re-run: that is the redelivery our own 500 asked
 * for, and every handler is already idempotent on its own compare-and-swaps.
 */
@ApiTags("billing-webhooks")
@Controller("billing/webhook")
@SkipThrottle()
export class BillingWebhookController {
  private readonly logger = new Logger(BillingWebhookController.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly billingService: BillingService,
    private readonly prisma: PrismaService,
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

    let event: ReturnType<StripeService["constructWebhookEvent"]>;
    try {
      event = this.stripeService.constructWebhookEvent(rawBody, signature);
    } catch (err: any) {
      this.logger.error(`Webhook signature verification failed: ${err.message}`);
      res.status(HttpStatus.BAD_REQUEST).json({ error: "Webhook signature verification failed" });
      return;
    }

    // #2442: insert-first ledger, before any handler write.
    try {
      await this.prisma.stripeBillingEvent.create({
        data: {
          id: event.id,
          type: event.type,
          createdAt: new Date(
            (Number.isFinite(event.created) ? event.created : Date.now() / 1000) * 1000,
          ),
        },
      });
    } catch (err) {
      if (!isUniqueConstraintViolation(err)) {
        this.logger.error(`Webhook ledger insert failed for ${event.type} (${event.id})`, err);
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: "Webhook handler failed" });
        return;
      }
      if (await this.alreadyProcessed(event.id)) {
        this.logger.log(
          `Webhook ${event.type} (${event.id}) already processed — duplicate, skipped`,
        );
        res.status(HttpStatus.OK).json({ received: true });
        return;
      }
      this.logger.warn(
        `Webhook ${event.type} (${event.id}) redelivered after an unfinished attempt — reprocessing`,
      );
    }

    // A handler failure is NOT a signature problem: report it as what it is (500, so Stripe
    // redelivers) instead of a misleading 400 that sends on-call to rotate the webhook secret and
    // that Stripe counts against the endpoint (repeated 4xx can get the endpoint disabled).
    let outcome = "processed";
    try {
      await this.billingService.handleWebhookEvent(event);
      res.status(HttpStatus.OK).json({ received: true });
    } catch (err: any) {
      outcome = `error:${String(err?.message ?? "unknown").slice(0, 180)}`;
      this.logger.error(`Webhook handler failed for ${event.type}: ${err.message}`, err.stack);
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: "Webhook handler failed" });
    } finally {
      // Best-effort bookkeeping: never let it change the response already sent. A lost outcome
      // leaves the row NULL, which a redelivery treats as unfinished and re-runs (safe).
      await this.prisma.stripeBillingEvent
        .update({ where: { id: event.id }, data: { outcome } })
        .catch(() => {});
    }
  }

  /** #2442: only a delivery that ran to completion (non-null, non-`error:` outcome) is a duplicate. */
  private async alreadyProcessed(eventId: string): Promise<boolean> {
    const row = await this.prisma.stripeBillingEvent.findUnique({ where: { id: eventId } });
    return !!row?.outcome && !row.outcome.startsWith("error:");
  }
}
