/**
 * Unit tests for PaymentRequestsService.
 *
 * Covers the oldest-first allocation math (ordering, capping, the partial
 * tail invoice, excess, exclusion of settled invoices), webhook idempotency
 * (settleCardBySession must write money exactly once even when Stripe
 * redelivers the same checkout.session.completed event and is a no-op for a
 * session that hasn't paid), and the approve() guards (cash-only path,
 * single-decision claim).
 *
 * All collaborators are mocked at the module boundary via the standard
 * createMockPrisma() helper, plus stub InvoicesService / StripeConnectService
 * / StripeService / TenantContextService / RouteFlowGateway. createMockPrisma
 * predates BuyerPaymentRequest, so — mirroring the graftInvoiceScan pattern
 * used elsewhere in this codebase (see vendor-bills.service.spec.ts) — the
 * model is grafted onto both the top-level mock and the object forTenant()
 * hands back, so a direct call and a tenant-scoped call see the same jest
 * mocks.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { PaymentRequestsService } from "./payment-requests.service";
import { PrismaService } from "../prisma/prisma.service";
import { InvoicesService } from "../invoices/invoices.service";
import { StripeConnectService } from "../stripe-connect/stripe-connect.service";
import { StripeService } from "../billing/stripe.service";
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

describe("PaymentRequestsService", () => {
  let service: PaymentRequestsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let buyerPaymentRequest: ReturnType<typeof graftBuyerPaymentRequest>;

  const mockInvoices = {
    recordStandalonePayment: jest.fn(),
  };
  const mockConnect = {
    chargeableAccount: jest.fn(),
  };
  const mockStripe = {
    client: {},
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
        { provide: StripeService, useValue: mockStripe },
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

  // ─── settleCardBySession (webhook idempotency) ──────────────────────────────

  describe("settleCardBySession", () => {
    const request = {
      id: "req-1",
      tenantId: "tenant-1",
      customerId: "cust-1",
      status: "PENDING",
      amount: 40,
      stripeSessionId: "cs_test_123",
    };

    it("writes the money exactly once even when the same session is settled twice (webhook replay)", async () => {
      const session = { id: "cs_test_123", payment_status: "paid", payment_intent: "pi_123" };
      buyerPaymentRequest.findUnique.mockResolvedValue(request);
      buyerPaymentRequest.updateMany
        .mockResolvedValueOnce({ count: 1 }) // first delivery claims the PENDING row
        .mockResolvedValueOnce({ count: 0 }); // replay finds it already claimed
      prisma.invoice.findMany.mockResolvedValue([
        invoiceRow({
          id: "inv-1",
          invoiceNumber: "INV-0001",
          issueDate: new Date("2026-01-01"),
          total: 40,
        }),
      ]);
      mockInvoices.recordStandalonePayment.mockResolvedValue({ paymentGroupId: "pg-1", excess: 0 });

      const first = await service.settleCardBySession(session);
      const second = await service.settleCardBySession(session);

      expect(first).toEqual({ handled: true });
      expect(second).toEqual({ handled: true });
      expect(buyerPaymentRequest.updateMany).toHaveBeenCalledTimes(2);
      expect(mockInvoices.recordStandalonePayment).toHaveBeenCalledTimes(1);
    });

    it("ignores a session whose payment_status is not paid", async () => {
      const session = { id: "cs_test_456", payment_status: "unpaid" };
      buyerPaymentRequest.findUnique.mockResolvedValue({
        ...request,
        id: "req-2",
        stripeSessionId: "cs_test_456",
      });

      const result = await service.settleCardBySession(session);

      expect(result).toEqual({ handled: false });
      expect(buyerPaymentRequest.updateMany).not.toHaveBeenCalled();
      expect(mockInvoices.recordStandalonePayment).not.toHaveBeenCalled();
    });
  });

  // ─── approve() guards ────────────────────────────────────────────────────────

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
  });

  // ─── cancelOwn ──────────────────────────────────────────────────────────────
  //
  // Cancelling a CARD request is the one buyer action that can destroy money: if
  // the row is flipped to CANCELLED after Checkout was completed, the webhook
  // finds no PENDING row, reads itself as a replay and records nothing — the
  // card is charged and no InvoicePayment exists. These pin the ordering that
  // prevents it.

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

    function stubCheckout(session: any) {
      const sessions = {
        retrieve: jest.fn().mockResolvedValue(session),
        expire: jest.fn().mockResolvedValue({}),
      };
      (mockStripe as any).client = { checkout: { sessions } };
      return sessions;
    }

    it("settles instead of cancelling when the session was already paid", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue(cardRequest);
      buyerPaymentRequest.findUnique.mockResolvedValue(cardRequest);
      buyerPaymentRequest.updateMany.mockResolvedValue({ count: 1 });
      mockConnect.chargeableAccount.mockResolvedValue("acct_1");
      const sessions = stubCheckout({
        id: "cs_test_1",
        payment_status: "paid",
        payment_intent: "pi_1",
      });
      prisma.forTenant().invoice.findMany.mockResolvedValue([]);
      mockInvoices.recordStandalonePayment.mockResolvedValue({
        paymentGroupId: "grp-1",
        excess: 0,
      });

      await expect(service.cancelOwn("buyer-1", "cust-1", "req-card")).rejects.toThrow(
        "already went through",
      );
      expect(mockInvoices.recordStandalonePayment).toHaveBeenCalledTimes(1);
      expect(sessions.expire).not.toHaveBeenCalled();
    });

    it("expires the session before cancelling an unpaid card request", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue(cardRequest);
      buyerPaymentRequest.updateMany.mockResolvedValue({ count: 1 });
      mockConnect.chargeableAccount.mockResolvedValue("acct_1");
      const sessions = stubCheckout({ id: "cs_test_1", payment_status: "unpaid" });

      await expect(service.cancelOwn("buyer-1", "cust-1", "req-card")).resolves.toEqual({
        cancelled: true,
      });
      // Order matters: an un-expired session stays payable from a stale tab.
      expect(sessions.expire).toHaveBeenCalledWith("cs_test_1", { stripeAccount: "acct_1" });
      expect(mockInvoices.recordStandalonePayment).not.toHaveBeenCalled();
    });

    it("refuses to cancel when Stripe's status cannot be read", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue(cardRequest);
      mockConnect.chargeableAccount.mockResolvedValue("acct_1");
      (mockStripe as any).client = {
        checkout: {
          sessions: {
            retrieve: jest.fn().mockRejectedValue(new Error("network")),
            expire: jest.fn(),
          },
        },
      };

      await expect(service.cancelOwn("buyer-1", "cust-1", "req-card")).rejects.toThrow(
        BadRequestException,
      );
      expect(buyerPaymentRequest.updateMany).not.toHaveBeenCalled();
    });

    it("cancels a cash request without touching Stripe", async () => {
      buyerPaymentRequest.findFirst.mockResolvedValue({
        ...cardRequest,
        id: "req-cash",
        kind: "CASH",
        stripeSessionId: null,
      });
      buyerPaymentRequest.updateMany.mockResolvedValue({ count: 1 });
      const sessions = stubCheckout({});

      await expect(service.cancelOwn("buyer-1", "cust-1", "req-cash")).resolves.toEqual({
        cancelled: true,
      });
      expect(sessions.retrieve).not.toHaveBeenCalled();
    });
  });
});
