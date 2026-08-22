/**
 * Unit tests for PaymentRequestsService.
 *
 * Covers the oldest-first allocation math (ordering, capping, the partial
 * tail invoice, excess, exclusion of settled invoices); the PENDING ->
 * SETTLING -> SETTLED card settlement lifecycle including the mandatory
 * crash-path guarantee (recordStandalonePayment called exactly once across a
 * redelivery that lands after the money was written but before the final
 * flip — invariant 7); the amount-truth rule and ACH/CREDIT_CARD +
 * settledAt mapping (invariant 9); the anti-spoof account check (invariant
 * 2); checkout.session.expired handling (invariant 10); cancelOwn's
 * money-free cancel-after-charge guard (invariants 5/6); the approve()/
 * reject() tenant-scoping guards; the open-request unique-violation catch
 * (invariant 8); and fromInvoiceId / status-query validation.
 *
 * All collaborators are mocked at the module boundary via the standard
 * createMockPrisma() helper, plus stub InvoicesService / StripeConnectService
 * / the PAYMENT_PROVIDER port / TenantContextService / RouteFlowGateway.
 * createMockPrisma predates BuyerPaymentRequest, so — mirroring the
 * graftInvoiceScan pattern used elsewhere in this codebase (see
 * vendor-bills.service.spec.ts) — the model is grafted onto both the
 * top-level mock and the object forTenant() hands back, so a direct call and
 * a tenant-scoped call see the same jest mocks.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { PaymentRequestsService } from "./payment-requests.service";
import { PAYMENT_PROVIDER } from "./provider/payment-provider.interface";
import { ListPaymentRequestsDto } from "./payment-requests.controller";
import { PrismaService } from "../prisma/prisma.service";
import { InvoicesService } from "../invoices/invoices.service";
import { StripeConnectService } from "../stripe-connect/stripe-connect.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";

function graftBuyerPaymentRequest(prisma: ReturnType<typeof createMockPrisma>) {
  const model = {
    findUnique: jest.fn().mockResolvedValue(null),
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
  (prisma as any).buyerPaymentRequest = model;
  (prisma.forTenant() as any).buyerPaymentRequest = model;
  return model;
}

/** A minimal open-invoice row shaped the way openInvoices() expects it. */
function invoiceRow(opts: {
  id: string;
  invoiceNumber: string;
  issueDate: Date;
  total: number;
  paid?: number;
}) {
  return {
    id: opts.id,
    invoiceNumber: opts.invoiceNumber,
    issueDate: opts.issueDate,
    total: opts.total,
    payments: opts.paid ? [{ amount: opts.paid, status: "PAID" }] : [],
  };
}

/** A normalized payment_intent.succeeded event, shaped per the WP1 port. */
function piSucceededEvent(overrides: Record<string, any> = {}) {
  return {
    type: "payment_intent.succeeded",
    eventId: "evt_1",
    accountRef: "acct_1",
    created: new Date("2026-08-21T12:00:00Z"),
    paymentIntentId: "pi_123",
    amountDollars: 40,
    currency: "usd",
    methodKind: "card",
    metadata: { tenantId: "tenant-1", buyerPaymentRequestId: "req-1" },
    ...overrides,
  };
}

/** A normalized checkout.session.expired event. */
function sessionExpiredEvent(overrides: Record<string, any> = {}) {
  return {
    type: "checkout.session.expired",
    eventId: "evt_2",
    accountRef: "acct_1",
    created: new Date("2026-08-21T12:00:00Z"),
    sessionId: "cs_test_1",
    metadata: { tenantId: "tenant-1", buyerPaymentRequestId: "req-1" },
    ...overrides,
  };
}

describe("PaymentRequestsService", () => {
  let service: PaymentRequestsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let buyerPaymentRequest: ReturnType<typeof graftBuyerPaymentRequest>;

  const mockInvoices = {
    recordStandalonePayment: jest.fn(),
  };
  const mockConnect = {
    chargeableAccount: jest.fn(),
    getStatus: jest.fn(),
    lastKnownAccount: jest.fn(),
    assertEventAccount: jest.fn(),
  };
  const mockProvider = {
    createHostedCheckout: jest.fn(),
    readCheckout: jest.fn(),
    expireCheckout: jest.fn(),
    verifyEvent: jest.fn(),
  };
  const mockTenantContext = {
    get: jest.fn(),
    getOrNull: jest.fn(),
    run: jest.fn(),
    isSuperAdmin: jest.fn(),
  };
  const mockGateway = {
    emitBuyerPaymentRequest: jest.fn(),
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    buyerPaymentRequest = graftBuyerPaymentRequest(prisma);

    mockInvoices.recordStandalonePayment.mockReset();
    mockConnect.chargeableAccount.mockReset();
    mockConnect.getStatus.mockReset();
    mockConnect.lastKnownAccount.mockReset();
    mockConnect.assertEventAccount.mockReset().mockResolvedValue(true);
    mockProvider.createHostedCheckout.mockReset();
    mockProvider.readCheckout.mockReset();
    mockProvider.expireCheckout.mockReset();
    mockProvider.verifyEvent.mockReset();
    mockGateway.emitBuyerPaymentRequest.mockReset();
    mockTenantContext.get.mockReset().mockReturnValue("tenant-1");
    mockTenantContext.getOrNull.mockReset().mockReturnValue("tenant-1");
    mockTenantContext.run
      .mockReset()
      .mockImplementation((_tenantId: string, fn: () => any) => fn());
    mockTenantContext.isSuperAdmin.mockReset().mockReturnValue(false);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentRequestsService,
        { provide: PrismaService, useValue: prisma },
        { provide: InvoicesService, useValue: mockInvoices },
        { provide: StripeConnectService, useValue: mockConnect },
        { provide: PAYMENT_PROVIDER, useValue: mockProvider },
        { provide: TenantContextService, useValue: mockTenantContext },
        { provide: RouteFlowGateway, useValue: mockGateway },
      ],
    }).compile();

    service = module.get<PaymentRequestsService>(PaymentRequestsService);
  });

  // ─── buildOldestFirstAllocation ─────────────────────────────────────────────

  describe("buildOldestFirstAllocation", () => {
    it("orders oldest-first, caps each invoice at its balance due, and partially covers the last invoice reached", async () => {
      const older = invoiceRow({
        id: "inv-old",
        invoiceNumber: "INV-0001",
        issueDate: new Date("2026-01-01"),
        total: 50,
      });
      const middle = invoiceRow({
        id: "inv-mid",
        invoiceNumber: "INV-0002",
        issueDate: new Date("2026-01-05"),
        total: 30,
      });
      const partial = invoiceRow({
        id: "inv-new",
        invoiceNumber: "INV-0003",
        issueDate: new Date("2026-01-10"),
        total: 40,
      });
      const untouched = invoiceRow({
        id: "inv-untouched",
        invoiceNumber: "INV-0004",
        issueDate: new Date("2026-01-15"),
        total: 20,
      });
      prisma.invoice.findMany.mockResolvedValue([older, middle, partial, untouched]);

      const result = await service.buildOldestFirstAllocation("cust-1", 100);

      expect(prisma.invoice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ customerId: "cust-1" }),
          orderBy: [{ issueDate: "asc" }, { invoiceNumber: "asc" }],
        }),
      );

      // Applied in the order the (mocked, already oldest-first) query returned them.
      expect(result.lines.map((l) => ({ invoiceId: l.invoiceId, applied: l.applied }))).toEqual([
        { invoiceId: "inv-old", applied: 50 },
        { invoiceId: "inv-mid", applied: 30 },
        { invoiceId: "inv-new", applied: 20 },
        { invoiceId: "inv-untouched", applied: 0 },
      ]);
      expect(result.allocations).toEqual([
        { invoiceId: "inv-old", amount: 50 },
        { invoiceId: "inv-mid", amount: 30 },
        { invoiceId: "inv-new", amount: 20 },
      ]);
      expect(result.excess).toBe(0);

      // The last invoice the amount reached is only partially covered, and the
      // allocation stops there — the invoice after it is untouched.
      const lastReached = result.lines.find((l) => l.invoiceId === "inv-new")!;
      expect(lastReached.applied).toBeLessThan(lastReached.balanceDue);
      const neverReached = result.lines.find((l) => l.invoiceId === "inv-untouched")!;
      expect(neverReached.applied).toBe(0);
    });

    it("returns excess equal to the remainder and allocates every open invoice in full when the amount exceeds the balance", async () => {
      const a = invoiceRow({
        id: "inv-a",
        invoiceNumber: "INV-0001",
        issueDate: new Date("2026-01-01"),
        total: 50,
      });
      const b = invoiceRow({
        id: "inv-b",
        invoiceNumber: "INV-0002",
        issueDate: new Date("2026-01-02"),
        total: 30,
      });
      prisma.invoice.findMany.mockResolvedValue([a, b]);

      const result = await service.buildOldestFirstAllocation("cust-1", 100);

      expect(result.allocations).toEqual([
        { invoiceId: "inv-a", amount: 50 },
        { invoiceId: "inv-b", amount: 30 },
      ]);
      expect(result.lines.every((l) => l.applied === l.balanceDue)).toBe(true);
      expect(result.excess).toBe(20);
    });

    it("excludes invoices with no balance left from the allocation", async () => {
      const settled = invoiceRow({
        id: "inv-settled",
        invoiceNumber: "INV-0001",
        issueDate: new Date("2026-01-01"),
        total: 100,
        paid: 100,
      });
      const open = invoiceRow({
        id: "inv-open",
        invoiceNumber: "INV-0002",
        issueDate: new Date("2026-01-02"),
        total: 40,
      });
      prisma.invoice.findMany.mockResolvedValue([settled, open]);

      const result = await service.buildOldestFirstAllocation("cust-1", 40);

      expect(result.lines.map((l) => l.invoiceId)).toEqual(["inv-open"]);
      expect(result.allocations).toEqual([{ invoiceId: "inv-open", amount: 40 }]);
      expect(result.excess).toBe(0);
    });
  });

  // ─── paymentContext (invariant 13) ──────────────────────────────────────────

  describe("paymentContext", () => {
    it("surfaces the most recent EXPIRED request when nothing is open, so the panel can offer 'start again'", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      mockConnect.chargeableAccount.mockResolvedValue("acct_1");
      buyerPaymentRequest.findMany.mockResolvedValue([]); // nothing PENDING/SETTLING
      buyerPaymentRequest.findFirst.mockResolvedValue({
        id: "req-expired",
        kind: "CARD",
        status: "EXPIRED",
        amount: 40,
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - 60 * 60 * 1000), // expired an hour ago
      });

      const context = await service.paymentContext("tenant-1", "cust-1");

      expect(context.pendingRequests).toHaveLength(1);
      expect(context.pendingRequests[0]).toMatchObject({ id: "req-expired", status: "EXPIRED" });
    });

    it("withholds an EXPIRED request that lapsed long ago, so a months-old abandoned Checkout stops hiding the amount form", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      mockConnect.chargeableAccount.mockResolvedValue("acct_1");
      buyerPaymentRequest.findMany.mockResolvedValue([]);
      buyerPaymentRequest.findFirst.mockResolvedValue({
        id: "req-expired-old",
        kind: "CARD",
        status: "EXPIRED",
        amount: 40,
        createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - 39 * 24 * 60 * 60 * 1000),
      });

      const context = await service.paymentContext("tenant-1", "cust-1");

      expect(context.pendingRequests).toHaveLength(0);
    });

    it("does not surface an EXPIRED request once something newer happened", async () => {
      prisma.invoice.findMany.mockResolvedValue([]);
      mockConnect.chargeableAccount.mockResolvedValue("acct_1");
      buyerPaymentRequest.findMany.mockResolvedValue([]);
      buyerPaymentRequest.findFirst.mockResolvedValue({
        id: "req-settled",
        kind: "CARD",
        status: "SETTLED",
        amount: 40,
        createdAt: new Date("2026-08-21"),
      });

      const context = await service.paymentContext("tenant-1", "cust-1");

      expect(context.pendingRequests).toHaveLength(0);
    });
  });

  // ─── settleByPaymentIntent (invariants 1, 2, 5, 7, 9) ───────────────────────

  describe("settleByPaymentIntent", () => {
    const baseRequest = {
      id: "req-1",
      tenantId: "tenant-1",
      customerId: "cust-1",
      amount: 40,
      stripeSessionId: "cs_test_123",
    };

    it("records money exactly once across a crash-path redelivery (record succeeds, the final flip never lands, then Stripe redelivers)", async () => {
      const evt = piSucceededEvent();
      // First delivery: the row is still PENDING.
      buyerPaymentRequest.findFirst
        .mockResolvedValueOnce({ ...baseRequest, status: "PENDING" })
        // Second delivery (redelivery after the crash): still SETTLING.
        .mockResolvedValueOnce({ ...baseRequest, status: "SETTLING" });
      buyerPaymentRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.invoice.findMany.mockResolvedValue([
        invoiceRow({
          id: "inv-1",
          invoiceNumber: "INV-0001",
          issueDate: new Date("2026-01-01"),
          total: 40,
        }),
      ]);
      mockInvoices.recordStandalonePayment.mockResolvedValue({ paymentGroupId: "pg-1", excess: 0 });
      // The redelivery finds the money already on the ledger and completes the flip.
      prisma.invoicePayment.findFirst.mockResolvedValue({ paymentGroupId: "pg-1" });

      const first = await service.settleByPaymentIntent(evt as any);
      const second = await service.settleByPaymentIntent(evt as any);

      expect(first).toEqual({ handled: true });
      expect(second).toEqual({ handled: true });
      expect(mockInvoices.recordStandalonePayment).toHaveBeenCalledTimes(1);
      expect(prisma.invoicePayment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { reference: "pi_123" } }),
      );
    });

    it("records the money anyway, with a CRITICAL log, when the payment intent succeeds for a request that was already CANCELLED", async () => {
      const errorSpy = jest
        .spyOn((service as any).logger, "error")
        .mockImplementation(() => undefined);
      const evt = piSucceededEvent();
      buyerPaymentRequest.findFirst.mockResolvedValue({ ...baseRequest, status: "CANCELLED" });
      buyerPaymentRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.invoice.findMany.mockResolvedValue([
        invoiceRow({
          id: "inv-1",
          invoiceNumber: "INV-0001",
          issueDate: new Date("2026-01-01"),
          total: 40,
        }),
      ]);
      mockInvoices.recordStandalonePayment.mockResolvedValue({ paymentGroupId: "pg-1", excess: 0 });

      const result = await service.settleByPaymentIntent(evt as any);

      expect(result).toEqual({ handled: true });
      expect(mockInvoices.recordStandalonePayment).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("payment arrived for non-pending request"),
      );
      expect(buyerPaymentRequest.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { id: "req-1", status: "SETTLING" },
          data: expect.objectContaining({
            status: "SETTLED",
            outcome: expect.stringContaining("CANCELLED"),
          }),
        }),
      );
    });

    it("still records the money when claiming a CANCELLED row into SETTLING collides with the buyer's replacement request", async () => {
      // The partial unique index covers PENDING/SETTLING only, so the buyer is
      // free to open a replacement request after the cancel — pulling the old
      // row back into SETTLING then raises P2002. A 500 here would strand a
      // real charge with no InvoicePayment behind it (invariant 7).
      jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
      buyerPaymentRequest.findFirst.mockResolvedValue({ ...baseRequest, status: "CANCELLED" });
      buyerPaymentRequest.updateMany.mockResolvedValue({ count: 1 }).mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "7.8.0",
        }),
      );
      prisma.invoice.findMany.mockResolvedValue([
        invoiceRow({
          id: "inv-1",
          invoiceNumber: "INV-0001",
          issueDate: new Date("2026-01-01"),
          total: 40,
        }),
      ]);
      mockInvoices.recordStandalonePayment.mockResolvedValue({ paymentGroupId: "pg-1", excess: 0 });

      const result = await service.settleByPaymentIntent(piSucceededEvent() as any);

      expect(result).toEqual({ handled: true });
      expect(mockInvoices.recordStandalonePayment).toHaveBeenCalledTimes(1);
      // The row never occupies the open-request slot: it flips straight out of
      // CANCELLED into SETTLED, carrying the anomaly note.
      expect(buyerPaymentRequest.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { id: "req-1", status: "CANCELLED" },
          data: expect.objectContaining({
            status: "SETTLED",
            outcome: expect.stringContaining("CANCELLED"),
          }),
        }),
      );
    });

    it("never re-records when a redelivery lands on a terminal row whose money is already on the ledger", async () => {
      // The in-place settle writes money while the row stays CANCELLED — it
      // never occupies SETTLING, so nothing on the row marks the money as in
      // flight. If the first delivery died after recording but before the flip,
      // by the time Stripe redelivers the buyer's replacement request may have
      // freed the open-request slot, so the claim would now SUCCEED and record a
      // second payment for the same PI. The ledger probe runs before the claim
      // precisely to stop that.
      jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
      buyerPaymentRequest.findFirst.mockResolvedValue({ ...baseRequest, status: "CANCELLED" });
      buyerPaymentRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.invoicePayment.findFirst.mockResolvedValue({ paymentGroupId: "pg-1" });

      const result = await service.settleByPaymentIntent(piSucceededEvent() as any);

      expect(result).toEqual({ handled: true });
      expect(mockInvoices.recordStandalonePayment).not.toHaveBeenCalled();
      expect(buyerPaymentRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "req-1", status: "CANCELLED" },
          data: expect.objectContaining({
            status: "SETTLED",
            paymentGroupId: "pg-1",
            outcome: expect.stringContaining("CANCELLED"),
          }),
        }),
      );
    });

    it("treats an AdvancePayment-only settlement as already recorded on redelivery", async () => {
      // recordStandalonePayment writes zero InvoicePayment rows when nothing is
      // left to allocate against — the whole amount becomes on-account credit.
      // An InvoicePayment-only probe would re-record and mint a duplicate.
      buyerPaymentRequest.findFirst.mockResolvedValue({ ...baseRequest, status: "SETTLING" });
      buyerPaymentRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.invoicePayment.findFirst.mockResolvedValue(null);
      prisma.advancePayment.findFirst.mockResolvedValue({ id: "adv-1" });

      const result = await service.settleByPaymentIntent(piSucceededEvent() as any);

      expect(result).toEqual({ handled: true });
      expect(mockInvoices.recordStandalonePayment).not.toHaveBeenCalled();
      expect(prisma.advancePayment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { reference: "pi_123" } }),
      );
      expect(buyerPaymentRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "req-1", status: "SETTLING" },
          data: expect.objectContaining({ status: "SETTLED" }),
        }),
      );
    });

    it("records the provider-reported amount, not the request's amount, on an amount mismatch", async () => {
      const errorSpy = jest
        .spyOn((service as any).logger, "error")
        .mockImplementation(() => undefined);
      const evt = piSucceededEvent({ amountDollars: 45 });
      buyerPaymentRequest.findFirst.mockResolvedValue({
        ...baseRequest,
        amount: 40,
        status: "PENDING",
      });
      buyerPaymentRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.invoice.findMany.mockResolvedValue([
        invoiceRow({
          id: "inv-1",
          invoiceNumber: "INV-0001",
          issueDate: new Date("2026-01-01"),
          total: 100,
        }),
      ]);
      mockInvoices.recordStandalonePayment.mockResolvedValue({ paymentGroupId: "pg-1", excess: 0 });

      await service.settleByPaymentIntent(evt as any);

      expect(mockInvoices.recordStandalonePayment).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmount: 45 }),
        { assertAllocationsWithinBalance: true },
      );
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("amount mismatch"));
    });

    it("maps a us_bank_account payment to ACH with settledAt at the event's time", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue({ ...baseRequest, status: "PENDING" });
      buyerPaymentRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.invoice.findMany.mockResolvedValue([
        invoiceRow({
          id: "inv-1",
          invoiceNumber: "INV-0001",
          issueDate: new Date("2026-01-01"),
          total: 40,
        }),
      ]);
      mockInvoices.recordStandalonePayment.mockResolvedValue({ paymentGroupId: "pg-1", excess: 0 });

      const achEvent = piSucceededEvent({ methodKind: "us_bank_account" });
      await service.settleByPaymentIntent(achEvent as any);

      expect(mockInvoices.recordStandalonePayment).toHaveBeenLastCalledWith(
        expect.objectContaining({ method: "ACH", settledAt: "2026-08-21T12:00:00.000Z" }),
        { assertAllocationsWithinBalance: true },
      );
    });

    it("maps a card payment to CREDIT_CARD with settledAt null (cash-basis falls back to paidAt)", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue({ ...baseRequest, status: "PENDING" });
      buyerPaymentRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.invoice.findMany.mockResolvedValue([
        invoiceRow({
          id: "inv-1",
          invoiceNumber: "INV-0001",
          issueDate: new Date("2026-01-01"),
          total: 40,
        }),
      ]);
      mockInvoices.recordStandalonePayment.mockResolvedValue({ paymentGroupId: "pg-1", excess: 0 });

      const cardEvent = piSucceededEvent({ methodKind: "card" });
      await service.settleByPaymentIntent(cardEvent as any);

      expect(mockInvoices.recordStandalonePayment).toHaveBeenLastCalledWith(
        expect.objectContaining({ method: "CREDIT_CARD", settledAt: null }),
        { assertAllocationsWithinBalance: true },
      );
    });

    it("refuses to write anything when the event's account does not match the tenant's connected account", async () => {
      mockConnect.assertEventAccount.mockResolvedValue(false);

      const result = await service.settleByPaymentIntent(piSucceededEvent() as any);

      expect(result).toEqual({ handled: false });
      expect(buyerPaymentRequest.findFirst).not.toHaveBeenCalled();
      expect(mockInvoices.recordStandalonePayment).not.toHaveBeenCalled();
    });

    it("is a no-op replay once the request is already SETTLED", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue({ ...baseRequest, status: "SETTLED" });

      const result = await service.settleByPaymentIntent(piSucceededEvent() as any);

      expect(result).toEqual({ handled: true });
      expect(buyerPaymentRequest.updateMany).not.toHaveBeenCalled();
      expect(mockInvoices.recordStandalonePayment).not.toHaveBeenCalled();
    });

    it("does nothing when the event metadata is missing tenantId/buyerPaymentRequestId", async () => {
      const result = await service.settleByPaymentIntent(piSucceededEvent({ metadata: {} }) as any);

      expect(result).toEqual({ handled: false });
      expect(mockConnect.assertEventAccount).not.toHaveBeenCalled();
      expect(mockInvoices.recordStandalonePayment).not.toHaveBeenCalled();
    });
  });

  // ─── expireBySession (invariant 10) ─────────────────────────────────────────

  describe("expireBySession", () => {
    it("flips a PENDING request to EXPIRED", async () => {
      buyerPaymentRequest.findUnique.mockResolvedValue({
        id: "req-1",
        tenantId: "tenant-1",
        status: "PENDING",
      });
      buyerPaymentRequest.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.expireBySession(sessionExpiredEvent() as any);

      expect(result).toEqual({ handled: true });
      expect(buyerPaymentRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "req-1", status: "PENDING" },
          data: { status: "EXPIRED" },
        }),
      );
    });

    it("writes nothing on an account mismatch", async () => {
      buyerPaymentRequest.findUnique.mockResolvedValue({
        id: "req-1",
        tenantId: "tenant-1",
        status: "PENDING",
      });
      mockConnect.assertEventAccount.mockResolvedValue(false);

      const result = await service.expireBySession(sessionExpiredEvent() as any);

      expect(result).toEqual({ handled: false });
      expect(buyerPaymentRequest.updateMany).not.toHaveBeenCalled();
    });

    it("ignores an expired session with no matching request", async () => {
      buyerPaymentRequest.findUnique.mockResolvedValue(null);

      const result = await service.expireBySession(sessionExpiredEvent() as any);

      expect(result).toEqual({ handled: false });
    });
  });

  // ─── approve() / reject() guards ─────────────────────────────────────────────

  describe("approve", () => {
    const decidedBy = { id: "user-1", username: "operator" };

    it("refuses a CARD request — cash-only path", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue({
        id: "req-card",
        tenantId: "tenant-1",
        customerId: "cust-1",
        kind: "CARD",
        status: "PENDING",
        amount: 40,
      });

      await expect(service.approve("req-card", decidedBy)).rejects.toThrow(BadRequestException);
      await expect(service.approve("req-card", decidedBy)).rejects.toThrow(
        "Card payments settle from Stripe automatically.",
      );
      expect(buyerPaymentRequest.updateMany).not.toHaveBeenCalled();
      expect(mockInvoices.recordStandalonePayment).not.toHaveBeenCalled();
    });

    it("refuses a request that has already been decided", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue({
        id: "req-cash",
        tenantId: "tenant-1",
        customerId: "cust-1",
        kind: "CASH",
        status: "APPROVED",
        amount: 40,
      });
      buyerPaymentRequest.updateMany.mockResolvedValue({ count: 0 }); // already claimed

      await expect(service.approve("req-cash", decidedBy)).rejects.toThrow(BadRequestException);
      await expect(service.approve("req-cash", decidedBy)).rejects.toThrow(
        "Request already decided",
      );
      expect(mockInvoices.recordStandalonePayment).not.toHaveBeenCalled();
    });

    it("scopes its claim to the current tenant (a cross-tenant id can never win the claim)", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue({
        id: "req-cash",
        tenantId: "tenant-1",
        customerId: "cust-1",
        kind: "CASH",
        status: "PENDING",
        amount: 40,
      });
      buyerPaymentRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.invoice.findMany.mockResolvedValue([]);
      mockInvoices.recordStandalonePayment.mockResolvedValue({ paymentGroupId: "pg-1", excess: 0 });

      await service.approve("req-cash", decidedBy);

      expect(buyerPaymentRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "req-cash", tenantId: "tenant-1", status: "PENDING" },
        }),
      );
    });
  });

  // ─── cancelOwn (invariants 5, 6) ─────────────────────────────────────────────
  //
  // cancelOwn must never write money — settlement is reachable exclusively
  // from settleByPaymentIntent. These pin the money-free cancel-after-charge
  // guard: expireCheckout is always attempted, and its 3-way outcome decides
  // whether the cancel proceeds or is refused.

  describe("cancelOwn", () => {
    const cardRequest = {
      id: "req-card",
      tenantId: "tenant-1",
      customerId: "cust-1",
      buyerAccountId: "buyer-1",
      kind: "CARD",
      status: "PENDING",
      amount: 100,
      stripeSessionId: "cs_test_1",
    };

    it("refuses to cancel — and records nothing — when the provider reports the session already completed", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue(cardRequest);
      mockConnect.lastKnownAccount.mockResolvedValue("acct_1");
      mockProvider.expireCheckout.mockResolvedValue({ outcome: "already_completed" });

      await expect(service.cancelOwn("buyer-1", "cust-1", "req-card")).rejects.toThrow(
        "already went through",
      );
      expect(mockInvoices.recordStandalonePayment).not.toHaveBeenCalled();
      expect(buyerPaymentRequest.updateMany).not.toHaveBeenCalled();
    });

    it("cancels once the provider confirms the session expired", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue(cardRequest);
      buyerPaymentRequest.updateMany.mockResolvedValue({ count: 1 });
      mockConnect.lastKnownAccount.mockResolvedValue("acct_1");
      mockProvider.expireCheckout.mockResolvedValue({ outcome: "expired" });

      await expect(service.cancelOwn("buyer-1", "cust-1", "req-card")).resolves.toEqual({
        cancelled: true,
      });
      expect(mockProvider.expireCheckout).toHaveBeenCalledWith("acct_1", "cs_test_1");
      expect(mockInvoices.recordStandalonePayment).not.toHaveBeenCalled();
    });

    it("cancels an already-expired session the same way", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue(cardRequest);
      buyerPaymentRequest.updateMany.mockResolvedValue({ count: 1 });
      mockConnect.lastKnownAccount.mockResolvedValue("acct_1");
      mockProvider.expireCheckout.mockResolvedValue({ outcome: "already_expired" });

      await expect(service.cancelOwn("buyer-1", "cust-1", "req-card")).resolves.toEqual({
        cancelled: true,
      });
    });

    it("still expires the session when the seller has since disconnected Stripe, instead of locking the buyer out", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue(cardRequest);
      buyerPaymentRequest.updateMany.mockResolvedValue({ count: 1 });
      // getStatus/chargeableAccount both report null once disconnectedAt is
      // set; lastKnownAccount is what keeps the session reachable.
      mockConnect.getStatus.mockResolvedValue({ stripeAccountId: null, chargesEnabled: false });
      mockConnect.lastKnownAccount.mockResolvedValue("acct_1");
      mockProvider.expireCheckout.mockResolvedValue({ outcome: "expired" });

      await expect(service.cancelOwn("buyer-1", "cust-1", "req-card")).resolves.toEqual({
        cancelled: true,
      });
      expect(mockProvider.expireCheckout).toHaveBeenCalledWith("acct_1", "cs_test_1");
    });

    it("refuses to cancel when no account id was ever stored for the seller", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue(cardRequest);
      mockConnect.lastKnownAccount.mockResolvedValue(null);

      await expect(service.cancelOwn("buyer-1", "cust-1", "req-card")).rejects.toThrow(
        BadRequestException,
      );
      expect(mockProvider.expireCheckout).not.toHaveBeenCalled();
      expect(buyerPaymentRequest.updateMany).not.toHaveBeenCalled();
    });

    it("refuses to cancel when the provider call fails", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue(cardRequest);
      mockConnect.lastKnownAccount.mockResolvedValue("acct_1");
      mockProvider.expireCheckout.mockRejectedValue(new Error("network"));

      await expect(service.cancelOwn("buyer-1", "cust-1", "req-card")).rejects.toThrow(
        BadRequestException,
      );
      expect(buyerPaymentRequest.updateMany).not.toHaveBeenCalled();
    });

    it("cancels a cash request without touching the provider", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue({
        ...cardRequest,
        id: "req-cash",
        kind: "CASH",
        stripeSessionId: null,
      });
      buyerPaymentRequest.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.cancelOwn("buyer-1", "cust-1", "req-cash")).resolves.toEqual({
        cancelled: true,
      });
      expect(mockConnect.lastKnownAccount).not.toHaveBeenCalled();
      expect(mockProvider.expireCheckout).not.toHaveBeenCalled();
    });
  });

  // ─── open-request unique-violation catch (invariant 8) ──────────────────────

  describe("open-request race (P2002 on create)", () => {
    it("createCashRequest turns a unique-violation race into a friendly BadRequest", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue(null); // pre-check sees no open request
      prisma.customer.findFirst.mockResolvedValue({ businessName: "Acme Retail" });
      buyerPaymentRequest.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "7.8.0",
        }),
      );

      await expect(
        service.createCashRequest({
          tenantId: "tenant-1",
          customerId: "cust-1",
          buyerAccountId: "buyer-1",
          amount: 10,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockGateway.emitBuyerPaymentRequest).not.toHaveBeenCalled();
    });

    it("createCardRequest turns a unique-violation race into a friendly BadRequest", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue(null);
      mockConnect.chargeableAccount.mockResolvedValue("acct_1");
      prisma.invoice.findMany.mockResolvedValue([
        invoiceRow({
          id: "inv-1",
          invoiceNumber: "INV-0001",
          issueDate: new Date("2026-01-01"),
          total: 40,
        }),
      ]);
      prisma.customer.findFirst.mockResolvedValue({ businessName: "Acme Retail", email: null });
      buyerPaymentRequest.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "7.8.0",
        }),
      );

      await expect(
        service.createCardRequest({
          tenantId: "tenant-1",
          tenantSlug: "acme",
          customerId: "cust-1",
          buyerAccountId: "buyer-1",
          amount: 10,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockProvider.createHostedCheckout).not.toHaveBeenCalled();
    });
  });

  // ─── fromInvoiceId validation ─────────────────────────────────────────────────

  describe("fromInvoiceId validation", () => {
    it("createCashRequest rejects a fromInvoiceId that does not belong to the customer", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue(null);
      prisma.invoice.findFirst.mockResolvedValue(null); // not found for this customer

      await expect(
        service.createCashRequest({
          tenantId: "tenant-1",
          customerId: "cust-1",
          buyerAccountId: "buyer-1",
          amount: 10,
          fromInvoiceId: "inv-other-customer",
        }),
      ).rejects.toThrow(BadRequestException);
      expect(buyerPaymentRequest.create).not.toHaveBeenCalled();
    });

    it("createCashRequest accepts a fromInvoiceId that does belong to the customer", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue(null);
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1" });
      prisma.customer.findFirst.mockResolvedValue({ businessName: "Acme Retail" });
      buyerPaymentRequest.create.mockResolvedValue({
        id: "req-1",
        kind: "CASH",
        status: "PENDING",
        amount: 10,
        createdAt: new Date(),
      });

      await expect(
        service.createCashRequest({
          tenantId: "tenant-1",
          customerId: "cust-1",
          buyerAccountId: "buyer-1",
          amount: 10,
          fromInvoiceId: "inv-1",
        }),
      ).resolves.toMatchObject({ id: "req-1" });
    });
  });

  // ─── status query DTO validation ─────────────────────────────────────────────

  describe("ListPaymentRequestsDto (controller status-query validation)", () => {
    it("rejects a status value outside the enum", async () => {
      const dto = plainToInstance(ListPaymentRequestsDto, { status: "NOT_A_REAL_STATUS" });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    });

    it("accepts a real status value, and accepts an absent one", async () => {
      expect(
        await validate(plainToInstance(ListPaymentRequestsDto, { status: "PENDING" })),
      ).toHaveLength(0);
      expect(await validate(plainToInstance(ListPaymentRequestsDto, {}))).toHaveLength(0);
    });
  });
});
