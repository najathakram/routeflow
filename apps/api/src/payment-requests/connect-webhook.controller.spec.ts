/**
 * Unit tests for ConnectWebhookController — the parts of WP2 that live in the
 * controller rather than in a service, so no other spec can reach them:
 *
 *  - the insert-first event ledger (invariant 3) and its duplicate/retry
 *    split: a delivery whose predecessor COMPLETED is a no-op, while one whose
 *    predecessor failed (or died before recording an outcome) is re-routed —
 *    the redelivery the controller's own 500 asked for must never be
 *    swallowed, or a charged card can be left with no InvoicePayment;
 *  - `charge.dispute.created` tenant attribution, which cannot come from
 *    metadata (a Dispute object carries none) and resolves by accountRef;
 *  - `checkout.session.async_payment_failed` routing, without which a failed
 *    bank debit holds the buyer's one open-request slot forever.
 *
 * Everything is mocked at the module boundary; the Stripe SDK is never
 * involved because the controller only ever speaks the normalized shapes from
 * the WP1 provider port. `stripeConnectEvent` predates createMockPrisma's
 * model list, so it is grafted on locally (same pattern as
 * stripe-connect.service.spec.ts).
 */

import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ConnectWebhookController } from "./connect-webhook.controller";
import { PaymentRequestsService } from "./payment-requests.service";
import { PAYMENT_PROVIDER } from "./provider/payment-provider.interface";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { StripeConnectService } from "../stripe-connect/stripe-connect.service";
import { createMockPrisma } from "../testing/prisma-mock";

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "7.0.0",
  });
}

/** Minimal express Response double — records status + payload. */
function mockRes() {
  const res: any = { statusCode: 0, body: null };
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

const rawReq = { headers: { "stripe-signature": "sig_test" }, rawBody: Buffer.from("{}") } as any;

describe("ConnectWebhookController", () => {
  let controller: ConnectWebhookController;
  let prisma: ReturnType<typeof createMockPrisma>;
  let stripeConnectEvent: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };

  const provider = { verifyEvent: jest.fn(), isConfigured: true };
  const payments = {
    settleByPaymentIntent: jest.fn(),
    expireBySession: jest.fn(),
    failBySession: jest.fn(),
  };
  const connect = {
    assertEventAccount: jest.fn(),
    applyAccountUpdate: jest.fn(),
    markDeauthorized: jest.fn(),
    tenantsForAccount: jest.fn(),
  };
  const audit = { log: jest.fn() };
  const gateway = { server: { to: jest.fn(() => ({ emit: jest.fn() })) } };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = createMockPrisma();
    stripeConnectEvent = {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    };
    (prisma as any).stripeConnectEvent = stripeConnectEvent;

    payments.settleByPaymentIntent.mockResolvedValue({ handled: true });
    payments.failBySession.mockResolvedValue({ handled: true });
    connect.tenantsForAccount.mockResolvedValue([]);
    audit.log.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ConnectWebhookController],
      providers: [
        { provide: PAYMENT_PROVIDER, useValue: provider },
        { provide: StripeConnectService, useValue: connect },
        { provide: PaymentRequestsService, useValue: payments },
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: RouteFlowGateway, useValue: gateway },
      ],
    }).compile();

    controller = module.get(ConnectWebhookController);
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
  });

  const piEvent = {
    type: "payment_intent.succeeded",
    eventId: "evt_dup",
    accountRef: "acct_1",
    created: new Date("2026-08-21T12:00:00Z"),
    paymentIntentId: "pi_1",
    amountDollars: 40,
    currency: "USD",
    methodKind: "card",
    metadata: { tenantId: "tenant-1", buyerPaymentRequestId: "req-1" },
  };

  describe("event ledger (invariant 3)", () => {
    it("processes the first delivery and ledgers its outcome", async () => {
      provider.verifyEvent.mockReturnValue(piEvent);
      const res = mockRes();

      await controller.handle(rawReq, res);

      expect(stripeConnectEvent.create).toHaveBeenCalledWith({
        data: {
          id: "evt_dup",
          accountRef: "acct_1",
          type: "payment_intent.succeeded",
          createdAt: piEvent.created,
        },
      });
      expect(payments.settleByPaymentIntent).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
      expect(stripeConnectEvent.update).toHaveBeenCalledWith({
        where: { id: "evt_dup" },
        data: { outcome: "settled" },
      });
    });

    it("makes a redelivery of an already-processed event a no-op", async () => {
      provider.verifyEvent.mockReturnValue(piEvent);
      stripeConnectEvent.create.mockRejectedValue(uniqueViolation());
      stripeConnectEvent.findUnique.mockResolvedValue({ id: "evt_dup", outcome: "settled" });
      const res = mockRes();

      await controller.handle(rawReq, res);

      expect(payments.settleByPaymentIntent).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ received: true });
    });

    it("re-routes a redelivery whose earlier attempt failed", async () => {
      // The controller answered 500 last time on purpose so Stripe would send
      // this again — discarding it as a duplicate would strand the SETTLING
      // row with a charged card and no InvoicePayment.
      provider.verifyEvent.mockReturnValue(piEvent);
      stripeConnectEvent.create.mockRejectedValue(uniqueViolation());
      stripeConnectEvent.findUnique.mockResolvedValue({
        id: "evt_dup",
        outcome: "error:Invoice inv-1 is voided",
      });
      const res = mockRes();

      await controller.handle(rawReq, res);

      expect(payments.settleByPaymentIntent).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
    });

    it("re-routes a redelivery whose earlier attempt recorded no outcome at all", async () => {
      provider.verifyEvent.mockReturnValue(piEvent);
      stripeConnectEvent.create.mockRejectedValue(uniqueViolation());
      stripeConnectEvent.findUnique.mockResolvedValue({ id: "evt_dup", outcome: null });
      const res = mockRes();

      await controller.handle(rawReq, res);

      expect(payments.settleByPaymentIntent).toHaveBeenCalledTimes(1);
    });

    it("answers 500 so Stripe redelivers when routing throws", async () => {
      provider.verifyEvent.mockReturnValue(piEvent);
      payments.settleByPaymentIntent.mockRejectedValue(new Error("Invoice inv-1 is voided"));
      const res = mockRes();

      await controller.handle(rawReq, res);

      expect(res.statusCode).toBe(500);
      expect(stripeConnectEvent.update).toHaveBeenCalledWith({
        where: { id: "evt_dup" },
        data: { outcome: "error:Invoice inv-1 is voided" },
      });
    });
  });

  describe("charge.dispute.created (invariant 11)", () => {
    const disputeEvent = {
      type: "charge.dispute.created",
      eventId: "evt_dispute",
      accountRef: "acct_1",
      created: new Date("2026-08-21T12:00:00Z"),
      chargeId: "ch_1",
      paymentIntentId: "pi_1",
      amountDollars: 40,
      reason: "fraudulent",
      // A Dispute object carries its own (empty) metadata — never the
      // PaymentIntent's.
      metadata: {},
    };

    it("attributes the dispute by accountRef when the event carries no metadata", async () => {
      provider.verifyEvent.mockReturnValue(disputeEvent);
      connect.tenantsForAccount.mockResolvedValue(["tenant-1"]);
      const res = mockRes();

      await controller.handle(rawReq, res);

      expect(connect.tenantsForAccount).toHaveBeenCalledWith("acct_1");
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-1", action: "stripe.charge.dispute.created" }),
      );
      expect(stripeConnectEvent.update).toHaveBeenCalledWith({
        where: { id: "evt_dispute" },
        data: { outcome: "notified" },
      });
    });

    it("records no_matching_tenant when the account belongs to nobody", async () => {
      provider.verifyEvent.mockReturnValue(disputeEvent);
      connect.tenantsForAccount.mockResolvedValue([]);
      const res = mockRes();

      await controller.handle(rawReq, res);

      expect(audit.log).not.toHaveBeenCalled();
      expect(stripeConnectEvent.update).toHaveBeenCalledWith({
        where: { id: "evt_dispute" },
        data: { outcome: "no_matching_tenant" },
      });
    });
  });

  it("routes checkout.session.async_payment_failed to failBySession", async () => {
    provider.verifyEvent.mockReturnValue({
      type: "checkout.session.async_payment_failed",
      eventId: "evt_async_fail",
      accountRef: "acct_1",
      created: new Date("2026-08-21T12:00:00Z"),
      sessionId: "cs_1",
      metadata: {},
    });
    const res = mockRes();

    await controller.handle(rawReq, res);

    expect(payments.failBySession).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(stripeConnectEvent.update).toHaveBeenCalledWith({
      where: { id: "evt_async_fail" },
      data: { outcome: "failed" },
    });
  });
});
