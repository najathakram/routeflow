import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../../config/configuration";
import { roundMoney } from "../../common/pricing";
import {
  PaymentProvider,
  CreateHostedCheckoutRequest,
  HostedCheckoutSession,
  NormalizedCheckout,
  ExpireCheckoutResult,
  NormalizedConnectEvent,
} from "./payment-provider.interface";

// Stripe v22 CJS `export =` isn't compatible with `module: "nodenext"` named
// imports, so we use require() for the constructor value (mirrors
// billing/stripe.service.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Stripe = require("stripe");

/**
 * The ONLY file in the payment-requests module that imports the Stripe SDK or
 * reads a snake_case Stripe field. Everything downstream
 * (`PaymentRequestsService`, `ConnectWebhookController`) speaks the normalized
 * shapes from `payment-provider.interface.ts` instead. stripe-connect has the
 * same rule and its own single adapter for it
 * (`stripe-connect/provider/stripe-connect-oauth.provider.ts`) — the OAuth
 * calls belong to a different port because they use the platform key against
 * Stripe's OAuth endpoints rather than acting on a connected account.
 *
 * Builds its own Stripe client from env (`STRIPE_SECRET_KEY`,
 * `STRIPE_CONNECT_WEBHOOK_SECRET`) — deliberately independent of the SaaS
 * billing module's `StripeService`. Connect buyer payments and platform
 * billing are signed with different webhook secrets and must stay decoupled
 * failure domains: a billing outage must never take buyer card payments down
 * with it, or vice versa.
 *
 * Also owns the SINGLE cents conversion for both modules — dollars in,
 * dollars out; nothing outside this file ever multiplies or divides by 100.
 */
@Injectable()
export class StripePaymentProvider implements PaymentProvider {
  private readonly logger = new Logger(StripePaymentProvider.name);
  private readonly stripe: any;
  private readonly webhookSecret: string;

  constructor(config: ConfigService<AppConfig>) {
    const stripeConfig = config.get<AppConfig["stripe"]>("stripe");
    const secretKey = stripeConfig?.secretKey ?? "";
    this.webhookSecret = stripeConfig?.connectWebhookSecret ?? "";
    this.stripe = secretKey ? new Stripe(secretKey) : null;
    if (!secretKey) {
      this.logger.warn("STRIPE_SECRET_KEY not set — buyer card payments disabled.");
    }
  }

  get isConfigured(): boolean {
    return this.stripe !== null && this.webhookSecret !== "";
  }

  private get client(): any {
    if (!this.stripe) {
      throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY to enable card payments.");
    }
    return this.stripe;
  }

  // ─── Money — the single cents conversion ────────────────────────────────────

  private toCents(amountDollars: number, currency: string): number {
    if (currency.toLowerCase() !== "usd") {
      // v1 is USD-only: silently treating e.g. JPY (zero-decimal) dollars as
      // cents would misprice by 100x, so refuse outright instead.
      throw new Error(
        `Unsupported currency for Stripe Connect payments: ${currency} (USD only in v1)`,
      );
    }
    return Math.round(roundMoney(amountDollars) * 100);
  }

  private fromCents(cents: number): number {
    return roundMoney(cents / 100);
  }

  // ─── Checkout ────────────────────────────────────────────────────────────

  async createHostedCheckout(req: CreateHostedCheckoutRequest): Promise<HostedCheckoutSession> {
    const unitAmount = this.toCents(req.amountDollars, req.currency);
    // Both the session's own metadata AND payment_intent_data.metadata carry
    // the caller's metadata (tenantId, buyerPaymentRequestId) — the latter is
    // what makes the PaymentIntent itself resolution-complete for
    // payment_intent.succeeded, the only event allowed to write money.
    const session = await this.client.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: req.currency.toLowerCase(),
              unit_amount: unitAmount,
              product_data: { name: req.description },
            },
          },
        ],
        metadata: req.metadata,
        payment_intent_data: { metadata: req.metadata },
        customer_email: req.customerEmail ?? undefined,
        success_url: req.successUrl,
        cancel_url: req.cancelUrl,
      },
      { stripeAccount: req.accountRef },
    );
    return {
      sessionId: session.id,
      url: session.url,
    };
  }

  async readCheckout(accountRef: string, sessionId: string): Promise<NormalizedCheckout> {
    const session = await this.client.checkout.sessions.retrieve(sessionId, {
      stripeAccount: accountRef,
    });
    return this.normalizeCheckout(session);
  }

  async expireCheckout(accountRef: string, sessionId: string): Promise<ExpireCheckoutResult> {
    try {
      await this.client.checkout.sessions.expire(sessionId, { stripeAccount: accountRef });
      return { outcome: "expired" };
    } catch (err: any) {
      const code = err?.raw?.code ?? err?.code;
      const notOpen = err?.statusCode === 400 || code === "checkout_session_expired";
      if (!notOpen) throw err;
      // Stripe 400s once the session is no longer open (completed OR already
      // expired) without saying which — re-read rather than swallow the
      // error, so the caller always gets a definite, truthful outcome.
      //
      // Classify off `status`, NEVER off `paid` alone: a delayed-notification
      // method (ACH) leaves the session `complete` with `payment_status:
      // "unpaid"` for days while its PaymentIntent is still processing, and
      // reporting that as "already_expired" would let cancelOwn flip the row
      // to CANCELLED while the charge is still in flight (invariant 6).
      const session = await this.readCheckout(accountRef, sessionId);
      if (session.status === "complete") return { outcome: "already_completed" };
      if (session.status === "expired") return { outcome: "already_expired" };
      // Still `open` — Stripe also 400s an open session whose PaymentIntent is
      // in flight (processing / requires_action). The hosted page is live and
      // payable, so surface the failure instead of declaring the session dead.
      throw err;
    }
  }

  private normalizeCheckout(session: any): NormalizedCheckout {
    return {
      sessionId: session.id,
      paymentIntentId:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : (session.payment_intent?.id ?? null),
      status: session.status,
      paid: session.payment_status === "paid",
      amount:
        typeof session.amount_total === "number" ? this.fromCents(session.amount_total) : undefined,
      currency: session.currency ? String(session.currency).toUpperCase() : undefined,
    };
  }

  // ─── Webhook events ──────────────────────────────────────────────────────

  verifyEvent(rawBody: Buffer, signature: string): NormalizedConnectEvent {
    const event = this.client.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    return this.normalizeEvent(event);
  }

  private normalizeEvent(event: any): NormalizedConnectEvent {
    const base = {
      eventId: event.id,
      accountRef: event.account,
      created: new Date(event.created * 1000),
    };
    const obj = event.data?.object ?? {};
    switch (event.type) {
      case "payment_intent.succeeded":
        return {
          ...base,
          type: "payment_intent.succeeded",
          paymentIntentId: obj.id,
          amountDollars: this.fromCents(obj.amount ?? 0),
          currency: obj.currency ? String(obj.currency).toUpperCase() : "USD",
          methodKind: this.methodKind(obj.payment_method_types),
          metadata: obj.metadata ?? {},
        };
      case "checkout.session.completed":
        return {
          ...base,
          type: "checkout.session.completed",
          sessionId: obj.id,
          paymentIntentId:
            typeof obj.payment_intent === "string"
              ? obj.payment_intent
              : (obj.payment_intent?.id ?? null),
          paid: obj.payment_status === "paid",
          metadata: obj.metadata ?? {},
        };
      case "checkout.session.expired":
        return {
          ...base,
          type: "checkout.session.expired",
          sessionId: obj.id,
          metadata: obj.metadata ?? {},
        };
      case "checkout.session.async_payment_failed":
        return {
          ...base,
          type: "checkout.session.async_payment_failed",
          sessionId: obj.id,
          metadata: obj.metadata ?? {},
        };
      case "account.updated":
        return {
          ...base,
          type: "account.updated",
          chargesEnabled: !!obj.charges_enabled,
          detailsSubmitted: !!obj.details_submitted,
        };
      case "charge.refunded":
        return {
          ...base,
          type: "charge.refunded",
          chargeId: obj.id,
          paymentIntentId:
            typeof obj.payment_intent === "string"
              ? obj.payment_intent
              : (obj.payment_intent?.id ?? null),
          amountRefundedDollars: this.fromCents(obj.amount_refunded ?? 0),
          metadata: obj.metadata ?? {},
        };
      case "charge.dispute.created":
        return {
          ...base,
          type: "charge.dispute.created",
          chargeId: typeof obj.charge === "string" ? obj.charge : (obj.charge?.id ?? ""),
          paymentIntentId:
            typeof obj.payment_intent === "string"
              ? obj.payment_intent
              : (obj.payment_intent?.id ?? null),
          amountDollars: this.fromCents(obj.amount ?? 0),
          reason: obj.reason ?? null,
          metadata: obj.metadata ?? {},
        };
      case "account.application.deauthorized":
        return { ...base, type: "account.application.deauthorized" };
      default:
        // Ledgered and acknowledged by the caller — never a silent drop.
        return { ...base, type: "other", rawType: event.type };
    }
  }

  private methodKind(types: unknown): "card" | "us_bank_account" | "other" {
    const first = Array.isArray(types) ? types[0] : undefined;
    if (first === "card") return "card";
    if (first === "us_bank_account") return "us_bank_account";
    return "other";
  }
}
