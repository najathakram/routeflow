// OrdersService / InvoicesService pull ESM-only modules: mocks at the module boundary (as counter-sale.service.spec.ts).
jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));
// `held` is true only while the tender's session lock is held (released however fn ends, as the real lock is).
const mockLock = { notAcquired: false, held: false };
jest.mock("../../common/db-locks", () => ({
  ...jest.requireActual("../../common/db-locks"),
  withAdvisoryLock: async (_opts: any, fn: () => Promise<unknown>) => {
    if (mockLock.notAcquired) return { acquired: false };
    mockLock.held = true;
    try {
      return { acquired: true, value: await fn() };
    } finally {
      mockLock.held = false;
    }
  },
}));
// SA-849: the post-tender re-check is spied at the boundary (its own rules: credit-after-tender.spec.ts).
const mockAfterTender = jest.fn();
const mockHeldAtRecheck: boolean[] = []; // SA-877 (1): was the tender lock still held when the re-check ran?
const mockReplayCandidate = jest.fn(); // W-736: the by-key lookup's stored sale
jest.mock("../credit-limit-guard", () => ({
  ...jest.requireActual("../credit-limit-guard"),
  creditAfterTender: (...a: unknown[]) => mockAfterTender(...a),
}));
const mockDayClosed = { on: false };
jest.mock("./counter-tender-window", () => {
  const actual = jest.requireActual("./counter-tender-window");
  const { ConflictException } = jest.requireActual("@nestjs/common");
  return {
    ...actual,
    counterTenderPaidAt: async (...a: unknown[]) => {
      if (mockDayClosed.on)
        throw new ConflictException({ code: "COUNTER_SALE_DAY_CLOSED", message: "closed" });
      return actual.counterTenderPaidAt(...a);
    },
  };
});

import { Test } from "@nestjs/testing";
import { CounterSaleService } from "./counter-sale.service";
import { WalkInCustomerService } from "./walk-in-customer";
import { FULFILMENT_CAPABILITY_READER } from "./fulfilment-capability-reader";
import { OrdersService } from "../orders.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../../audit/audit.service";
import { createMockPrisma } from "../../testing/prisma-mock";

/**
 * SA-849 (S1 S-1) wiring: the counter sale's credit gate netted the till tender; when that tender then does NOT fully
 * record, the ONE post-tender re-check runs (never blocks, never reverses the sale) and an ENFORCED breach reaches the
 * response as `creditOverLimit`. Red on master: no re-check, no field.
 */
const staff = { sub: "op-1", role: "OPERATOR", tenantId: "t-1" } as never;
const item = { productId: "p1", qty: 2, unitPrice: 5 };
const OVER = { limit: 50, exposure: 100 };

describe("CounterSaleService.ring: the credit re-check after a failed netted tender (SA-849)", () => {
  let service: CounterSaleService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let recordPayment: jest.Mock;
  let invoices: any[];

  beforeEach(async () => {
    mockHeldAtRecheck.length = 0;
    mockAfterTender.mockReset().mockImplementation(async () => {
      mockHeldAtRecheck.push(mockLock.held);
      return OVER;
    });
    mockLock.notAcquired = false;
    mockLock.held = false;
    mockReplayCandidate.mockReset().mockResolvedValue(null);
    mockDayClosed.on = false;
    prisma = createMockPrisma();
    invoices = [{ id: "inv-1", total: 100, status: "SENT", createdAt: new Date(1), payments: [] }];
    recordPayment = jest.fn(async (invoiceId: string, dto: any) => {
      invoices
        .find((i) => i.id === invoiceId)
        .payments.push({
          id: "pay-1",
          amount: dto.amount,
          method: dto.method,
          status: "PAID",
        });
      return { id: invoiceId, createdPaymentId: "pay-1" };
    });
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    prisma.product.findMany.mockResolvedValue([{ id: "p1" }]);
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.tenantConfig.findUnique.mockResolvedValue({ creditAutoApplyOnSend: false });
    prisma.order.findFirst.mockImplementation(async () => ({
      id: "ord-1",
      orderNumber: "ORD-1",
      total: 100,
      counterCashTendered: null,
    }));
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.invoice.findMany.mockImplementation(async () =>
      invoices.map((i) => ({ ...i, payments: [...i.payments], invoiceNumber: `N-${i.id}` })),
    );
    const mod = await Test.createTestingModule({
      providers: [
        CounterSaleService,
        {
          provide: OrdersService,
          useValue: {
            createSale: jest.fn(async () => ({ id: "inv-1", orderId: "ord-1" })),
            findReplayCandidateByKey: (...a: unknown[]) => mockReplayCandidate(...a),
            entitlements: { hasFlag: async () => true },
          },
        },
        { provide: InvoicesService, useValue: { recordPayment } },
        { provide: WalkInCustomerService, useValue: { getOrCreateWalkIn: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        {
          provide: FULFILMENT_CAPABILITY_READER,
          useValue: { get: async () => ({ methods: ["PICKUP"], counter: "optional" }) },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    service = mod.get(CounterSaleService);
  });

  const ring = (payment: unknown) =>
    service.ring({ customerId: "cust-1", items: [item], payment } as never, staff, "key-1");

  it("R1 a CASH tender that throws at recordPayment: the re-check runs with what was netted, and the breach is answered", async () => {
    recordPayment.mockRejectedValueOnce(new Error("payment-ref 503"));
    const r: any = await ring({ method: "CASH", amount: 100 });
    expect(r.paymentRecorded).toBe(false);
    expect(mockAfterTender).toHaveBeenCalledTimes(1);
    expect(mockAfterTender.mock.calls[0][1]).toMatchObject({
      customerId: "cust-1",
      orderId: "ord-1",
      total: 100,
      netted: 100,
      planError: "COUNTER_PAYMENT_NOT_RECORDED",
    });
    expect(r.creditOverLimit).toEqual(OVER);
  });

  // SA-877 (1): the re-check's own xact lock is a leaf: it never runs while the tender's session lock is held.
  // SA-878: the rows are named after SA-849's failure paths (a)-(c); (d), the closed day, is the case below.
  it.each([
    ["(a) the tender lock is not taken", () => (mockLock.notAcquired = true), "CARD"],
    [
      "(b) the cash-tendered store fails",
      () =>
        prisma.order.updateMany.mockImplementation(async (a: any) => {
          if (a?.data?.counterCashTendered !== undefined) throw new Error("store down");
          return { count: 1 };
        }),
      "CASH",
    ],
    [
      "(c) recordPayment throws (CASH)",
      () => recordPayment.mockRejectedValueOnce(new Error("503")),
      "CASH",
    ],
    [
      "(c) recordPayment throws (non-cash, e.g. a duplicate reference)",
      () => recordPayment.mockRejectedValueOnce(new Error("dup ref")),
      "CARD",
    ],
  ])(
    "SA-877 %s: the tender lock is released before creditAfterTender runs",
    async (_n, arrange, method) => {
      arrange();
      const r: any = await ring({ method, amount: 100 });
      expect(r.paymentRecorded).toBe(false);
      expect(mockHeldAtRecheck).toEqual([false]);
    },
  );

  it("SA-877 (d) a closed day's 409: the tender lock is released before the re-check, and the 409 is rethrown", async () => {
    mockDayClosed.on = true;
    const err: any = await ring({ method: "CASH", amount: 100 }).then(
      () => undefined,
      (e) => e,
    );
    expect(err.getResponse()).toMatchObject({ code: "COUNTER_SALE_DAY_CLOSED", message: "closed" });
    expect(mockHeldAtRecheck).toEqual([false]);
  });

  it("R2 the tender recorded: no re-check, no field", async () => {
    const r: any = await ring({ method: "CASH", amount: 100 });
    expect(r.paymentRecorded).toBe(true);
    expect(mockAfterTender).not.toHaveBeenCalled();
    expect(r.creditOverLimit).toBeUndefined();
  });

  it("R5 the tender lock not taken: the re-check runs", async () => {
    mockLock.notAcquired = true;
    const r: any = await ring({ method: "CARD", amount: 100 });
    expect(r.paymentRecorded).toBe(false);
    expect(mockAfterTender).toHaveBeenCalledTimes(1);
    expect(r.creditOverLimit).toEqual(OVER);
  });

  it("R6 a closed day's 409 (after the sale committed): the re-check runs (audit only) and the 409 is unchanged", async () => {
    mockDayClosed.on = true;
    const err: any = await ring({ method: "CASH", amount: 100 }).catch((e) => e);
    expect(err?.getStatus?.()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: "COUNTER_SALE_DAY_CLOSED" });
    expect(mockAfterTender).toHaveBeenCalledTimes(1);
    expect(mockAfterTender.mock.calls[0][1]).toMatchObject({
      planError: "COUNTER_SALE_DAY_CLOSED",
    });
  });

  it("SA-876 LOW 1: a re-check that throws on path (d) never replaces the closed-day 409 (its body unchanged)", async () => {
    mockDayClosed.on = true;
    mockAfterTender.mockImplementation(() => {
      throw new Error("re-check blew up");
    });
    const err: any = await ring({ method: "CASH", amount: 100 }).catch((e) => e);
    expect(err?.getStatus?.()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: "COUNTER_SALE_DAY_CLOSED", message: "closed" });
  });

  it("a re-check that throws after a failed tender never fails the finished sale (paymentRecorded false, no field)", async () => {
    recordPayment.mockRejectedValueOnce(new Error("payment-ref 503"));
    mockAfterTender.mockImplementation(() => {
      throw new Error("re-check blew up");
    });
    const r: any = await ring({ method: "CASH", amount: 100 });
    expect(r.paymentRecorded).toBe(false);
    expect(r.creditOverLimit).toBeUndefined();
  });

  // A post-dated check is refused by ring before any tender (so it can never reach this path); netted = 0 itself is
  // the guard's own no-op (credit-after-tender.spec.ts R8).
  it("R8 on account: the sale finishes with no tender to fail, so no re-check", async () => {
    recordPayment.mockRejectedValue(new Error("boom")); // would fail a tender, were there one
    const r: any = await ring({ method: "ON_ACCOUNT" });
    expect(r.orderId).toBe("ord-1");
    expect(recordPayment).not.toHaveBeenCalled();
    expect(mockAfterTender).not.toHaveBeenCalled();
    expect(r.creditOverLimit).toBeUndefined();
  });

  // W-736 (SA-876 LOW 2): GET by-key serves the same credit line the POST answered, READ-ONLY (no log line, no audit row).
  describe("byKey: the stored sale's credit line (W-736)", () => {
    beforeEach(() => {
      mockReplayCandidate.mockResolvedValue({
        id: "ord-1",
        orderNumber: "ORD-1",
        counterSale: true,
        status: "DELIVERED",
        customerId: "cust-1",
        total: 100,
        counterCashTendered: null,
      });
    });

    it("the till's CASH tender did not record: the re-check runs read-only and the line is served", async () => {
      const r: any = await service.byKey("key-1", "CASH");
      expect(r.paymentRecorded).toBe(false);
      expect(mockAfterTender).toHaveBeenCalledTimes(1);
      expect(mockAfterTender.mock.calls[0][1]).toMatchObject({
        customerId: "cust-1",
        orderId: "ord-1",
        total: 100,
        netted: 100,
        readOnly: true,
      });
      expect(r.creditOverLimit).toEqual(OVER);
    });

    it("the payment is recorded: no re-check, no line", async () => {
      invoices[0].payments.push({ id: "p0", amount: 100, method: "CASH", status: "PAID" });
      invoices[0].status = "PAID";
      const r: any = await service.byKey("key-1", "CASH");
      expect(r.paymentRecorded).toBe(true);
      expect(mockAfterTender).not.toHaveBeenCalled();
      expect(r.creditOverLimit).toBeUndefined();
    });

    it("no till method (the tender is unknown, so nothing was netted to re-check): no re-check, no line", async () => {
      const r: any = await service.byKey("key-1");
      expect(mockAfterTender).not.toHaveBeenCalled();
      expect(r.creditOverLimit).toBeUndefined();
    });

    it("a re-check that throws never fails the read", async () => {
      mockAfterTender.mockImplementation(() => {
        throw new Error("re-check blew up");
      });
      const r: any = await service.byKey("key-1", "CASH");
      expect(r.paymentRecorded).toBe(false);
      expect(r.creditOverLimit).toBeUndefined();
    });
  });
});
