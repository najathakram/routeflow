/**
 * Port for hosted-checkout card payments on a tenant's own connected Stripe
 * account. This is the ONLY thing payment-requests' domain code
 * (`PaymentRequestsService`, `ConnectWebhookController`) may depend on for
 * Stripe behavior — every Stripe SDK call and every snake_case Stripe field
 * lives behind the single adapter that implements it
 * (`stripe-payment-provider.ts`). Domain code speaks these normalized,
 * camelCase, dollar-denominated shapes only.
 *
 * DI: there is no concrete class to depend on directly — inject with
 * `@Inject(PAYMENT_PROVIDER)` against the `PaymentProvider` type, so tests
 * can substitute a fake without touching the network or the Stripe SDK.
 */
export const PAYMENT_PROVIDER = Symbol("PaymentProvider");

/** Everything needed to open a hosted Checkout Session on the connected account. */
export interface CreateHostedCheckoutRequest {
  /** The tenant's connected Stripe account id — the session is created ON it. */
  accountRef: string;
  /** Dollars, already clamped/rounded by the caller (`roundMoney`). */
  amountDollars: number;
  /** ISO 4217 code, e.g. "USD" — the adapter throws for anything but USD (v1 is USD-only). */
  currency: string;
  /** Line-item description shown on the Stripe-hosted page. */
  description: string;
  customerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
  /**
   * Carried into BOTH the session's own metadata and
   * `payment_intent_data.metadata` by the adapter, so the resulting
   * PaymentIntent is self-describing — `payment_intent.succeeded` (the only
   * event that ever writes money) never needs a session round trip to
   * resolve a tenant/request. Callers pass `{ tenantId, buyerPaymentRequestId }`.
   */
  metadata: Record<string, string>;
}

export interface HostedCheckoutSession {
  sessionId: string;
  url: string;
}

/** A Checkout Session's current state, normalized off Stripe's snake_case shape. */
export interface NormalizedCheckout {
  sessionId: string;
  paymentIntentId?: string | null;
  status: "open" | "complete" | "expired";
  paid: boolean;
  amount?: number;
  currency?: string;
}

export type ExpireCheckoutOutcome = "expired" | "already_completed" | "already_expired";

export interface ExpireCheckoutResult {
  outcome: ExpireCheckoutOutcome;
}

interface NormalizedConnectEventBase {
  /** Stripe's event id — the natural primary key for the event ledger. */
  eventId: string;
  /** The connected account the event fired on (`event.account`). */
  accountRef: string;
  /** Stripe's `event.created`, used for the account.updated ordering guard. */
  created: Date;
}

export interface NormalizedPiSucceededEvent extends NormalizedConnectEventBase {
  type: "payment_intent.succeeded";
  paymentIntentId: string;
  amountDollars: number;
  currency: string;
  methodKind: "card" | "us_bank_account" | "other";
  metadata: Record<string, string>;
}

export interface NormalizedSessionCompletedEvent extends NormalizedConnectEventBase {
  type: "checkout.session.completed";
  sessionId: string;
  paymentIntentId: string | null;
  paid: boolean;
  metadata: Record<string, string>;
}

export interface NormalizedSessionExpiredEvent extends NormalizedConnectEventBase {
  type: "checkout.session.expired";
  sessionId: string;
  metadata: Record<string, string>;
}

/**
 * A delayed payment method (ACH debit) that Stripe accepted at checkout time
 * and only failed days later. `checkout.session.expired` never fires for such
 * a session — it is already `complete` — so this is the ONLY event that can
 * release the request row, and without it a failed bank debit would hold the
 * buyer's one open-request slot forever.
 */
export interface NormalizedSessionAsyncPaymentFailedEvent extends NormalizedConnectEventBase {
  type: "checkout.session.async_payment_failed";
  sessionId: string;
  metadata: Record<string, string>;
}

export interface NormalizedAccountUpdatedEvent extends NormalizedConnectEventBase {
  type: "account.updated";
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
}

export interface NormalizedChargeRefundedEvent extends NormalizedConnectEventBase {
  type: "charge.refunded";
  chargeId: string;
  paymentIntentId: string | null;
  amountRefundedDollars: number;
  metadata: Record<string, string>;
}

export interface NormalizedDisputeCreatedEvent extends NormalizedConnectEventBase {
  type: "charge.dispute.created";
  chargeId: string;
  paymentIntentId: string | null;
  amountDollars: number;
  reason: string | null;
  metadata: Record<string, string>;
}

export interface NormalizedDeauthorizedEvent extends NormalizedConnectEventBase {
  type: "account.application.deauthorized";
}

/**
 * Anything the endpoint receives that isn't one of the types above. Still
 * ledgered and acknowledged (200) — nothing may silently `default: break` an
 * event type the endpoint subscribes to.
 */
export interface NormalizedOtherEvent extends NormalizedConnectEventBase {
  type: "other";
  rawType: string;
}

export type NormalizedConnectEvent =
  | NormalizedPiSucceededEvent
  | NormalizedSessionCompletedEvent
  | NormalizedSessionExpiredEvent
  | NormalizedSessionAsyncPaymentFailedEvent
  | NormalizedAccountUpdatedEvent
  | NormalizedChargeRefundedEvent
  | NormalizedDisputeCreatedEvent
  | NormalizedDeauthorizedEvent
  | NormalizedOtherEvent;

export interface PaymentProvider {
  /** Opens a hosted Checkout Session on the connected account. */
  createHostedCheckout(req: CreateHostedCheckoutRequest): Promise<HostedCheckoutSession>;

  /**
   * Reads a session's current state — used by cancel/expire flows to decide
   * what actually happened before touching the request row.
   */
  readCheckout(accountRef: string, sessionId: string): Promise<NormalizedCheckout>;

  /**
   * Expires an open session. Stripe's `expire` call 400s once the session is
   * no longer open (already completed, or already expired) — the adapter
   * re-reads the session in that case rather than surfacing a bare error, so
   * the caller always gets a definite, truthful outcome instead of a
   * swallowed exception.
   *
   * The re-read is classified off `status`, not `paid`: a `complete` session
   * whose delayed charge (ACH) is still processing reports `unpaid` for days
   * and is `already_completed`, never `already_expired`. If the re-read still
   * says `open` — Stripe also 400s an open session with an in-flight
   * PaymentIntent — the original error is rethrown, because the session is
   * live and payable and no outcome would be truthful. Callers must treat a
   * throw as "could not confirm" and refuse to touch the row.
   */
  expireCheckout(accountRef: string, sessionId: string): Promise<ExpireCheckoutResult>;

  /**
   * Verifies the webhook signature and normalizes the event. Synchronous —
   * everything each variant needs is already on the raw Stripe payload, so no
   * follow-up API call is required. Throws on a bad signature.
   */
  verifyEvent(rawBody: Buffer, signature: string): NormalizedConnectEvent;

  /**
   * Whether the provider has the secrets it needs to verify webhooks and call
   * the payment API. When false, the webhook endpoint answers 503 so the
   * provider RETRIES the delivery later — a paid event that arrives before the
   * secrets are configured must be redelivered, never acknowledged into the
   * void (carried from the #397 hardening).
   */
  readonly isConfigured: boolean;
}
