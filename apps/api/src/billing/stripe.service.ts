import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";

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
      this.stripe = new Stripe(secretKey);
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

  async getSubscription(subId: string): Promise<any> {
    return this.client.subscriptions.retrieve(subId);
  }

  async updateSubscription(subId: string, params: any): Promise<any> {
    return this.client.subscriptions.update(subId, params);
  }

  async cancelSubscription(subId: string): Promise<any> {
    return this.client.subscriptions.cancel(subId);
  }

  // ─── Billing Portal ───────────────────────────────────────────────────────

  async createBillingPortalSession(params: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    return this.client.billingPortal.sessions.create({
      customer: params.customerId,
      return_url: params.returnUrl,
    });
  }

  // ─── Price lookup ─────────────────────────────────────────────────────────

  getPriceIdForPlan(plan: string): string {
    const stripeConfig = this.config.get<AppConfig["stripe"]>("stripe")!;
    switch (plan) {
      case "STARTER":
        return stripeConfig.priceStarter;
      case "PROFESSIONAL":
        return stripeConfig.priceProfessional;
      case "ENTERPRISE":
        return stripeConfig.priceEnterprise;
      default:
        throw new Error(`Unknown plan: ${plan}`);
    }
  }

  // ─── Webhook signature verification ───────────────────────────────────────

  constructWebhookEvent(payload: Buffer, signature: string): any {
    return this.client.webhooks.constructEvent(payload, signature, this.webhookSecret);
  }
}
