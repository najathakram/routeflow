/**
 * Unit tests for StripePaymentProvider — the only file allowed to touch the
 * Stripe SDK or a snake_case Stripe field. Every Stripe call is mocked at
 * `(provider as any).stripe`; nothing here hits the network.
 *
 * Covers: the single cents conversion round-trips exactly, non-USD is
 * refused before any Stripe call, expireCheckout's not-open-400 re-read maps
 * to the right outcome off the session's `status` (telling a completed
 * session — paid OR still-processing ACH — apart from an expired one, and
 * rethrowing for a session that is still open and payable), and verifyEvent
 * normalizes every event type in the port's union — including an
 * unrecognized type falling into "other" rather than being dropped.
 */

import { ConfigService } from "@nestjs/config";
import { StripePaymentProvider } from "./stripe-payment-provider";
import { AppConfig } from "../../config/configuration";
import {
  NormalizedAccountUpdatedEvent,
  NormalizedChargeRefundedEvent,
  NormalizedDeauthorizedEvent,
  NormalizedDisputeCreatedEvent,
  NormalizedOtherEvent,
  NormalizedPiSucceededEvent,
  NormalizedSessionCompletedEvent,
  NormalizedSessionExpiredEvent,
} from "./payment-provider.interface";

function buildProvider() {
  const config = {
    get: () => ({
      secretKey: "sk_test_123",
      webhookSecret: "whsec_billing",
      priceStarter: "",
      priceProfessional: "",
      priceEnterprise: "",
      connectClientId: "ca_123",
      connectWebhookSecret: "whsec_connect_test",
    }),
  } as unknown as ConfigService<AppConfig>;

  const provider = new StripePaymentProvider(config);

  const stripe = {
    checkout: {
      sessions: {
        create: jest.fn(),
        retrieve: jest.fn(),
        expire: jest.fn(),
      },
    },
    webhooks: {
      constructEvent: jest.fn(),
    },
  };
  (provider as any).stripe = stripe;

  return { provider, stripe };
}

const baseRequest = {
  accountRef: "acct_123",
  amountDollars: 12.34,
  currency: "USD",
  description: "Payment to Acme",
  customerEmail: "buyer@example.com",
  successUrl: "https://example.com/success",
  cancelUrl: "https://example.com/cancel",
  metadata: { tenantId: "tenant-1", buyerPaymentRequestId: "req-1" },
};

describe("StripePaymentProvider", () => {
  // ─── Money: the single cents conversion ───────────────────────────────────

  describe("cents conversion", () => {
    it("round-trips dollars through cents exactly on create + read", async () => {
      const { provider, stripe } = buildProvider();
      stripe.checkout.sessions.create.mockResolvedValue({
        id: "cs_1",
        url: "https://checkout.stripe.com/cs_1",
      });

      await provider.createHostedCheckout(baseRequest);

      const [payload] = stripe.checkout.sessions.create.mock.calls[0];
      expect(payload.line_items[0].price_data.unit_amount).toBe(1234);

      stripe.checkout.sessions.retrieve.mockResolvedValue({
        id: "cs_1",
        status: "complete",
        payment_status: "paid",
        payment_intent: "pi_1",
        amount_total: 1234,
        currency: "usd",
      });
      const checkout = await provider.readCheckout("acct_123", "cs_1");
      expect(checkout.amount).toBe(12.34);
    });

    it("throws for a non-USD currency and never calls Stripe", async () => {
      const { provider, stripe } = buildProvider();
      await expect(
        provider.createHostedCheckout({ ...baseRequest, currency: "EUR" }),
      ).rejects.toThrow(/USD/i);
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it("carries payment_intent_data.metadata AND session metadata with tenantId + buyerPaymentRequestId", async () => {
      const { provider, stripe } = buildProvider();
      stripe.checkout.sessions.create.mockResolvedValue({
        id: "cs_2",
        url: "https://checkout.stripe.com/cs_2",
      });

      const result = await provider.createHostedCheckout(baseRequest);

      const [payload, opts] = stripe.checkout.sessions.create.mock.calls[0];
      expect(payload.payment_intent_data.metadata).toEqual({
        tenantId: "tenant-1",
        buyerPaymentRequestId: "req-1",
      });
      expect(payload.metadata).toEqual({
        tenantId: "tenant-1",
        buyerPaymentRequestId: "req-1",
      });
      expect(opts).toEqual({ stripeAccount: "acct_123" });
      expect(result).toEqual({
        sessionId: "cs_2",
        url: "https://checkout.stripe.com/cs_2",
      });
    });
  });

  // ─── expireCheckout: never a swallowed error ──────────────────────────────

  describe("expireCheckout", () => {
    it("returns 'expired' when the session was open and Stripe expires it", async () => {
      const { provider, stripe } = buildProvider();
      stripe.checkout.sessions.expire.mockResolvedValue({ id: "cs_1", status: "expired" });

      const result = await provider.expireCheckout("acct_123", "cs_1");
      expect(result).toEqual({ outcome: "expired" });
      expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
    });

    it("re-reads on a not-open 400 and reports 'already_completed' when the session paid", async () => {
      const { provider, stripe } = buildProvider();
      const err: any = new Error("session is not open");
      err.statusCode = 400;
      stripe.checkout.sessions.expire.mockRejectedValue(err);
      stripe.checkout.sessions.retrieve.mockResolvedValue({
        id: "cs_1",
        status: "complete",
        payment_status: "paid",
        payment_intent: "pi_1",
      });

      const result = await provider.expireCheckout("acct_123", "cs_1");
      expect(result).toEqual({ outcome: "already_completed" });
    });

    it("re-reads on a not-open 400 and reports 'already_expired' when the session was never paid", async () => {
      const { provider, stripe } = buildProvider();
      const err: any = new Error("session is not open");
      err.raw = { code: "checkout_session_expired" };
      stripe.checkout.sessions.expire.mockRejectedValue(err);
      stripe.checkout.sessions.retrieve.mockResolvedValue({
        id: "cs_1",
        status: "expired",
        payment_status: "unpaid",
        payment_intent: null,
      });

      const result = await provider.expireCheckout("acct_123", "cs_1");
      expect(result).toEqual({ outcome: "already_expired" });
    });

    it("reports 'already_completed' for a completed session whose ACH charge is still processing", async () => {
      const { provider, stripe } = buildProvider();
      const err: any = new Error("session is not open");
      err.statusCode = 400;
      stripe.checkout.sessions.expire.mockRejectedValue(err);
      stripe.checkout.sessions.retrieve.mockResolvedValue({
        id: "cs_1",
        status: "complete",
        payment_status: "unpaid",
        payment_intent: "pi_1",
      });

      // Calling this "already_expired" would let cancelOwn flip the row to
      // CANCELLED while the bank debit is still in flight (invariant 6).
      const result = await provider.expireCheckout("acct_123", "cs_1");
      expect(result).toEqual({ outcome: "already_completed" });
    });

    it("rethrows when the re-read shows the session is still open and payable", async () => {
      const { provider, stripe } = buildProvider();
      const err: any = new Error("session is not open");
      err.statusCode = 400;
      stripe.checkout.sessions.expire.mockRejectedValue(err);
      stripe.checkout.sessions.retrieve.mockResolvedValue({
        id: "cs_1",
        status: "open",
        payment_status: "unpaid",
        payment_intent: "pi_1",
      });

      await expect(provider.expireCheckout("acct_123", "cs_1")).rejects.toThrow(
        "session is not open",
      );
    });

    it("propagates an unrelated failure instead of swallowing it", async () => {
      const { provider, stripe } = buildProvider();
      const err: any = new Error("service unavailable");
      err.statusCode = 500;
      stripe.checkout.sessions.expire.mockRejectedValue(err);

      await expect(provider.expireCheckout("acct_123", "cs_1")).rejects.toThrow(
        "service unavailable",
      );
      expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
    });
  });

  // ─── verifyEvent: normalization per type ──────────────────────────────────

  describe("verifyEvent", () => {
    function mockEvent(stripe: any, raw: any) {
      stripe.webhooks.constructEvent.mockReturnValue(raw);
    }

    it("passes the raw body, signature, and connect webhook secret to Stripe", () => {
      const { provider, stripe } = buildProvider();
      mockEvent(stripe, {
        id: "evt_1",
        account: "acct_123",
        created: 1700000000,
        type: "account.application.deauthorized",
        data: { object: { id: "ca_123" } },
      });
      const body = Buffer.from("raw");
      provider.verifyEvent(body, "sig_1");
      expect(stripe.webhooks.constructEvent).toHaveBeenCalledWith(
        body,
        "sig_1",
        "whsec_connect_test",
      );
    });

    it("normalizes payment_intent.succeeded", () => {
      const { provider, stripe } = buildProvider();
      mockEvent(stripe, {
        id: "evt_pi",
        account: "acct_123",
        created: 1700000000,
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_1",
            amount: 1234,
            currency: "usd",
            payment_method_types: ["card"],
            metadata: { tenantId: "tenant-1", buyerPaymentRequestId: "req-1" },
          },
        },
      });
      const evt = provider.verifyEvent(Buffer.from(""), "sig") as NormalizedPiSucceededEvent;
      expect(evt).toEqual({
        eventId: "evt_pi",
        accountRef: "acct_123",
        created: new Date(1700000000 * 1000),
        type: "payment_intent.succeeded",
        paymentIntentId: "pi_1",
        amountDollars: 12.34,
        currency: "USD",
        methodKind: "card",
        metadata: { tenantId: "tenant-1", buyerPaymentRequestId: "req-1" },
      });
    });

    it("normalizes payment_intent.succeeded with an ACH method", () => {
      const { provider, stripe } = buildProvider();
      mockEvent(stripe, {
        id: "evt_pi2",
        account: "acct_123",
        created: 1700000000,
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_2",
            amount: 500,
            currency: "usd",
            payment_method_types: ["us_bank_account"],
            metadata: {},
          },
        },
      });
      const evt = provider.verifyEvent(Buffer.from(""), "sig") as NormalizedPiSucceededEvent;
      expect(evt.methodKind).toBe("us_bank_account");
    });

    it("normalizes checkout.session.completed", () => {
      const { provider, stripe } = buildProvider();
      mockEvent(stripe, {
        id: "evt_cs",
        account: "acct_123",
        created: 1700000000,
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_1",
            payment_intent: "pi_1",
            payment_status: "paid",
            metadata: { buyerPaymentRequestId: "req-1" },
          },
        },
      });
      const evt = provider.verifyEvent(Buffer.from(""), "sig") as NormalizedSessionCompletedEvent;
      expect(evt).toMatchObject({
        type: "checkout.session.completed",
        sessionId: "cs_1",
        paymentIntentId: "pi_1",
        paid: true,
      });
    });

    it("normalizes checkout.session.expired", () => {
      const { provider, stripe } = buildProvider();
      mockEvent(stripe, {
        id: "evt_exp",
        account: "acct_123",
        created: 1700000000,
        type: "checkout.session.expired",
        data: { object: { id: "cs_2", metadata: { buyerPaymentRequestId: "req-2" } } },
      });
      const evt = provider.verifyEvent(Buffer.from(""), "sig") as NormalizedSessionExpiredEvent;
      expect(evt).toMatchObject({ type: "checkout.session.expired", sessionId: "cs_2" });
    });

    it("normalizes account.updated", () => {
      const { provider, stripe } = buildProvider();
      mockEvent(stripe, {
        id: "evt_acct",
        account: "acct_123",
        created: 1700000000,
        type: "account.updated",
        data: { object: { id: "acct_123", charges_enabled: true, details_submitted: false } },
      });
      const evt = provider.verifyEvent(Buffer.from(""), "sig") as NormalizedAccountUpdatedEvent;
      expect(evt).toMatchObject({
        type: "account.updated",
        chargesEnabled: true,
        detailsSubmitted: false,
      });
    });

    it("normalizes charge.refunded", () => {
      const { provider, stripe } = buildProvider();
      mockEvent(stripe, {
        id: "evt_ref",
        account: "acct_123",
        created: 1700000000,
        type: "charge.refunded",
        data: {
          object: { id: "ch_1", payment_intent: "pi_1", amount_refunded: 1234, metadata: {} },
        },
      });
      const evt = provider.verifyEvent(Buffer.from(""), "sig") as NormalizedChargeRefundedEvent;
      expect(evt).toMatchObject({
        type: "charge.refunded",
        chargeId: "ch_1",
        paymentIntentId: "pi_1",
        amountRefundedDollars: 12.34,
      });
    });

    it("normalizes charge.dispute.created", () => {
      const { provider, stripe } = buildProvider();
      mockEvent(stripe, {
        id: "evt_disp",
        account: "acct_123",
        created: 1700000000,
        type: "charge.dispute.created",
        data: {
          object: {
            id: "dp_1",
            charge: "ch_1",
            payment_intent: "pi_1",
            amount: 1234,
            reason: "fraudulent",
            metadata: {},
          },
        },
      });
      const evt = provider.verifyEvent(Buffer.from(""), "sig") as NormalizedDisputeCreatedEvent;
      expect(evt).toMatchObject({
        type: "charge.dispute.created",
        chargeId: "ch_1",
        paymentIntentId: "pi_1",
        amountDollars: 12.34,
        reason: "fraudulent",
      });
    });

    it("normalizes account.application.deauthorized", () => {
      const { provider, stripe } = buildProvider();
      mockEvent(stripe, {
        id: "evt_deauth",
        account: "acct_123",
        created: 1700000000,
        type: "account.application.deauthorized",
        data: { object: { id: "ca_123" } },
      });
      const evt = provider.verifyEvent(Buffer.from(""), "sig") as NormalizedDeauthorizedEvent;
      expect(evt).toEqual({
        eventId: "evt_deauth",
        accountRef: "acct_123",
        created: new Date(1700000000 * 1000),
        type: "account.application.deauthorized",
      });
    });

    it("falls back to 'other' for an unrecognized event type instead of dropping it", () => {
      const { provider, stripe } = buildProvider();
      mockEvent(stripe, {
        id: "evt_unknown",
        account: "acct_123",
        created: 1700000000,
        type: "invoice.paid",
        data: { object: {} },
      });
      const evt = provider.verifyEvent(Buffer.from(""), "sig") as NormalizedOtherEvent;
      expect(evt).toEqual({
        eventId: "evt_unknown",
        accountRef: "acct_123",
        created: new Date(1700000000 * 1000),
        type: "other",
        rawType: "invoice.paid",
      });
    });

    it("propagates a bad-signature failure rather than swallowing it", () => {
      const { provider, stripe } = buildProvider();
      stripe.webhooks.constructEvent.mockImplementation(() => {
        throw new Error("No signatures found matching the expected signature for payload");
      });
      expect(() => provider.verifyEvent(Buffer.from("raw"), "bad-sig")).toThrow(/signature/i);
    });
  });
});
