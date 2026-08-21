import { Controller, HttpCode, HttpStatus, Inject, Logger, Post, Req, Res } from "@nestjs/common";
import { ApiExcludeEndpoint, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { StripeConnectService } from "../stripe-connect/stripe-connect.service";
import { PaymentRequestsService } from "./payment-requests.service";
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type NormalizedConnectEvent,
} from "./provider/payment-provider.interface";

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Webhooks for events ON CONNECTED ACCOUNTS (buyer card payments), separate
 * from /billing/webhook (platform SaaS billing) because Stripe signs the two
 * endpoints with different secrets — a billing outage must never take buyer
 * card payments down with it, or vice versa. Verification and normalization
 * both happen behind the `PAYMENT_PROVIDER` port (invariant 4); this
 * controller never touches the Stripe SDK or a snake_case Stripe field.
 *
 * Unauthenticated by design — the signature IS the authentication, verified
 * inside the provider against STRIPE_CONNECT_WEBHOOK_SECRET with the raw body
 * (rawBody: true is already set in main.ts for the billing webhook, which
 * this endpoint shares).
 *
 * @SkipThrottle — mirrors the intent of /billing/webhook: Stripe, not a
 * browser, is the caller, and its own retry/backoff must never collide with
 * our per-IP rate limiter.
 *
 * EVENT LEDGER (invariant 3): every delivery is inserted into
 * `StripeConnectEvent` BEFORE anything else happens — a Stripe redelivery
 * collides on the unique event id and, if the first delivery COMPLETED, is
 * acked as a benign duplicate before any tenant resolution or state/money
 * write. The row's `outcome` is filled in once routing finishes, and is what
 * separates a duplicate from a retry: a collision whose row shows no outcome
 * or an `error:` one is re-routed, because that is the redelivery this
 * controller's own 500 asked for (see `alreadyProcessed`).
 *
 * ANTI-SPOOF (invariant 2): every event whose tenant is resolved from
 * metadata (payment_intent.succeeded, checkout.session.expired via
 * PaymentRequestsService; charge.refunded, charge.dispute.created here) is
 * cross-checked with `StripeConnectService.assertEventAccount` before
 * anything is written. `account.updated` / `account.application.deauthorized`
 * resolve their tenant(s) BY accountRef instead — there is no metadata to
 * spoof there, so the check would be circular; see the comments on each
 * branch below.
 *
 * Contract with Stripe: 2xx acknowledges, anything else redelivers. A
 * settlement failure therefore returns 500 ON PURPOSE — the PENDING/other ->
 * SETTLING claim inside PaymentRequestsService makes the retry safe
 * (invariant 7). An event we don't care about is still 200 — nothing in
 * `route()` may silently drop a subscribed event type without at least a
 * debug log + ledger outcome (invariant 11).
 */
@ApiTags("billing-webhooks")
@Controller("billing/webhook/connect")
@SkipThrottle()
export class ConnectWebhookController {
  private readonly logger = new Logger(ConnectWebhookController.name);

  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly connect: StripeConnectService,
    private readonly payments: PaymentRequestsService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly gateway: RouteFlowGateway,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async handle(@Req() req: Request & { rawBody?: Buffer }, @Res() res: Response): Promise<void> {
    // Secrets not configured yet → 503 so Stripe REDELIVERS (a paid event
    // arriving before configuration must never be acknowledged into the void).
    if (!this.provider.isConfigured) {
      this.logger.warn(
        "Connect webhook received while Stripe secrets are unset — asking for redelivery.",
      );
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({ error: "Payments not configured" });
      return;
    }

    const signature = req.headers["stripe-signature"] as string | undefined;
    if (!signature || !req.rawBody) {
      // Misconfiguration is logged loudly but acknowledged — redelivering a
      // webhook cannot fix a missing raw body / signature header.
      this.logger.warn(
        `Connect webhook dropped (signature=${!!signature} rawBody=${!!req.rawBody})`,
      );
      res.status(HttpStatus.OK).json({ received: true });
      return;
    }

    let evt: NormalizedConnectEvent;
    try {
      evt = this.provider.verifyEvent(req.rawBody, signature);
    } catch (err: any) {
      this.logger.error(`Connect webhook signature verification failed: ${err?.message}`);
      res.status(HttpStatus.BAD_REQUEST).json({ error: "Invalid signature" });
      return;
    }

    // Insert-first ledger (invariant 3) — BEFORE any tenant resolution or
    // state/money write. A unique violation on the Stripe event id means this
    // delivery was already ledgered; whether that is a benign duplicate or
    // the very retry we asked for is decided by the recorded outcome.
    try {
      await this.prisma.stripeConnectEvent.create({
        data: {
          id: evt.eventId,
          accountRef: evt.accountRef,
          type: evt.type,
          createdAt: evt.created,
        },
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        if (await this.alreadyProcessed(evt.eventId)) {
          this.logger.log(
            `Connect webhook ${evt.type} (${evt.eventId}) already processed — duplicate delivery, skipping`,
          );
          res.status(HttpStatus.OK).json({ received: true });
          return;
        }
        // An earlier delivery of this event did NOT finish. Skipping here
        // would discard the redelivery our own 500 asked for and strand the
        // request (a SETTLING row with a charged card and no InvoicePayment,
        // recoverable only by hand) — so fall through and re-route it.
        // Invariant 7's PENDING/SETTLING claim is what makes that safe.
        this.logger.warn(
          `Connect webhook ${evt.type} (${evt.eventId}) redelivered after an unfinished attempt — reprocessing`,
        );
      } else {
        this.logger.error(`Connect webhook ledger insert failed: ${(err as any)?.message}`);
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: "Processing failed" });
        return;
      }
    }

    let outcome = "ignored";
    try {
      outcome = await this.route(evt);
      res.status(HttpStatus.OK).json({ received: true });
    } catch (err: any) {
      outcome = `error:${String(err?.message ?? "unknown").slice(0, 180)}`;
      this.logger.error(`Connect webhook ${evt.type} (${evt.eventId}) failed: ${err?.message}`);
      // Non-2xx → Stripe redelivers; the SETTLING claim / ledger dedup above
      // make the retry safe rather than double-applying anything.
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: "Processing failed" });
    } finally {
      // Best-effort bookkeeping only — never let it mask the response
      // already sent above.
      await this.prisma.stripeConnectEvent
        .update({ where: { id: evt.eventId }, data: { outcome } })
        .catch(() => {});
    }
  }

  /**
   * A unique violation on the ledger insert only means "seen before" — it
   * does NOT mean "handled before", and the difference is the whole retry
   * story. `handle()` answers 500 on a routing failure precisely so Stripe
   * redelivers, so an unconditional skip on P2002 would throw away every
   * retry it asked for, including a manual "Resend" from the Stripe dashboard
   * (same event id). Only a delivery that ran to completion and recorded a
   * non-`error:` outcome is a true duplicate; a NULL outcome (the process
   * died mid-route) or an `error:` one is a delivery that must run again.
   */
  private async alreadyProcessed(eventId: string): Promise<boolean> {
    const row = await this.prisma.stripeConnectEvent.findUnique({ where: { id: eventId } });
    return !!row?.outcome && !row.outcome.startsWith("error:");
  }

  private async route(evt: NormalizedConnectEvent): Promise<string> {
    switch (evt.type) {
      // Invariant 1: the ONLY event that ever writes money. Anti-spoof +
      // the SETTLING claim both live inside settleByPaymentIntent.
      case "payment_intent.succeeded": {
        const { handled } = await this.payments.settleByPaymentIntent(evt);
        return handled ? "settled" : "refused";
      }

      // Invariant 10: flips an abandoned CARD request PENDING -> EXPIRED.
      // Anti-spoof lives inside expireBySession.
      case "checkout.session.expired": {
        const { handled } = await this.payments.expireBySession(evt);
        return handled ? "expired" : "refused";
      }

      // Invariant 10's sibling: a delayed payment method (ACH debit) that
      // Stripe accepted at checkout and failed days later. That session is
      // already `complete`, so checkout.session.expired never fires for it —
      // without this branch the request would sit PENDING forever and the
      // partial unique index would lock the buyer out of starting another.
      // Anti-spoof lives inside failBySession.
      case "checkout.session.async_payment_failed": {
        const { handled } = await this.payments.failBySession(evt);
        return handled ? "failed" : "refused";
      }

      case "checkout.session.completed":
        // Invariant 1: payment_intent.succeeded is the ONLY event that ever
        // writes money — this one may update client-side display state, but
        // there is nothing for the server to do with it.
        return "ignored:display-only";

      case "account.updated": {
        const applied = await this.connect.applyAccountUpdate(
          evt.accountRef,
          { chargesEnabled: evt.chargesEnabled, detailsSubmitted: evt.detailsSubmitted },
          evt.created,
        );
        return applied ? "applied" : "stale";
      }

      case "charge.refunded": {
        const tenantId = evt.metadata?.tenantId;
        if (!tenantId) {
          this.logger.error(
            `CRITICAL: charge.refunded ${evt.eventId} has no tenantId in metadata — refusing`,
          );
          return "no_tenant_metadata";
        }
        if (!(await this.connect.assertEventAccount(tenantId, evt.accountRef))) {
          return "account_mismatch";
        }
        await this.notifyTenant(tenantId, "stripe.charge.refunded", {
          chargeId: evt.chargeId,
          paymentIntentId: evt.paymentIntentId,
          amountRefundedDollars: evt.amountRefundedDollars,
        });
        return "notified";
      }

      case "charge.dispute.created": {
        // Unlike charge.refunded — whose event object is a Charge, and so
        // carries the PaymentIntent's metadata — this event object is a
        // DISPUTE, which has metadata of its own (empty unless someone set it
        // through the Disputes API) and inherits nothing. Resolving disputes
        // from `evt.metadata.tenantId` therefore never fired at all: it takes
        // the accountRef path instead, the same non-metadata resolution
        // account.application.deauthorized uses, where the account IS the
        // resolution and an assertEventAccount cross-check would be circular
        // (invariant 2). Metadata still wins if a dispute genuinely has it.
        const metaTenantId = evt.metadata?.tenantId;
        let tenantIds: string[];
        if (metaTenantId) {
          if (!(await this.connect.assertEventAccount(metaTenantId, evt.accountRef))) {
            return "account_mismatch";
          }
          tenantIds = [metaTenantId];
        } else {
          tenantIds = await this.connect.tenantsForAccount(evt.accountRef);
        }
        if (tenantIds.length === 0) {
          this.logger.error(
            `CRITICAL: charge.dispute.created ${evt.eventId} could not be attributed to a tenant (account ${evt.accountRef}) — no alert sent`,
          );
          return "no_matching_tenant";
        }
        for (const tenantId of tenantIds) {
          await this.notifyTenant(tenantId, "stripe.charge.dispute.created", {
            chargeId: evt.chargeId,
            paymentIntentId: evt.paymentIntentId,
            amountDollars: evt.amountDollars,
            reason: evt.reason,
          });
        }
        return "notified";
      }

      case "account.application.deauthorized": {
        // No metadata to cross-check against — accountRef IS the resolution
        // (a connected account can back more than one tenant, same as
        // applyAccountUpdate), so this operates on it directly rather than
        // going through assertEventAccount(tenantId, accountRef).
        const tenantIds = await this.connect.markDeauthorized(evt.accountRef);
        for (const tenantId of tenantIds) {
          await this.notifyTenant(tenantId, "stripe.connect.deauthorized", {
            accountRef: evt.accountRef,
          });
        }
        return tenantIds.length > 0 ? "disconnected" : "no_matching_tenant";
      }

      case "other":
        // Ledgered and acknowledged — never a silent drop of a subscribed
        // event type (invariant 11).
        this.logger.debug(`Connect webhook: ignoring unhandled event type ${evt.rawType}`);
        return `ignored:${evt.rawType}`;

      default: {
        // Exhaustiveness guard: a future NormalizedConnectEvent variant that
        // isn't routed above fails the BUILD, not silently at runtime.
        const _exhaustive: never = evt;
        return "unhandled";
      }
    }
  }

  /**
   * "Create a tenant Notification" (invariant 11) — reuses the two
   * tenant-facing alert mechanisms this codebase already has rather than a
   * bespoke channel: a persisted `AuditService` entry (durable, reviewable
   * even if no operator is online right now) plus the SAME realtime
   * "operators" room the bell icon already uses elsewhere
   * (`RouteFlowGateway.emitBuyerPaymentRequest` is the precedent for
   * "seller attention" events). There is no dedicated `emitXxx` method for
   * these Connect alerts because adding one means editing
   * `gateways/routeflow.gateway.ts`, which is outside this work package's
   * file list — this reaches into the gateway's public `server` field
   * directly instead, mirroring its existing `tenant:{id}:operators` room
   * convention exactly. See the handback notes for the follow-up (a proper
   * `emitStripeConnectAlert` method, and — if a push notification via
   * `NotificationsService` is wanted — wiring `NotificationsModule` into
   * `PaymentRequestsModule`).
   */
  private async notifyTenant(
    tenantId: string,
    action: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.log({
      tenantId,
      userId: null,
      action,
      entityType: "TenantStripeConnect",
      meta,
    });
    try {
      this.gateway.server.to(`tenant:${tenantId}:operators`).emit("stripe.connect.alert", {
        action,
        tenantId,
        ...meta,
        at: new Date().toISOString(),
      });
    } catch (err: any) {
      // Realtime nudge is best-effort — the audit log above is the durable
      // record; a socket-layer failure must never fail the webhook.
      this.logger.warn(`Connect webhook realtime notify failed (${action}): ${err?.message}`);
    }
  }
}
