import { Controller, Post, Req, Res, HttpCode, HttpStatus, Logger } from "@nestjs/common";
import { ApiTags, ApiExcludeEndpoint } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { claimRedelivery, insertLedgerRow } from "../common/webhook-ledger-claim";
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
 *
 * #2442 — @SkipThrottle: Stripe, not a browser, is the caller; its retry/backoff must never collide
 * with the per-IP rate limiter (the Connect webhook already skips it).
 *
 * #2442 — EVENT LEDGER (as ConnectWebhookController's): every verified event is inserted into
 * `StripeBillingEvent` BEFORE it is handled. A redelivery collides on the Stripe event id and is
 * acked as a duplicate only when the first delivery COMPLETED (a non-null, non-`error:` outcome) —
 * so a redelivered invoice.payment_failed never increments failedPaymentCount twice.
 *
 * #2476 / SA-472a — handlers are NOT all idempotent (onPaymentFailed's increment is a bare add), so a
 * re-run must be EXCLUSIVE: a redelivery re-runs only after claiming the row (common/
 * webhook-ledger-claim.ts — an `error:` row at once, a NULL row only past its lease, both on the DB
 * clock); a row still in flight elsewhere is a 503. The outcome is written only while this delivery
 * still holds its claim, so a worker whose lease was taken over never overwrites the new holder.
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

    // #2442: insert-first ledger, before any handler write. #2476: the insert (or, on a redelivery,
    // the exclusive claim) returns this delivery's claim token — processedAt, on the DB clock.
    let token: Date;
    try {
      const inserted = await insertLedgerRow(this.prisma, "StripeBillingEvent", {
        id: event.id,
        type: event.type,
        createdAt: new Date(
          (Number.isFinite(event.created) ? event.created : Date.now() / 1000) * 1000,
        ),
      });
      if (inserted) {
        token = inserted;
      } else {
        const claim = await claimRedelivery(this.prisma, "StripeBillingEvent", event.id);
        if (claim.kind === "duplicate") {
          this.logger.log(
            `Webhook ${event.type} (${event.id}) already processed — duplicate, skipped`,
          );
          res.status(HttpStatus.OK).json({ received: true });
          return;
        }
        if (claim.kind === "in_flight") {
          // A 2xx would acknowledge an event another worker may still fail; Stripe retries a 503.
          this.logger.warn(
            `Webhook ${event.type} (${event.id}) is being processed by another delivery — 503, Stripe retries`,
          );
          res.status(HttpStatus.SERVICE_UNAVAILABLE).json({ error: "Webhook event in progress" });
          return;
        }
        this.logger.warn(
          `Webhook ${event.type} (${event.id}) redelivered after a failed or expired attempt — reprocessing`,
        );
        token = claim.token;
      }
    } catch (err) {
      this.logger.error(`Webhook ledger insert/claim failed for ${event.type} (${event.id})`, err);
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: "Webhook handler failed" });
      return;
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
      // leaves the row NULL, re-claimable once its lease expires. #2476: LOGGED, never swallowed.
      // #2476: fenced on this delivery's claim — count 0 means the lease expired and another
      // delivery re-claimed the row; its result, not ours, is the one that stands.
      await this.prisma.stripeBillingEvent
        .updateMany({
          where: { id: event.id, outcome: null, processedAt: token },
          data: { outcome },
        })
        .then(({ count }) => {
          if (count === 0)
            this.logger.error(
              `Webhook ${event.type} (${event.id}) claim lost before its outcome write — "${outcome}" not recorded`,
            );
        })
        .catch((e: unknown) =>
          this.logger.error(
            `Webhook ${event.type} (${event.id}) outcome write failed (row left in flight): ${(e as Error)?.message}`,
          ),
        );
    }
  }
}
