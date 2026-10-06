import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { STRIPE_API_VERSION } from "./stripe-period";

// Stripe v22 CJS `export =` isn't compatible with `module: "nodenext"` named
// imports, so we use require() for the constructor value.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Stripe = require("stripe");

/**
 * Thin wrapper around the Stripe SDK.
 *
 * Initialised lazily — if STRIPE_SECRET_KEY is not set the service still
 * boots but every call that needs the client throws a clear error.
 */
@Injectable()
export class StripeService implements OnModuleInit {
  private readonly logger = new Logger(StripeService.name);
  private stripe: any = null;

  constructor(private readonly config: ConfigService<AppConfig>) {}

  onModuleInit() {
    const secretKey = this.config.get<AppConfig["stripe"]>("stripe")?.secretKey;
    if (secretKey) {
      this.stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION }); // #2436
      this.logger.log("Stripe SDK initialised");
    } else {
      this.logger.warn(
        "STRIPE_SECRET_KEY not set — billing features disabled. Set the key to enable Stripe.",
      );
    }
  }

  /** Returns true when a valid API key is configured. */
  get isConfigured(): boolean {
    return this.stripe !== null;
  }

  /** Get the underlying Stripe instance (throws if not configured). */
  get client(): any {
    if (!this.stripe) {
      throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY to enable billing.");
    }
    return this.stripe;
  }

  /** Returns the webhook signing secret (used by the webhook controller). */
  get webhookSecret(): string {
    return this.config.get<AppConfig["stripe"]>("stripe")?.webhookSecret ?? "";
  }

  // ─── Customer ──────────────────────────────────────────────────────────────

  async createCustomer(params: {
    email: string;
    name: string;
    metadata?: Record<string, string>;
  }): Promise<{ id: string; email: string; name: string }> {
    return this.client.customers.create({
      email: params.email,
      name: params.name,
      metadata: params.metadata,
    });
  }

  async getCustomer(customerId: string): Promise<any> {
    return this.client.customers.retrieve(customerId);
  }

  // ─── Checkout Session ──────────────────────────────────────────────────────

  async createCheckoutSession(params: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
  }): Promise<{ id: string; url: string }> {
    return this.client.checkout.sessions.create({
      customer: params.customerId,
      mode: "subscription",
      line_items: [{ price: params.priceId, quantity: 1 }],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      metadata: params.metadata,
    });
  }

  // ─── Subscription ─────────────────────────────────────────────────────────

  /** `params` carries `expand` (SA-690: checkout completion reads each item's product metadata). */
  async getSubscription(subId: string, params?: { expand?: string[] }): Promise<any> {
    return params
      ? this.client.subscriptions.retrieve(subId, params)
      : this.client.subscriptions.retrieve(subId);
  }

  async updateSubscription(subId: string, params: any): Promise<any> {
    return this.client.subscriptions.update(subId, params);
  }

  /**
   * `params` (`prorate`, `invoice_now`) and `options` (`idempotencyKey`) are for a caller that must cancel
   * exactly once without a proration invoice (the duplicate-checkout guard); omit both for the plain cancel.
   */
  async cancelSubscription(
    subId: string,
    params?: { prorate?: boolean; invoice_now?: boolean },
    options?: { idempotencyKey?: string },
  ): Promise<any> {
    if (!params && !options) return this.client.subscriptions.cancel(subId);
    return this.client.subscriptions.cancel(subId, params ?? {}, options);
  }

  // ─── Invoices ─────────────────────────────────────────────────────────────

  async getInvoice(invoiceId: string): Promise<any> {
    return this.client.invoices.retrieve(invoiceId);
  }

  /** Voids an OPEN invoice (a paid one cannot be voided — refund it instead). */
  async voidInvoice(invoiceId: string): Promise<any> {
    return this.client.invoices.voidInvoice(invoiceId);
  }

  // ─── Billing Portal ───────────────────────────────────────────────────────

  /** #2476: `request` caps this one call (stripe-node's `timeout` / `maxNetworkRetries`); omit it for
   *  Stripe's defaults. */
  async createBillingPortalSession(
    params: { customerId: string; returnUrl: string },
    request?: { timeoutMs: number; maxNetworkRetries: number },
  ): Promise<{ url: string }> {
    return this.client.billingPortal.sessions.create(
      { customer: params.customerId, return_url: params.returnUrl },
      request
        ? { timeout: request.timeoutMs, maxNetworkRetries: request.maxNetworkRetries }
        : undefined,
    );
  }

  // ─── Webhook signature verification ───────────────────────────────────────

  constructWebhookEvent(payload: Buffer, signature: string): any {
    return this.client.webhooks.constructEvent(payload, signature, this.webhookSecret);
  }
}
