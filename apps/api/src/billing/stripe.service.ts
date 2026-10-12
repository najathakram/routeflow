import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { STRIPE_API_VERSION, stripeInvoiceSubscriptionId } from "./stripe-period";
import type { InvoiceFacts } from "./catchup-claim";
import { COUPON_SYNC_EXPAND, COUPON_SYNC_REQUEST, isInvoiceUpcomingNone } from "./coupon-unbilled";

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

  /**
   * B1158: a subscription's status and whether its latest invoice's payment is STILL IN FLIGHT (a bank debit —
   * ACH / SEPA — whose PaymentIntent is `processing`). Under API dahlia `Invoice.payment_intent` no longer exists:
   * the invoice carries `payments` (InvoicePayment list) and each entry names its PaymentIntent at
   * `payment.payment_intent` (an id, or an object when expanded). `resource_missing` on the subscription means
   * Stripe no longer knows it ({ status: null }); ANY other error — including one reading a PaymentIntent —
   * rethrows, because a failed read says nothing about whether money is in flight.
   */
  async getSubscriptionPaymentState(
    subId: string,
  ): Promise<{ status: string | null; paymentProcessing: boolean }> {
    let sub: any;
    try {
      sub = await this.client.subscriptions.retrieve(subId, {
        // 4 levels is Stripe's expand limit: the PaymentIntent object comes back in the same call.
        expand: ["latest_invoice.payments.data.payment.payment_intent"],
      });
    } catch (err) {
      const e = err as { code?: string; statusCode?: number } | undefined;
      if (e?.code === "resource_missing" || e?.statusCode === 404) {
        return { status: null, paymentProcessing: false };
      }
      throw err;
    }
    const status: string | null = typeof sub?.status === "string" ? sub.status : null;
    const invoice = sub?.latest_invoice;
    const payments: any[] =
      invoice && typeof invoice === "object" && Array.isArray(invoice.payments?.data)
        ? invoice.payments.data
        : [];
    let paymentProcessing = false;
    for (const entry of payments) {
      if (entry?.payment?.type !== "payment_intent") continue;
      const ref = entry.payment.payment_intent;
      const pi =
        ref && typeof ref === "object"
          ? ref
          : typeof ref === "string"
            ? await this.client.paymentIntents.retrieve(ref)
            : null;
      if (pi?.status === "processing") paymentProcessing = true;
    }
    return { status, paymentProcessing };
  }

  /**
   * SA-736r M3: the coupon sync's subscription read - discounts expanded, capped by the per-request options
   * (a timeout throws, so the webhook ledger records an error and Stripe redelivers). Never the payload.
   */
  async retrieveSubscriptionWithDiscounts(subId: string): Promise<any> {
    return this.client.subscriptions.retrieve(
      subId,
      { expand: [...COUPON_SYNC_EXPAND] },
      {
        timeout: COUPON_SYNC_REQUEST.timeoutMs,
        maxNetworkRetries: COUPON_SYNC_REQUEST.maxNetworkRetries,
      },
    );
  }

  /**
   * SA-736r: the subscription's UPCOMING invoice (`invoices.createPreview`), or null when Stripe says it has
   * none (`invoice_upcoming_none`: ending or canceled) - a null result is that case. Any other error throws.
   */
  async previewNextInvoice(subId: string): Promise<any> {
    try {
      return await this.client.invoices.createPreview(
        { subscription: subId },
        {
          timeout: COUPON_SYNC_REQUEST.timeoutMs,
          maxNetworkRetries: COUPON_SYNC_REQUEST.maxNetworkRetries,
        },
      );
    } catch (err) {
      if (isInvoiceUpcomingNone(err)) return null;
      throw err;
    }
  }

  /** B1158: the completed session by id — the parked-checkout sweep re-runs the webhook handling from it. */
  async getCheckoutSession(sessionId: string): Promise<any> {
    return this.client.checkout.sessions.retrieve(sessionId);
  }

  /** `options.idempotencyKey` makes a retried update a replay, never a second application. */
  async updateSubscription(
    subId: string,
    params: any,
    options?: { idempotencyKey?: string },
  ): Promise<any> {
    return options
      ? this.client.subscriptions.update(subId, params, options)
      : this.client.subscriptions.update(subId, params);
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

  /**
   * SA-733r4 N2: an invoice's settlement facts for the catch-up claim - paid?, a payment still PROCESSING (a bank
   * debit; `Invoice.payment_intent` is gone under dahlia, so `payments` is expanded like
   * {@link getSubscriptionPaymentState}), and whether Stripe will try again. `resource_missing` => status null.
   * Any other error (including one reading a PaymentIntent) rethrows: a failed read says nothing about money
   * in flight.
   */
  async getInvoiceFacts(invoiceId: string): Promise<InvoiceFacts> {
    let inv: any;
    try {
      inv = await this.client.invoices.retrieve(invoiceId, {
        expand: ["payments.data.payment.payment_intent"],
      });
    } catch (err) {
      const e = err as { code?: string; statusCode?: number } | undefined;
      if (e?.code === "resource_missing" || e?.statusCode === 404) {
        return {
          status: null,
          amountPaid: 0,
          amountDue: 0,
          paymentProcessing: false,
          nextPaymentAttempt: null,
          attemptCount: 0,
          subscriptionId: null,
        };
      }
      throw err;
    }
    const payments: any[] = Array.isArray(inv?.payments?.data) ? inv.payments.data : [];
    let paymentProcessing = false;
    for (const entry of payments) {
      if (entry?.payment?.type !== "payment_intent") continue;
      const ref = entry.payment.payment_intent;
      const pi =
        ref && typeof ref === "object"
          ? ref
          : typeof ref === "string"
            ? await this.client.paymentIntents.retrieve(ref)
            : null;
      if (pi?.status === "processing") paymentProcessing = true;
    }
    return {
      status: typeof inv?.status === "string" ? inv.status : null,
      amountPaid: Number.isFinite(inv?.amount_paid) ? inv.amount_paid : 0,
      amountDue: Number.isFinite(inv?.amount_due) ? inv.amount_due : 0,
      paymentProcessing,
      nextPaymentAttempt:
        typeof inv?.next_payment_attempt === "number" ? inv.next_payment_attempt : null,
      attemptCount: Number.isFinite(inv?.attempt_count) ? inv.attempt_count : 0,
      subscriptionId: stripeInvoiceSubscriptionId(inv),
      amountRemaining: Number.isFinite(inv?.amount_remaining) ? inv.amount_remaining : undefined,
      hostedInvoiceUrl: typeof inv?.hosted_invoice_url === "string" ? inv.hosted_invoice_url : null,
      invoiceNumber: typeof inv?.number === "string" ? inv.number : null,
      currency: typeof inv?.currency === "string" ? inv.currency : null,
      periodLabel: invoicePeriodLabel(inv),
    };
  }

  /** The invoice items attached to one invoice (the catch-up stub's tag is read from their metadata). */
  async listInvoiceItems(invoiceId: string): Promise<any[]> {
    const page = await this.client.invoiceItems.list({ invoice: invoiceId, limit: 100 });
    return Array.isArray(page?.data) ? page.data : [];
  }

  /** A subscription's most recent invoices (newest first) - the catch-up sweep looks for the first paid one. */
  async listSubscriptionInvoices(subId: string, limit = 5): Promise<any[]> {
    const page = await this.client.invoices.list({ subscription: subId, limit });
    return Array.isArray(page?.data) ? page.data : [];
  }

  /**
   * One status of a subscription's invoices, ALL pages: a `starting_after` loop with a hard page cap, so a tenant
   * with a long open tail is never silently truncated at the first page (SA-733r M2).
   */
  private async listInvoicesPaged(subId: string, status: string, maxPages: number): Promise<any[]> {
    const out: any[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res: any = await this.client.invoices.list({
        subscription: subId,
        status: status as any,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      const data: any[] = Array.isArray(res?.data) ? res.data : [];
      out.push(...data);
      if (!res?.has_more || data.length === 0) break;
      startingAfter = data[data.length - 1]?.id;
      if (!startingAfter) break;
    }
    return out;
  }

  /** A subscription's OPEN invoices, oldest first, all pages up to `maxPages`. */
  async listOpenSubscriptionInvoices(subId: string, maxPages = 5): Promise<any[]> {
    const rows = await this.listInvoicesPaged(subId, "open", maxPages);
    return rows.sort((a, b) => (a?.created ?? 0) - (b?.created ?? 0));
  }

  /**
   * SA-777: a customer's OPEN invoices, capped at `limit` (the Billing card sums what is owed, it never pages). The
   * customer id is the TENANT ROW's, never a request value. `request` caps this one call like the portal route does.
   */
  async listOpenCustomerInvoices(
    customerId: string,
    limit = 10,
    request?: { timeoutMs: number; maxNetworkRetries: number },
  ): Promise<any[]> {
    const page = await this.client.invoices.list(
      { customer: customerId, status: "open", limit },
      request
        ? { timeout: request.timeoutMs, maxNetworkRetries: request.maxNetworkRetries }
        : undefined,
    );
    return Array.isArray(page?.data) ? page.data : [];
  }

  /** Deletes a DRAFT invoice (only a draft can be deleted; an open one is voided). */
  async deleteDraftInvoice(invoiceId: string): Promise<any> {
    return this.client.invoices.del(invoiceId);
  }

  /** Voids an OPEN invoice (a paid one cannot be voided — refund it instead). */
  async voidInvoice(invoiceId: string): Promise<any> {
    return this.client.invoices.voidInvoice(invoiceId);
  }

  /**
   * SA-733r6 (B4): the card autopay will charge, for the Billing card ("Your Visa ending 4242 expires Oct 31").
   * The customer's default payment method (a card only; a bank debit has no expiry), expanded in one call.
   * Null when the customer has none or it is not a card.
   */
  async getDefaultCardSummary(
    customerId: string,
  ): Promise<{ brand: string; last4: string; expMonth: number; expYear: number } | null> {
    const customer = await this.client.customers.retrieve(customerId, {
      expand: ["invoice_settings.default_payment_method"],
    });
    const pm = customer?.invoice_settings?.default_payment_method;
    const card = pm && typeof pm === "object" ? pm.card : null;
    if (!card || typeof card.last4 !== "string") return null;
    return {
      brand: typeof card.brand === "string" ? card.brand : "card",
      last4: card.last4,
      expMonth: Number(card.exp_month),
      expYear: Number(card.exp_year),
    };
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

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "October 2026": the month (UTC) the invoice's first line bills, or null when Stripe sent no line period. */
function invoicePeriodLabel(inv: any): string | null {
  const start = inv?.lines?.data?.[0]?.period?.start;
  if (typeof start !== "number" || !(start > 0)) return null;
  const d = new Date(start * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
