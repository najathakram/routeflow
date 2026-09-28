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

// #2476: the ledger insert + claim are raw SQL; their claim tokens (processedAt, DB clock).
const T_INSERT = new Date("2026-09-28T05:00:00.000Z");
const T_CLAIM = new Date("2026-09-28T05:07:00.000Z");

const rawReq = { headers: { "stripe-signature": "sig_test" }, rawBody: Buffer.from("{}") } as any;

describe("ConnectWebhookController", () => {
  let controller: ConnectWebhookController;
  let prisma: ReturnType<typeof createMockPrisma>;
  let stripeConnectEvent: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  /** #2476: rows the raw redelivery claim returns — one row = this delivery claimed it. */
  let claimRows: jest.Mock;

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
      // #2476: the fenced outcome write — 1 = this delivery still held its claim.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    (prisma as any).stripeConnectEvent = stripeConnectEvent;
    // #2476: raw INSERT … ON CONFLICT DO NOTHING (modelled by `create`: a P2002 rejection = a
    // redelivery, no row), the raw claim UPDATE (claimRows) and the re-read SELECT (findUnique).
    claimRows = jest.fn().mockResolvedValue([{ processedAt: T_CLAIM }]);
    (prisma as any).$queryRaw = jest.fn(async (q: Prisma.Sql) => {
      const sql = q.sql.trim();
      if (/^INSERT/i.test(sql)) {
        try {
          await stripeConnectEvent.create();
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return [];
          throw e;
        }
        return [{ processedAt: T_INSERT }];
      }
      if (/^UPDATE/i.test(sql)) return claimRows();
      if (/^SELECT/i.test(sql)) {
        const row = await stripeConnectEvent.findUnique();
        return row ? [{ outcome: row.outcome }] : [];
      }
      return [];
    });

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

      const insert = ((prisma as any).$queryRaw.mock.calls as any[])
        .map((c) => c[0] as Prisma.Sql)
        .find((q) => q.sql.trim().startsWith("INSERT"));
      expect(insert?.sql).toMatch(/INSERT INTO "StripeConnectEvent"/);
      expect(insert?.values).toEqual(
        expect.arrayContaining([
          "evt_dup",
          "acct_1",
          "payment_intent.succeeded",
          piEvent.created.toISOString(),
        ]),
      );
      expect(payments.settleByPaymentIntent).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
      expect(stripeConnectEvent.updateMany).toHaveBeenCalledWith({
        where: { id: "evt_dup", outcome: null, processedAt: T_INSERT },
        data: { outcome: "settled" },
      });
    });

    it("makes a redelivery of an already-processed event a no-op", async () => {
      provider.verifyEvent.mockReturnValue(piEvent);
      stripeConnectEvent.create.mockRejectedValue(uniqueViolation());
      stripeConnectEvent.findUnique.mockResolvedValue({ id: "evt_dup", outcome: "settled" });
      claimRows.mockResolvedValue([]); // #2476: a completed row is never claimable
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

    // #2476 / SA-472: the same exclusive claim as the billing webhook.
    it("#2476: a redelivery claims the row with ONE raw UPDATE (error: now, NULL past the lease)", async () => {
      provider.verifyEvent.mockReturnValue(piEvent);
      stripeConnectEvent.create.mockRejectedValue(uniqueViolation());
      await controller.handle(rawReq, mockRes());
      const q = ((prisma as any).$queryRaw.mock.calls as any[])
        .map((c) => c[0] as Prisma.Sql)
        .find((x) => x.sql.trim().startsWith("UPDATE"));
      expect(q?.sql).toMatch(/UPDATE "StripeConnectEvent"/);
      expect(q?.sql).toMatch(/"outcome" LIKE 'error:%'/);
      expect(q?.sql).toMatch(/"outcome" IS NULL AND "processedAt" </);
      expect(q?.values).toEqual(["evt_dup", "300000 milliseconds"]);
    });

    it("#2476: not claimed and still in flight elsewhere ⇒ 503, never routed", async () => {
      provider.verifyEvent.mockReturnValue(piEvent);
      stripeConnectEvent.create.mockRejectedValue(uniqueViolation());
      claimRows.mockResolvedValue([]);
      stripeConnectEvent.findUnique.mockResolvedValue({ id: "evt_dup", outcome: null });
      const res = mockRes();
      await controller.handle(rawReq, res);
      expect(payments.settleByPaymentIntent).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(503);
    });

    it("#2476: an outcome-write failure is logged, never swallowed", async () => {
      provider.verifyEvent.mockReturnValue(piEvent);
      stripeConnectEvent.updateMany.mockRejectedValue(new Error("db blip"));
      const res = mockRes();
      await controller.handle(rawReq, res);
      expect(res.statusCode).toBe(200);
      const errs = (Logger.prototype.error as jest.Mock).mock.calls;
      expect(errs.some((c: any[]) => /outcome/i.test(String(c[0])))).toBe(true);
    });

    it("answers 500 so Stripe redelivers when routing throws", async () => {
      provider.verifyEvent.mockReturnValue(piEvent);
      payments.settleByPaymentIntent.mockRejectedValue(new Error("Invoice inv-1 is voided"));
      const res = mockRes();

      await controller.handle(rawReq, res);

      expect(res.statusCode).toBe(500);
      expect(stripeConnectEvent.updateMany).toHaveBeenCalledWith({
        where: { id: "evt_dup", outcome: null, processedAt: T_INSERT },
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
      expect(stripeConnectEvent.updateMany).toHaveBeenCalledWith({
        where: { id: "evt_dispute", outcome: null, processedAt: T_INSERT },
        data: { outcome: "notified" },
      });
    });

    it("records no_matching_tenant when the account belongs to nobody", async () => {
      provider.verifyEvent.mockReturnValue(disputeEvent);
      connect.tenantsForAccount.mockResolvedValue([]);
      const res = mockRes();

      await controller.handle(rawReq, res);

      expect(audit.log).not.toHaveBeenCalled();
      expect(stripeConnectEvent.updateMany).toHaveBeenCalledWith({
        where: { id: "evt_dispute", outcome: null, processedAt: T_INSERT },
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
    expect(stripeConnectEvent.updateMany).toHaveBeenCalledWith({
      where: { id: "evt_async_fail", outcome: null, processedAt: T_INSERT },
      data: { outcome: "failed" },
    });
  });

  // #2476 lead verdict "must" list (2026-09-28): the same DB-clock claim and fenced outcome write as the
  // billing webhook. Holds whether the insert stays a Prisma create or becomes raw SQL (SA's call).
  describe("#2476 DB-clock claim and fenced outcome write", () => {
    const T_INS = new Date("2026-09-28T06:00:00.000Z");
    const T_CLAIM = new Date("2026-09-28T06:10:00.000Z");

    function wire(opts: { redelivery?: boolean; claimed?: boolean; outcomeCount?: number } = {}) {
      provider.verifyEvent.mockReturnValue(piEvent);
      if (opts.redelivery) stripeConnectEvent.create.mockRejectedValue(uniqueViolation());
      else stripeConnectEvent.create.mockResolvedValue({ id: "evt_dup", processedAt: T_INS });
      stripeConnectEvent.findUnique.mockResolvedValue({ id: "evt_dup", outcome: null });
      stripeConnectEvent.updateMany.mockImplementation(async (arg: any) =>
        arg?.data && "processedAt" in arg.data
          ? { count: opts.claimed ? 1 : 0 }
          : { count: opts.outcomeCount ?? 1 },
      );
      const $queryRaw = jest.fn(async (q: Prisma.Sql) => {
        const s = q.sql.trim();
        if (/^INSERT/i.test(s)) return opts.redelivery ? [] : [{ processedAt: T_INS }];
        if (/^UPDATE/i.test(s)) return opts.claimed ? [{ processedAt: T_CLAIM }] : [];
        if (/^SELECT/i.test(s)) return [{ outcome: null }];
        return [];
      });
      (prisma as any).$queryRaw = $queryRaw;
      return $queryRaw;
    }

    it("the redelivery claim is ONE raw UPDATE on the DB clock — no app-clock Date is bound", async () => {
      const $queryRaw = wire({ redelivery: true, claimed: true });
      await controller.handle(rawReq, mockRes());
      const q = ($queryRaw.mock.calls as any[])
        .map((c) => c[0] as Prisma.Sql)
        .find((x) => /^\s*UPDATE/i.test(x.sql));
      expect(q).toBeDefined();
      expect(q!.sql).toMatch(/CURRENT_TIMESTAMP/);
      expect(q!.values.some((v) => v instanceof Date)).toBe(false);
    });

    it("the outcome write is fenced on this delivery's token (first delivery and claimed redelivery)", async () => {
      wire();
      await controller.handle(rawReq, mockRes());
      expect(stripeConnectEvent.update).not.toHaveBeenCalled();
      expect(stripeConnectEvent.updateMany).toHaveBeenCalledWith({
        where: { id: "evt_dup", outcome: null, processedAt: T_INS },
        data: { outcome: expect.any(String) },
      });

      jest.clearAllMocks();
      wire({ redelivery: true, claimed: true });
      await controller.handle(rawReq, mockRes());
      expect(stripeConnectEvent.updateMany).toHaveBeenCalledWith({
        where: { id: "evt_dup", outcome: null, processedAt: T_CLAIM },
        data: { outcome: expect.any(String) },
      });
    });

    it("a lost claim (the fenced write matches 0 rows) is logged", async () => {
      wire({ outcomeCount: 0 });
      const res = mockRes();
      await controller.handle(rawReq, res);
      expect(res.statusCode).toBe(200);
      const errs = (Logger.prototype.error as jest.Mock).mock.calls;
      expect(errs.some((c: any[]) => /claim/i.test(String(c[0])))).toBe(true);
    });
  });
});
