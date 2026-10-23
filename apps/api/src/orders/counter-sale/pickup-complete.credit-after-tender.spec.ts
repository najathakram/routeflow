// OrdersService / InvoicesService pull ESM-only modules Jest's CommonJS parser cannot load: driven through mocks.
jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));
jest.mock("../order-status-invoicing", () => ({ settleOrderInvoice: jest.fn() }));
// `held` is true only while a counter-tender session lock is held (released however fn ends, as the real lock is).
const mockLock = { notAcquired: false, held: false };
jest.mock("../../common/db-locks", () => ({
  ...jest.requireActual("../../common/db-locks"),
  withAdvisoryLock: async (opts: any, fn: () => Promise<unknown>) => {
    // the hand-over claim (no sharedAlso) always runs; only the tender's lock can be "not taken"
    if (mockLock.notAcquired && opts.sharedAlso) return { acquired: false };
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
const mockHeldAtRecheck: boolean[] = [];
jest.mock("../credit-limit-guard", () => ({
  ...jest.requireActual("../credit-limit-guard"),
  creditAfterTender: (...a: unknown[]) => mockAfterTender(...a),
}));

import { Test } from "@nestjs/testing";
import { PickupCompleteService } from "./pickup-complete.service";
import { FULFILMENT_CAPABILITY_READER } from "./fulfilment-capability-reader";
import { OrdersService } from "../orders.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { PrismaService } from "../../prisma/prisma.service";
import { createMockPrisma } from "../../testing/prisma-mock";

/**
 * I-120 (SA-872 condition 2, SA-849 on the hand-over): the B585 delivery gate netted THIS hand-over's till tender
 * (`creditPaidNow`); when that tender then does not fully record, the ONE post-tender re-check runs (never blocks, never
 * reverses the hand-over) and an ENFORCED breach reaches the response as `creditOverLimit`. Red before: no re-check.
 */
const staff = { sub: "op-1", role: "OPERATOR", tenantId: "t-1" } as never;
const OVER = { limit: 20, exposure: 37.25 };
type Inv = { id: string; total: number; status: string; createdAt: Date; payments: any[] };

describe("PickupCompleteService.complete: the credit re-check after a failed netted tender (I-120)", () => {
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
    deliveredAt: status === "DELIVERED" ? new Date(1000) : null,
    customerId: "cust-1",
    customer: { isWalkIn: false },
    counterSale: true,
    registerKey: null,
    total: 37.25,
    ...over,
  });

  beforeEach(async () => {
    mockLock.notAcquired = false;
    mockLock.held = false;
    mockHeldAtRecheck.length = 0;
    mockAfterTender.mockReset().mockImplementation(async () => {
      mockHeldAtRecheck.push(mockLock.held);
      return OVER;
    });
    claims = [];
    prisma = createMockPrisma();
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
      invoices
        .find((i) => i.id === invoiceId)!
        .payments.push({
          id: "pay-1",
          amount: dto.amount,
          method: dto.method,
          status: "PAID",
          createdAt: new Date(1001),
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
    prisma.$queryRaw.mockResolvedValue([{ now: new Date("2026-10-09T15:00:00.456Z") }]);

    const mod = await Test.createTestingModule({
      providers: [
        PickupCompleteService,
        {
          provide: OrdersService,
          useValue: {
            changeStatus: jest.fn(async () => {
              order = { ...order, status: "DELIVERED", deliveredAt: new Date(1000) };
              return order;
            }),
            entitlements: { hasFlag: async () => true },
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
            sendCompletionEmail: jest.fn(async () => ({ delivered: true })),
          },
        },
        { provide: PrismaService, useValue: prisma },
        {
          provide: FULFILMENT_CAPABILITY_READER,
          useValue: { get: async () => ({ methods: ["PICKUP"], counter: "optional" }) } as never,
        },
      ],
    }).compile();
    service = mod.get(PickupCompleteService);
  });

  const run = (payment: unknown) => service.complete("ord-1", { payment } as never, staff, "key-1");

  it("a CASH tender the gate netted, then recordPayment throws: the re-check runs with what was netted; the breach is answered", async () => {
    recordPayment.mockRejectedValueOnce(new Error("payment-ref 503"));
    const r: any = await run({ method: "CASH", amount: 40 });
    expect(r.paymentRecorded).toBe(false);
    expect(mockAfterTender).toHaveBeenCalledTimes(1);
    expect(mockAfterTender.mock.calls[0][1]).toMatchObject({
      customerId: "cust-1",
      orderId: "ord-1",
      total: 37.25,
      netted: 37.25,
      planError: "COUNTER_PAYMENT_NOT_RECORDED",
    });
    expect(r.creditOverLimit).toEqual(OVER);
    expect(mockHeldAtRecheck).toEqual([false]); // SA-877: never under the tender's session lock
  });

  it("the tender recorded: no re-check, no field", async () => {
    const r: any = await run({ method: "CASH", amount: 40 });
    expect(r.paymentRecorded).toBe(true);
    expect(mockAfterTender).not.toHaveBeenCalled();
    expect(r.creditOverLimit).toBeUndefined();
  });

  it("the tender lock not taken: the re-check runs", async () => {
    mockLock.notAcquired = true;
    const r: any = await run({ method: "CARD", amount: 37.25 });
    expect(r.paymentRecorded).toBe(false);
    expect(mockAfterTender).toHaveBeenCalledTimes(1);
    expect(r.creditOverLimit).toEqual(OVER);
  });

  it("a closed day's 409 (after the hand-over committed): the re-check runs (audit only) and the 409 is unchanged", async () => {
    prisma.counterDayClose.findFirst.mockResolvedValue({ id: "close-1" });
    const err: any = await run({ method: "CASH", amount: 40 }).then(
      () => undefined,
      (e) => e,
    );
    expect(err?.getStatus?.()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: "COUNTER_SALE_DAY_CLOSED" });
    expect(mockAfterTender).toHaveBeenCalledTimes(1);
    expect(mockAfterTender.mock.calls[0][1]).toMatchObject({
      planError: "COUNTER_SALE_DAY_CLOSED",
    });
    expect(mockHeldAtRecheck).toEqual([false]);
  });

  it("a closed day's 409 survives a re-check that throws (its body unchanged)", async () => {
    prisma.counterDayClose.findFirst.mockResolvedValue({ id: "close-1" });
    mockAfterTender.mockImplementation(() => {
      throw new Error("re-check blew up");
    });
    const err: any = await run({ method: "CASH", amount: 40 }).then(
      () => undefined,
      (e) => e,
    );
    expect(err.getResponse()).toMatchObject({ code: "COUNTER_SALE_DAY_CLOSED" });
  });

  it("a re-check that throws never fails the finished hand-over", async () => {
    recordPayment.mockRejectedValueOnce(new Error("503"));
    mockAfterTender.mockImplementation(() => {
      throw new Error("re-check blew up");
    });
    const r: any = await run({ method: "CASH", amount: 40 });
    expect(r.paymentRecorded).toBe(false);
    expect(r.creditOverLimit).toBeUndefined();
  });

  it("already picked up (this call ran no gate, so nothing was netted): a failed tender runs no re-check", async () => {
    order = orderRow("DELIVERED");
    invoices[0].status = "SENT";
    recordPayment.mockRejectedValueOnce(new Error("503"));
    const r: any = await run({ method: "CASH", amount: 40 });
    expect(r.alreadyPickedUp).toBe(true);
    expect(mockAfterTender).not.toHaveBeenCalled();
  });

  it("on account: no tender to fail, no re-check", async () => {
    const r: any = await run({ method: "ON_ACCOUNT" });
    expect(recordPayment).not.toHaveBeenCalled();
    expect(mockAfterTender).not.toHaveBeenCalled();
    expect(r.creditOverLimit).toBeUndefined();
  });
});
