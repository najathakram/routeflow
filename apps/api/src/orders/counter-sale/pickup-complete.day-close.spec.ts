// OrdersService / InvoicesService pull ESM-only modules Jest's CommonJS parser cannot load: driven through mocks.
jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));
jest.mock("../order-status-invoicing", () => ({ settleOrderInvoice: jest.fn() }));

const events: string[] = [];
const lockCalls: Array<{ family: string; key: string; sharedAlso?: unknown }> = [];
jest.mock("../../common/db-locks", () => ({
  ...jest.requireActual("../../common/db-locks"),
  withAdvisoryLock: async (opts: any, fn: () => Promise<unknown>) => {
    lockCalls.push({ family: opts.family, key: opts.key, sharedAlso: opts.sharedAlso });
    events.push(`lock:${lockCalls.length}`);
    try {
      return { acquired: true, value: await fn() };
    } finally {
      events.push(`unlock:${lockCalls.length}`);
    }
  },
}));

import { Test } from "@nestjs/testing";
import { PickupCompleteService } from "./pickup-complete.service";
import { OrdersService } from "../orders.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { PrismaService } from "../../prisma/prisma.service";
import { createMockPrisma } from "../../testing/prisma-mock";
import { pickupTenderGroupId } from "./pickup-tender-group";

/**
 * SA-750r3 (day close): the pickup hand-over TENDER (a counter order's OR a POS-mode PICKUP order's) takes the shared
 * counter-close lock for its register on the pinned connection and refuses a tender dated in a closed window (409
 * COUNTER_SALE_DAY_CLOSED, nothing stamped or recorded). A non-counter order counts toward its STAMPED register, else the
 * request's, else 'main', and is stamped when it has none. A replay with nothing left to collect returns the stored result.
 */
const TILL = { paymentGroupId: pickupTenderGroupId("ord-1"), tillLockHeld: true };
const DB_NOW = new Date("2026-10-09T15:00:00.456Z");
const T_DELIVERED = 1000;
const staff = { sub: "op-1", role: "OPERATOR", tenantId: "t-1" } as never;
const cash = { payment: { method: "CASH", amount: 40 } } as never;

type Inv = { id: string; total: number; status: string; createdAt: Date; payments: any[] };

// Order.updateMany is also the receipt branch's cashier stamp (data.soldById): the register-stamp assertions look only at the
// calls whose data names registerKey, so each assertion is about its own write, never about call index 0.
let prismaRef: { order: { updateMany: jest.Mock } } | null = null;
const registerStamps = () =>
  (prismaRef?.order.updateMany.mock.calls ?? []).filter(
    ([a]: any[]) => a?.data && "registerKey" in a.data,
  );

describe("PickupCompleteService.complete — the day-close lock and window (SA-750r3)", () => {
  let service: PickupCompleteService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let order: any;
  let invoices: Inv[];
  let recordPayment: jest.Mock;
  let claims: any[];

  const orderRow = (status: string, over: object = {}) => ({
    id: "ord-1",
    orderNumber: "ORD-1",
    status,
    fulfillPath: "PICKUP",
    deliveredAt: status === "DELIVERED" ? new Date(T_DELIVERED) : null,
    customerId: "cust-1",
    customer: { isWalkIn: false },
    ...over,
  });
  const closedWindow = () =>
    prisma.counterDayClose.findFirst.mockImplementation(async () => {
      events.push("window-read");
      return { id: "close-1" };
    });

  beforeEach(async () => {
    events.length = 0;
    lockCalls.length = 0;
    claims = [];
    prisma = createMockPrisma();
    prismaRef = prisma as never;
    order = orderRow("OUT_FOR_DELIVERY", { counterSale: true, registerKey: null });
    invoices = [
      {
        id: "inv-1",
        total: 37.25,
        status: "DRAFT",
        createdAt: new Date(2026, 9, 9, 12),
        payments: [],
      },
    ];
    recordPayment = jest.fn(async (invoiceId: string, dto: any) => {
      events.push("record");
      invoices
        .find((i) => i.id === invoiceId)!
        .payments.push({
          id: "pay-1",
          amount: dto.amount,
          method: dto.method,
          status: "PAID",
          createdAt: new Date(T_DELIVERED + 1),
        });
      return { id: invoiceId };
    });
    prisma.order.findFirst.mockImplementation(async () => order);
    prisma.auditLog.findFirst.mockImplementation(async () => claims[0] ?? null);
    prisma.auditLog.create.mockImplementation(async ({ data }: any) => {
      claims.push(data);
      return data;
    });
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockImplementation(async () =>
      invoices.map((i) => ({ ...i, payments: [...i.payments], invoiceNumber: `N-${i.id}` })),
    );
    prisma.counterDayClose.findFirst.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([{ now: DB_NOW }]);

    const mod = await Test.createTestingModule({
      providers: [
        PickupCompleteService,
        {
          provide: OrdersService,
          useValue: {
            changeStatus: jest.fn(async () => {
              order = { ...order, status: "DELIVERED", deliveredAt: new Date(T_DELIVERED) };
              return order;
            }),
          },
        },
        {
          provide: InvoicesService,
          useValue: {
            send: jest.fn(async (id: string) => {
              invoices.find((i) => i.id === id)!.status = "SENT";
              return { id };
            }),
            recordPayment,
          },
        },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(PickupCompleteService);
  });

  const run = (body: unknown = cash) => service.complete("ord-1", body as never, staff, "key-1");

  it("a counter order's tender takes the shared close lock for its register; the claim section does not", async () => {
    await run();
    expect(lockCalls).toEqual([
      { family: "counter-tender", key: "ord-1", sharedAlso: undefined }, // the hand-over claim: no money
      {
        family: "counter-tender",
        key: "ord-1",
        sharedAlso: { family: "counter-close", key: "test-tenant:main" },
      },
    ]);
  });

  it("dates the payment from the database clock, read after the lock and before the write", async () => {
    await run();
    expect(recordPayment).toHaveBeenCalledWith(
      "inv-1",
      {
        amount: 37.25,
        method: "CASH",
        reference: undefined,
        paidAt: DB_NOW.toISOString(),
      },
      TILL,
    );
    expect(prisma.counterDayClose.findFirst.mock.calls[0][0].where).toMatchObject({
      tenantId: "test-tenant",
      registerKey: "main",
      reopenedAt: null,
    });
    expect(events.indexOf("lock:2")).toBeLessThan(events.indexOf("record"));
  });

  it("a tender dated inside a closed window is 409 COUNTER_SALE_DAY_CLOSED and nothing is recorded", async () => {
    closedWindow();
    const err: any = await run().catch((e) => e);
    expect(err.getStatus?.()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: "COUNTER_SALE_DAY_CLOSED" });
    expect(recordPayment).not.toHaveBeenCalled();
    expect(invoices[0].payments).toHaveLength(0);
    expect(events.indexOf("lock:2")).toBeLessThan(events.indexOf("window-read"));
  });

  it("a tender after the window (a reopened or absent close) is recorded", async () => {
    const res = await run();
    expect(recordPayment).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ paymentRecorded: true, paid: 37.25 });
  });

  it("a replay with the tender already stored returns the stored result, never 409, even in a closed window", async () => {
    await run();
    recordPayment.mockClear();
    prisma.counterDayClose.findFirst.mockClear();
    closedWindow();
    order = orderRow("DELIVERED", { counterSale: true, registerKey: null });
    const res = await run();
    expect(res).toMatchObject({ alreadyPickedUp: true, paymentRecorded: true, paid: 37.25 });
    expect(recordPayment).not.toHaveBeenCalled();
    expect(prisma.counterDayClose.findFirst).not.toHaveBeenCalled();
  });

  it("a counter order is unchanged by a request registerKey: its own register, and it is never stamped", async () => {
    order = orderRow("OUT_FOR_DELIVERY", { counterSale: true, registerKey: null });
    await run({ ...(cash as object), registerKey: "b" });
    expect(lockCalls[1].sharedAlso).toEqual({ family: "counter-close", key: "test-tenant:main" });
    expect(registerStamps()).toHaveLength(0);
  });
});

describe("PickupCompleteService.complete — a POS-mode PICKUP order's cash counts on a register (SA-750r3)", () => {
  let service: PickupCompleteService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let order: any;
  let invoices: Inv[];
  let recordPayment: jest.Mock;
  let claims: any[];

  const orderRow = (status: string, over: object = {}) => ({
    id: "ord-1",
    orderNumber: "ORD-1",
    status,
    fulfillPath: "PICKUP",
    deliveredAt: status === "DELIVERED" ? new Date(T_DELIVERED) : null,
    customerId: "cust-1",
    customer: { isWalkIn: false },
    counterSale: false,
    registerKey: null,
    ...over,
  });
  const closedWindow = () =>
    prisma.counterDayClose.findFirst.mockImplementation(async () => {
      events.push("window-read");
      return { id: "close-1" };
    });
  const withKey = (registerKey?: string) => ({ ...(cash as object), registerKey }) as never;

  beforeEach(async () => {
    events.length = 0;
    lockCalls.length = 0;
    claims = [];
    prisma = createMockPrisma();
    prismaRef = prisma as never;
    order = orderRow("OUT_FOR_DELIVERY");
    invoices = [
      {
        id: "inv-1",
        total: 37.25,
        status: "DRAFT",
        createdAt: new Date(2026, 9, 9, 12),
        payments: [],
      },
    ];
    recordPayment = jest.fn(async (invoiceId: string, dto: any) => {
      events.push("record");
      invoices
        .find((i) => i.id === invoiceId)!
        .payments.push({
          id: "pay-1",
          amount: dto.amount,
          method: dto.method,
          status: "PAID",
          createdAt: new Date(T_DELIVERED + 1),
        });
      return { id: invoiceId };
    });
    prisma.order.findFirst.mockImplementation(async () => order);
    prisma.order.updateMany.mockImplementation(async (args: any) => {
      // the receipt branch's cashier stamp (data.soldById) is not a register stamp: it never touches the register
      if (!("registerKey" in (args.data ?? {}))) return { count: 1 };
      events.push("stamp");
      if (order.registerKey != null) return { count: 0 };
      order.registerKey = args.data.registerKey;
      return { count: 1 };
    });
    prisma.auditLog.findFirst.mockImplementation(async () => claims[0] ?? null);
    prisma.auditLog.create.mockImplementation(async ({ data }: any) => {
      claims.push(data);
      return data;
    });
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockImplementation(async () =>
      invoices.map((i) => ({ ...i, payments: [...i.payments], invoiceNumber: `N-${i.id}` })),
    );
    prisma.counterDayClose.findFirst.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([{ now: DB_NOW }]);

    const mod = await Test.createTestingModule({
      providers: [
        PickupCompleteService,
        {
          provide: OrdersService,
          useValue: {
            changeStatus: jest.fn(async () => {
              order = { ...order, status: "DELIVERED", deliveredAt: new Date(T_DELIVERED) };
              return order;
            }),
          },
        },
        {
          provide: InvoicesService,
          useValue: {
            send: jest.fn(async (id: string) => {
              invoices.find((i) => i.id === id)!.status = "SENT";
              return { id };
            }),
            recordPayment,
          },
        },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(PickupCompleteService);
  });

  const run = (body: unknown = cash) => service.complete("ord-1", body as never, staff, "key-1");

  it("locks and counts the request's register, stamps it before the payment, in the closed-window-checked DB-clock instant", async () => {
    await run(withKey("b"));
    expect(lockCalls[1].sharedAlso).toEqual({ family: "counter-close", key: "test-tenant:b" });
    expect(prisma.counterDayClose.findFirst.mock.calls[0][0].where).toMatchObject({
      tenantId: "test-tenant",
      registerKey: "b",
      reopenedAt: null,
    });
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: "ord-1", tenantId: "test-tenant", registerKey: null },
      data: { registerKey: "b" },
    });
    expect(recordPayment).toHaveBeenCalledWith(
      "inv-1",
      expect.objectContaining({ amount: 37.25, paidAt: DB_NOW.toISOString() }),
      TILL,
    );
    expect(events.indexOf("lock:2")).toBeLessThan(events.indexOf("stamp"));
    expect(events.indexOf("stamp")).toBeLessThan(events.indexOf("record"));
    expect(order.registerKey).toBe("b");
  });

  it("an order already stamped 'main' counts under 'main' whatever the request says, and is not restamped", async () => {
    order = orderRow("OUT_FOR_DELIVERY", { registerKey: "main" });
    await run(withKey("b"));
    expect(lockCalls[1].sharedAlso).toEqual({ family: "counter-close", key: "test-tenant:main" });
    expect(prisma.counterDayClose.findFirst.mock.calls[0][0].where.registerKey).toBe("main");
    expect(registerStamps()).toHaveLength(0);
    expect(recordPayment).toHaveBeenCalledTimes(1);
  });

  it("no registerKey on the request and none stamped: 'main' (and it is stamped)", async () => {
    await run();
    expect(lockCalls[1].sharedAlso).toEqual({ family: "counter-close", key: "test-tenant:main" });
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: "ord-1", tenantId: "test-tenant", registerKey: null },
      data: { registerKey: "main" },
    });
  });

  it("a blank request key reads as absent; the key is case-sensitive and never lower-cased", async () => {
    await run(withKey("   "));
    expect(lockCalls[1].sharedAlso).toEqual({ family: "counter-close", key: "test-tenant:main" });
    lockCalls.length = 0;
    order = orderRow("OUT_FOR_DELIVERY");
    invoices[0].payments = [];
    await run(withKey("Till-B"));
    expect(lockCalls[1].sharedAlso).toEqual({ family: "counter-close", key: "test-tenant:Till-B" });
  });

  it("a hand-over into a closed window is 409 COUNTER_SALE_DAY_CLOSED: nothing stamped, nothing recorded", async () => {
    closedWindow();
    const err: any = await run(withKey("b")).catch((e) => e);
    expect(err.getStatus?.()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: "COUNTER_SALE_DAY_CLOSED" });
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(recordPayment).not.toHaveBeenCalled();
    expect(invoices[0].payments).toHaveLength(0);
  });

  it("a replay with nothing left to record writes no stamp and is never refused, even in a closed window", async () => {
    await run(withKey("b"));
    recordPayment.mockClear();
    prisma.order.updateMany.mockClear();
    prisma.counterDayClose.findFirst.mockClear();
    closedWindow();
    const res = await run(withKey("c"));
    expect(res).toMatchObject({ alreadyPickedUp: true, paymentRecorded: true, paid: 37.25 });
    expect(registerStamps()).toHaveLength(0);
    expect(recordPayment).not.toHaveBeenCalled();
    expect(prisma.counterDayClose.findFirst).not.toHaveBeenCalled();
    expect(order.registerKey).toBe("b");
  });

  it("a concurrent hand-over that stamped another register first records nothing here (retryable, not a mis-count)", async () => {
    prisma.order.updateMany.mockImplementation(async () => {
      order.registerKey = "c";
      return { count: 0 };
    });
    const res = await run(withKey("b"));
    expect(recordPayment).not.toHaveBeenCalled();
    expect(res).toMatchObject({ paymentRecorded: false });
  });

  it("a non-PICKUP order is still refused PICKUP_ONLY before any lock", async () => {
    order = orderRow("OUT_FOR_DELIVERY", { fulfillPath: "DELIVERY" });
    const err: any = await run(withKey("b")).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: "PICKUP_ONLY" });
    expect(lockCalls).toHaveLength(0);
  });
});
