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

/**
 * SA-750r3 (day close): the pickup hand-over TENDER of a COUNTER order takes the shared counter-close lock for the order's
 * register on the pinned connection and refuses a tender dated in a closed window (409 COUNTER_SALE_DAY_CLOSED, nothing
 * recorded). A non-counter PICKUP order takes NO lock and records exactly as before. A replay with nothing left to collect
 * returns the stored result.
 */
const DB_NOW = new Date("2026-10-09T15:00:00.456Z");
const T_DELIVERED = 1000;
const staff = { sub: "op-1", role: "OPERATOR", tenantId: "t-1" } as never;
const cash = { payment: { method: "CASH", amount: 40 } } as never;

type Inv = { id: string; total: number; status: string; createdAt: Date; payments: any[] };

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
    expect(recordPayment).toHaveBeenCalledWith("inv-1", {
      amount: 37.25,
      method: "CASH",
      reference: undefined,
      paidAt: DB_NOW.toISOString(),
    });
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

  it("a non-counter PICKUP order takes NO close lock, reads no clock or window, and records exactly as before", async () => {
    order = orderRow("OUT_FOR_DELIVERY", { counterSale: false });
    closedWindow(); // a closed window must not matter to it
    await run();
    expect(lockCalls.every((c) => c.sharedAlso === undefined)).toBe(true);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.counterDayClose.findFirst).not.toHaveBeenCalled();
    expect(recordPayment).toHaveBeenCalledWith("inv-1", {
      amount: 37.25,
      method: "CASH",
      reference: undefined,
    });
  });
});
