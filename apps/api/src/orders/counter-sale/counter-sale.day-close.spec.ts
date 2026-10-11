// OrdersService / InvoicesService pull ESM-only modules Jest's CommonJS parser cannot load: driven through mocks.
jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));

// The advisory lock becomes an in-process stand-in (fn never runs without it); the calls, the shared option and the order
// of events against the window read are recorded.
const events: string[] = [];
const lockCalls: Array<{ family: string; key: string; sharedAlso?: unknown }> = [];
jest.mock("../../common/db-locks", () => ({
  ...jest.requireActual("../../common/db-locks"),
  withAdvisoryLock: async (opts: any, fn: () => Promise<unknown>) => {
    lockCalls.push({ family: opts.family, key: opts.key, sharedAlso: opts.sharedAlso });
    events.push("lock");
    try {
      return { acquired: true, value: await fn() };
    } finally {
      events.push("unlock");
    }
  },
}));

import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { FulfilmentCapability } from "@routeflow/types";
import { CounterSaleService } from "./counter-sale.service";
import { legGroupId } from "./counter-tender-row";
import { WalkInCustomerService } from "./walk-in-customer";
import { FULFILMENT_CAPABILITY_READER } from "./fulfilment-capability-reader";
import { OrdersService } from "../orders.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../../audit/audit.service";
import { createMockPrisma } from "../../testing/prisma-mock";

/**
 * SA-750r3 (day close): the counter-sale TENDER takes the shared counter-close lock for the order's register on the pinned
 * connection (`sharedAlso`), refuses a tender dated in a closed window (409 COUNTER_SALE_DAY_CLOSED, nothing written) and dates
 * the payment from the DATABASE clock. A replay of a recorded tender returns the stored result; ON_ACCOUNT takes no money.
 */
const DB_NOW = new Date("2026-10-09T15:00:00.123Z");
const staff = { sub: "op-1", role: "OPERATOR", tenantId: "t-1" } as never;
const cap = {
  methods: ["PICKUP", "SHIP"],
  staffDefault: "PICKUP",
  staffOpensAs: "counter",
  portalMethods: [],
  portalDefault: null,
  counter: "always",
  fleet: true,
  consistent: true,
} as FulfilmentCapability;

type Inv = { id: string; total: number; status: string; createdAt: Date; payments: any[] };

describe("CounterSaleService.ring — the day-close lock and window (SA-750r3)", () => {
  let service: CounterSaleService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let recordPayment: jest.Mock;
  let invoices: Inv[];
  let replay: boolean;

  const body = (payment: any) =>
    ({
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2, unitPrice: 5 }],
      payment,
    }) as never;
  const closedWindow = () =>
    prisma.counterDayClose.findFirst.mockImplementation(async () => {
      events.push("window-read");
      return { id: "close-1" };
    });

  beforeEach(async () => {
    events.length = 0;
    lockCalls.length = 0;
    replay = false;
    prisma = createMockPrisma();
    invoices = [
      {
        id: "inv-1",
        total: 37.25,
        status: "SENT",
        createdAt: new Date(2026, 9, 9, 12),
        payments: [],
      },
    ];
    recordPayment = jest.fn(async (invoiceId: string, dto: any) => {
      events.push("record");
      invoices
        .find((i) => i.id === invoiceId)!
        .payments.push({ id: "pay-1", amount: dto.amount, method: dto.method, status: "PAID" });
      return { id: invoiceId };
    });
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    prisma.product.findMany.mockResolvedValue([{ id: "p1" }]);
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.tenantConfig.findUnique.mockResolvedValue({ creditAutoApplyOnSend: false });
    prisma.order.findFirst.mockResolvedValue({ id: "ord-1", orderNumber: "ORD-1" });
    prisma.invoice.findMany.mockImplementation(async () =>
      invoices.map((i) => ({ ...i, payments: [...i.payments], invoiceNumber: `N-${i.id}` })),
    );
    prisma.counterDayClose.findFirst.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([{ now: DB_NOW }]);

    const mod = await Test.createTestingModule({
      providers: [
        CounterSaleService,
        {
          provide: OrdersService,
          useValue: {
            createSale: jest.fn(async (_d: any, _u: any, sale: any) => {
              if (replay) sale?.onReplay?.({ id: "ord-1", counterSale: true });
              return { id: "inv-1", orderId: "ord-1", invoiceNumber: "INV-1" };
            }),
            findReplayCandidateByKey: jest.fn(),
          },
        },
        { provide: InvoicesService, useValue: { recordPayment } },
        { provide: WalkInCustomerService, useValue: { getOrCreateWalkIn: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        {
          provide: FULFILMENT_CAPABILITY_READER,
          useValue: { get: jest.fn().mockResolvedValue(cap) },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    service = mod.get(CounterSaleService);
  });

  it("takes the shared close lock for the order's register on the tender's pinned connection", async () => {
    await service.ring(body({ method: "CASH", amount: 40 }), staff, "k");
    expect(lockCalls).toEqual([
      {
        family: "counter-tender",
        key: "ord-1",
        sharedAlso: { family: "counter-close", key: "test-tenant:main" },
      },
    ]);
  });

  it("an order on another register is locked and checked on THAT register", async () => {
    prisma.order.findFirst.mockResolvedValue({
      id: "ord-1",
      orderNumber: "ORD-1",
      registerKey: "b",
    });
    await service.ring(body({ method: "CASH", amount: 40 }), staff, "k");
    expect(lockCalls[0].sharedAlso).toEqual({ family: "counter-close", key: "test-tenant:b" });
    expect(prisma.counterDayClose.findFirst.mock.calls[0][0].where).toMatchObject({
      tenantId: "test-tenant",
      registerKey: "b",
      reopenedAt: null,
    });
  });

  it("dates the payment from the DATABASE clock, read after the lock and before the write", async () => {
    closedWindow().mockImplementation(async () => {
      events.push("window-read");
      return null;
    });
    await service.ring(body({ method: "CASH", amount: 40 }), staff, "k");
    expect(recordPayment).toHaveBeenCalledWith(
      "inv-1",
      {
        amount: 37.25,
        method: "CASH",
        reference: undefined,
        paidAt: DB_NOW.toISOString(),
      },
      { tillLockHeld: true, paymentGroupId: legGroupId("ord-1", 0) },
    );
    expect(events).toEqual(["lock", "window-read", "record", "unlock"]);
    expect(prisma.counterDayClose.findFirst.mock.calls[0][0].where).toMatchObject({
      windowStart: { lte: DB_NOW },
      windowEnd: { gt: DB_NOW },
    });
  });

  it("a tender dated inside a closed window is 409 COUNTER_SALE_DAY_CLOSED and nothing is written", async () => {
    closedWindow();
    const err: any = await service
      .ring(body({ method: "CASH", amount: 40 }), staff, "k")
      .catch((e) => e);
    expect(err.getStatus?.()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: "COUNTER_SALE_DAY_CLOSED" });
    expect(recordPayment).not.toHaveBeenCalled();
    expect(invoices[0].payments).toHaveLength(0);
    expect(events).toEqual(["lock", "window-read", "unlock"]);
  });

  it("a tender after the window (no close in force at that instant, or a reopened close) is recorded", async () => {
    // counterWindowClosed asks for reopenedAt: null rows only, so a reopened close never matches: the read answers none.
    const r = await service.ring(body({ method: "CASH", amount: 40 }), staff, "k");
    expect(prisma.counterDayClose.findFirst.mock.calls[0][0].where.reopenedAt).toBeNull();
    expect(recordPayment).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ paymentRecorded: true, paid: 37.25 });
  });

  it("a replay of a RECORDED tender returns the stored result, never 409, even when the window is now closed", async () => {
    await service.ring(body({ method: "CASH", amount: 40 }), staff, "k");
    recordPayment.mockClear();
    prisma.counterDayClose.findFirst.mockClear();
    closedWindow();
    replay = true;
    const r = await service.ring(body({ method: "CASH", amount: 40 }), staff, "k");
    expect(r).toMatchObject({ replayed: true, paymentRecorded: true, paid: 37.25 });
    expect(recordPayment).not.toHaveBeenCalled();
    expect(prisma.counterDayClose.findFirst).not.toHaveBeenCalled();
  });

  it("the refusal is not swallowed into paymentRecorded:false (only lock errors and write failures are)", async () => {
    closedWindow();
    await expect(
      service.ring(body({ method: "CASH", amount: 40 }), staff, "k"),
    ).rejects.not.toBeInstanceOf(BadRequestException);
  });

  describe("SA-764 ordering: the closed-day check runs before the cash-tendered write", () => {
    beforeEach(() => {
      prisma.order.updateMany.mockImplementation(async () => {
        events.push("cash-tendered");
        return { count: 1 };
      });
    });

    it("a CASH tender into a closed window is 409 COUNTER_SALE_DAY_CLOSED and counterCashTendered is NEVER written", async () => {
      closedWindow();
      const err: any = await service
        .ring(body({ method: "CASH", amount: 40 }), staff, "k")
        .catch((e) => e);
      expect(err.getStatus?.()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: "COUNTER_SALE_DAY_CLOSED" });
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(recordPayment).not.toHaveBeenCalled();
    });

    it("a tender after the window writes the cash-tendered figure BEFORE the payment", async () => {
      await service.ring(body({ method: "CASH", amount: 40 }), staff, "k");
      expect(prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { counterCashTendered: 40 } }),
      );
      expect(events).toEqual(["lock", "cash-tendered", "record", "unlock"]);
    });

    it("a replay with nothing left to record never overwrites the stored figure (only a NULL is filled) and is never refused", async () => {
      await service.ring(body({ method: "CASH", amount: 40 }), staff, "k");
      recordPayment.mockClear();
      prisma.order.updateMany.mockClear();
      prisma.counterDayClose.findFirst.mockClear();
      closedWindow();
      replay = true;
      const r = await service.ring(body({ method: "CASH", amount: 40 }), staff, "k");
      expect(r).toMatchObject({ replayed: true, paymentRecorded: true });
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: "ord-1", counterCashTendered: null },
        data: { counterCashTendered: 40 },
      });
      expect(recordPayment).not.toHaveBeenCalled();
      expect(prisma.counterDayClose.findFirst).not.toHaveBeenCalled();
    });

    it("a replay with nothing left to record and NO cash tender row anchoring it still only fills a NULL", async () => {
      // SA-749r2 form of the rule: the card leg is stored (grouped), the cash leg has no row and NO room left (an office
      // check took the rest of the invoice), so there is nothing to record and no CASH row anchors the figure. The first
      // attempt stored the 20 handed over before any money moved; the replay carries the same 20 (another figure is 409).
      // (A CASH request over a stored CARD row is now COUNTER_TENDER_CHANGED: the replay of a different tender.)
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-1",
        orderNumber: "ORD-1",
        counterCashTendered: 20,
      });
      invoices[0].payments.push(
        {
          id: "pay-card",
          amount: 20,
          method: "CREDIT_CARD",
          status: "PAID",
          paymentGroupId: legGroupId("ord-1", 0),
        },
        { id: "pay-office", amount: 17.25, method: "CHECK", status: "PAID", paymentGroupId: null },
      );
      replay = true;
      const r = await service.ring(
        {
          customerId: "cust-1",
          items: [{ productId: "p1", qty: 2, unitPrice: 5 }],
          payments: [
            { method: "CARD", amount: 20 },
            { method: "CASH", amount: 20 },
          ],
        } as never,
        staff,
        "k",
      );
      expect(r).toMatchObject({ replayed: true });
      expect(recordPayment).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: "ord-1", counterCashTendered: null },
        data: { counterCashTendered: 20 },
      });
    });

    it("with something to record and no CASH tender row anchoring it, the figure is still overwritten (a failed first attempt's stale figure)", async () => {
      await service.ring(body({ method: "CASH", amount: 40 }), staff, "k");
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: "ord-1" },
        data: { counterCashTendered: 40 },
      });
    });
  });

  it("ON_ACCOUNT takes no money: no tender lock, no clock read, no window read", async () => {
    await service.ring(body({ method: "ON_ACCOUNT" }), staff, "k");
    expect(lockCalls).toHaveLength(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.counterDayClose.findFirst).not.toHaveBeenCalled();
  });
});
