// OrdersService / InvoicesService pull ESM-only modules (@react-pdf/renderer, expo-server-sdk)
// Jest's CommonJS parser cannot load; this spec drives them through mocks at the module boundary.
jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));

// The shared Postgres advisory lock becomes an in-process stand-in with the same contract (fn never
// runs without the lock); the calls are recorded and a failure can be injected.
const mockLockCalls: Array<{ family: string; key: string; mode: string }> = [];
const mockLockFailure: { error: Error | null; notAcquired: boolean } = {
  error: null,
  notAcquired: false,
};
jest.mock("../../common/db-locks", () => ({
  ...jest.requireActual("../../common/db-locks"),
  withAdvisoryLock: async (opts: any, fn: () => Promise<unknown>) => {
    mockLockCalls.push({ family: opts.family, key: opts.key, mode: opts.mode });
    if (mockLockFailure.error) throw mockLockFailure.error;
    if (mockLockFailure.notAcquired) return { acquired: false };
    return { acquired: true, value: await fn() };
  },
}));

import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { LockTimeoutError, LockUnavailableError } from "../../common/db-locks";
import { PickupCompleteService } from "./pickup-complete.service";
import { OrdersService } from "../orders.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { PrismaService } from "../../prisma/prisma.service";
import { createMockPrisma } from "../../testing/prisma-mock";

/**
 * POST /orders/:id/pickup-complete orchestration. Every collaborator is a mock: `changeStatus` (the
 * EXISTING DELIVERED transition: it makes the invoice, moves no stock), `send` and `recordPayment` are
 * spies, so the spec proves WHAT this layer hands them and in what order. No line, tax or total math is
 * derived here: only the payment split (counter-sale-payment.ts) and the change.
 *
 * Time is a counter: a deposit is created at T_DEPOSIT, the hand-over (changeStatus) stamps
 * `deliveredAt` at the next tick, and every payment this request records is created after it.
 */
const staff = { sub: "op-1", role: "OPERATOR", tenantId: "t-1" } as never;
const KEY = "key-1";

const T_DEPOSIT = 500;
const T_DELIVERED = 1000;

type Pay = { id: string; amount: number; method: string; status: string; createdAt: Date };
type Inv = {
  id: string;
  total: number;
  status: string;
  createdAt: Date;
  payments: Pay[];
};

describe("PickupCompleteService.complete", () => {
  let service: PickupCompleteService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let order: any;
  let invoices: Inv[];
  let changeStatus: jest.Mock;
  let decrementStockForSale: jest.Mock;
  let send: jest.Mock;
  let recordPayment: jest.Mock;
  let tick: number;
  const calls: string[] = [];

  const pay = (
    id: string,
    amount: number,
    method = "CASH",
    at = T_DELIVERED + 1,
    status = "PAID",
  ): Pay => ({ id, amount, method, status, createdAt: new Date(at) });
  const inv = (id: string, total: number, status = "DRAFT", payments: Pay[] = [], at = 1): Inv => ({
    id,
    total,
    status,
    createdAt: new Date(2026, 9, 4, 12, 0, at),
    payments,
  });
  const orderRow = (status: string, over: object = {}) => ({
    id: "ord-1",
    orderNumber: "ORD-1",
    status,
    fulfillPath: "PICKUP",
    deliveredAt: status === "DELIVERED" ? new Date(T_DELIVERED) : null,
    customer: { isWalkIn: false },
    ...over,
  });
  const errorOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as any;
    }
    throw new Error("expected a rejection");
  };
  const nothingWritten = () => {
    expect(changeStatus).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(recordPayment).not.toHaveBeenCalled();
  };
  const cash = (amount?: number) =>
    ({ payment: { method: "CASH", ...(amount != null ? { amount } : {}) } }) as never;
  const run = (body: unknown = cash()) => service.complete("ord-1", body as never, staff, KEY);

  beforeEach(async () => {
    calls.length = 0;
    mockLockCalls.length = 0;
    mockLockFailure.error = null;
    mockLockFailure.notAcquired = false;
    tick = T_DELIVERED;
    prisma = createMockPrisma();
    order = orderRow("OUT_FOR_DELIVERY");
    invoices = [inv("inv-1", 37.25)];
    changeStatus = jest.fn(async () => {
      calls.push("changeStatus");
      order = { ...order, status: "DELIVERED", deliveredAt: new Date(T_DELIVERED) };
      return order;
    });
    decrementStockForSale = jest.fn();
    send = jest.fn(async (id: string) => {
      calls.push("send");
      invoices.find((i) => i.id === id)!.status = "SENT";
      return { id };
    });
    recordPayment = jest.fn(async (invoiceId: string, dto: any) => {
      calls.push("recordPayment");
      invoices
        .find((i) => i.id === invoiceId)!
        .payments.push(pay(`pay-${invoiceId}-${++tick}`, dto.amount, dto.method, tick));
      return { id: invoiceId };
    });
    prisma.order.findFirst.mockImplementation(async () => order);
    prisma.invoice.findMany.mockImplementation(async () =>
      invoices.map((i) => ({ ...i, payments: [...i.payments], invoiceNumber: `N-${i.id}` })),
    );

    const mod = await Test.createTestingModule({
      providers: [
        PickupCompleteService,
        { provide: OrdersService, useValue: { changeStatus, decrementStockForSale } },
        { provide: InvoicesService, useValue: { send, recordPayment } },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(PickupCompleteService);
  });

  // ── refusals write nothing ─────────────────────────────────────────────────
  describe("refusals", () => {
    it.each(["ROUTE", "SHIP"])(
      "a %s order is 400 PICKUP_ONLY and nothing is written",
      async (fulfillPath) => {
        order = orderRow("CONFIRMED", { fulfillPath });
        const e = await errorOf(run());
        expect(e.getStatus()).toBe(400);
        expect(e.getResponse().code).toBe("PICKUP_ONLY");
        nothingWritten();
      },
    );
    it.each(["PENDING", "DRAFT", "CANCELLED", "PARTIALLY_DELIVERED"])(
      "a %s pickup order is 409 PICKUP_NOT_READY and nothing is written",
      async (status) => {
        order = orderRow(status);
        const e = await errorOf(run());
        expect(e.getStatus()).toBe(409);
        expect(e.getResponse().code).toBe("PICKUP_NOT_READY");
        nothingWritten();
      },
    );
    it("an order of another tenant (not found under the tenant scope) is 404", async () => {
      order = null;
      const e = await errorOf(run());
      expect(e.getStatus()).toBe(404);
      nothingWritten();
    });
    it("the lookup is tenant-scoped (forTenant) and reads deliveredAt", async () => {
      await run();
      expect(prisma.forTenant).toHaveBeenCalled();
      expect(prisma.order.findFirst.mock.calls[0][0].select).toMatchObject({ deliveredAt: true });
    });
  });

  // ── the hand-over ──────────────────────────────────────────────────────────
  describe("CONFIRMED / OUT_FOR_DELIVERY", () => {
    it.each(["CONFIRMED", "OUT_FOR_DELIVERY"])(
      "%s: changeStatus(DELIVERED) once, no stock call, invoice sent, then the payment",
      async (status) => {
        order = orderRow(status);
        const res = await run();
        expect(changeStatus).toHaveBeenCalledTimes(1);
        expect(changeStatus).toHaveBeenCalledWith("ord-1", { status: "DELIVERED" }, staff);
        expect(decrementStockForSale).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith("inv-1");
        expect(calls).toEqual(["changeStatus", "send", "recordPayment"]);
        expect(recordPayment).toHaveBeenCalledWith(
          "inv-1",
          expect.objectContaining({ amount: 37.25, method: "CASH" }),
        );
        expect(res).toMatchObject({
          orderId: "ord-1",
          orderNumber: "ORD-1",
          invoiceId: "inv-1",
          total: 37.25,
          paid: 37.25,
          balanceDue: 0,
          paymentRecorded: true,
        });
        expect(res.paymentId).toEqual(expect.any(String));
        expect(res.alreadyPickedUp).toBeUndefined();
        expect(res.change).toBeUndefined();
      },
    );
    it("cash over the balance pays the balance and returns the change (response-only)", async () => {
      const res = await run(cash(40));
      expect(recordPayment).toHaveBeenCalledWith(
        "inv-1",
        expect.objectContaining({ amount: 37.25 }),
      );
      expect(res).toMatchObject({
        paid: 37.25,
        balanceDue: 0,
        change: 2.75,
        paymentRecorded: true,
      });
    });
    it("a short cash tender records a partial payment and leaves the rest open", async () => {
      const res = await run(cash(20));
      expect(res).toMatchObject({ paid: 20, balanceDue: 17.25, paymentRecorded: true });
      expect(res.change).toBeUndefined();
    });
    it("a card is mapped to CREDIT_CARD, a check carries its number", async () => {
      await run({ payment: { method: "CARD", reference: "auth9" } });
      expect(recordPayment).toHaveBeenCalledWith(
        "inv-1",
        expect.objectContaining({ method: "CREDIT_CARD", reference: "auth9" }),
      );
    });
    it("only DRAFT invoices are sent; an already-SENT one is not re-sent", async () => {
      invoices = [inv("inv-1", 37.25, "SENT")];
      await run();
      expect(send).not.toHaveBeenCalled();
      expect(recordPayment).toHaveBeenCalledTimes(1);
    });
    it("a mixed regulated order's sibling invoices: all are sent and the payment is spread oldest first", async () => {
      invoices = [inv("inv-1", 30, "DRAFT", [], 1), inv("inv-2", 10, "DRAFT", [], 2)];
      const res = await run();
      expect(send).toHaveBeenCalledTimes(2);
      expect(recordPayment.mock.calls.map((c) => [c[0], c[1].amount])).toEqual([
        ["inv-1", 30],
        ["inv-2", 10],
      ]);
      expect(res).toMatchObject({ invoiceId: "inv-1", total: 40, paid: 40, balanceDue: 0 });
    });
    it("a walk-in's invoice is sent without the INVOICE_SENT message", async () => {
      order = orderRow("CONFIRMED", { customer: { isWalkIn: true } });
      await run();
      expect(send).toHaveBeenCalledWith("inv-1", { suppressNotify: true });
    });
  });

  // ── a deposit paid before the hand-over is never this request's tender ──────
  describe("a deposit made before the hand-over", () => {
    it.each(["CASH", "ADVANCE", "CHECK"])(
      "REQUIRED: a $10 %s deposit on a $50 invoice, CASH $50 tendered: records 40, paid 50, balanceDue 0, change 10; the same-key replay records nothing and answers the same",
      async (depositMethod) => {
        invoices = [inv("inv-1", 50, "SENT", [pay("dep-1", 10, depositMethod, T_DEPOSIT)])];
        const first = await run(cash(50));
        expect(recordPayment).toHaveBeenCalledTimes(1);
        expect(recordPayment).toHaveBeenCalledWith(
          "inv-1",
          expect.objectContaining({ amount: 40, method: "CASH" }),
        );
        expect(first).toMatchObject({
          total: 50,
          paid: 50,
          balanceDue: 0,
          change: 10,
          paymentRecorded: true,
        });
        expect(first.alreadyPickedUp).toBeUndefined();

        const replay = await run(cash(50));
        expect(recordPayment).toHaveBeenCalledTimes(1); // no second payment
        expect(changeStatus).toHaveBeenCalledTimes(1);
        expect(replay).toEqual({ ...first, alreadyPickedUp: true });
      },
    );

    it("a DELIVERED order: the deposit (before deliveredAt) is not the tender, so the balance is still collected", async () => {
      order = orderRow("DELIVERED");
      invoices = [inv("inv-1", 50, "SENT", [pay("dep-1", 10, "CASH", T_DEPOSIT)])];
      const res = await run(cash(50));
      expect(recordPayment).toHaveBeenCalledTimes(1);
      expect(recordPayment).toHaveBeenCalledWith("inv-1", expect.objectContaining({ amount: 40 }));
      expect(res).toMatchObject({ paid: 50, balanceDue: 0, change: 10, alreadyPickedUp: true });
    });

    it("a fully paid invoice (the deposit covered it): nothing is recorded, nothing is owed, paymentRecorded true", async () => {
      invoices = [inv("inv-1", 50, "PAID", [pay("dep-1", 50, "CASH", T_DEPOSIT)])];
      const res = await run(cash(50));
      expect(recordPayment).not.toHaveBeenCalled();
      expect(res).toMatchObject({ paid: 50, balanceDue: 0, paymentRecorded: true });
    });

    it("send() auto-applying a credit (a non-tender payment) is netted from the balance", async () => {
      send.mockImplementation(async (id: string) => {
        invoices.find((i) => i.id === id)!.status = "SENT";
        invoices[0].payments.push(pay("cn-1", 10, "CREDIT_NOTE", T_DELIVERED + 1));
        return { id };
      });
      const res = await run();
      expect(recordPayment).toHaveBeenCalledWith(
        "inv-1",
        expect.objectContaining({ amount: 27.25 }),
      );
      expect(res).toMatchObject({ total: 37.25, paid: 37.25, balanceDue: 0 });
    });
  });

  // ── on account / walk-in ────────────────────────────────────────────────────
  describe("on account", () => {
    it("ON_ACCOUNT records no payment; the invoice stays open for the customer's account", async () => {
      const res = await run({ payment: { method: "ON_ACCOUNT" } });
      expect(changeStatus).toHaveBeenCalledTimes(1);
      expect(recordPayment).not.toHaveBeenCalled();
      expect(res).toMatchObject({
        total: 37.25,
        paid: 0,
        balanceDue: 37.25,
        paymentRecorded: true,
      });
      expect(res.paymentId).toBeUndefined();
    });
    it("no payment object at all means on account for a named customer", async () => {
      const res = await run({});
      expect(recordPayment).not.toHaveBeenCalled();
      expect(res).toMatchObject({ paid: 0, balanceDue: 37.25, paymentRecorded: true });
    });
    it.each([{ payment: { method: "ON_ACCOUNT" } }, {}])(
      "a walk-in on account (%j) is 400 WALK_IN_NO_ACCOUNT before any write",
      async (body) => {
        order = orderRow("CONFIRMED", { customer: { isWalkIn: true } });
        const e = await errorOf(run(body));
        expect(e.getStatus()).toBe(400);
        expect(e.getResponse().code).toBe("WALK_IN_NO_ACCOUNT");
        nothingWritten();
      },
    );
    it("a check without its number is 400 before any write", async () => {
      const e = await errorOf(run({ payment: { method: "CHECK" } }));
      expect(e.getResponse().code).toBe("COUNTER_CHECK_NUMBER_REQUIRED");
      nothingWritten();
    });
    it("a negative amount is 400 before any write", async () => {
      await expect(run(cash(-1))).rejects.toBeInstanceOf(BadRequestException);
      nothingWritten();
    });
  });

  // ── the transition owner: a replay ──────────────────────────────────────────
  describe("a call finding the order already DELIVERED", () => {
    it("this hand-over's full tender is stored: no status write, no send, no second payment: the stored outcome, alreadyPickedUp", async () => {
      order = orderRow("DELIVERED");
      invoices = [inv("inv-1", 37.25, "PAID", [pay("pay-1", 37.25)])];
      const res = await run();
      expect(changeStatus).not.toHaveBeenCalled();
      expect(recordPayment).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(res).toMatchObject({
        orderId: "ord-1",
        invoiceId: "inv-1",
        total: 37.25,
        paid: 37.25,
        balanceDue: 0,
        paymentRecorded: true,
        paymentId: "pay-1",
        alreadyPickedUp: true,
      });
    });
    it("a partial tender of THIS hand-over is not topped up by a replay of the same tender", async () => {
      order = orderRow("DELIVERED");
      invoices = [inv("inv-1", 37.25, "PARTIAL", [pay("pay-1", 20)])];
      const res = await run(cash(20));
      expect(recordPayment).not.toHaveBeenCalled();
      expect(res).toMatchObject({ paid: 20, balanceDue: 17.25, alreadyPickedUp: true });
    });
    it("records only the SHORTFALL of this hand-over's plan (never a second full tender)", async () => {
      order = orderRow("DELIVERED");
      invoices = [inv("inv-1", 37.25, "PARTIAL", [pay("pay-1", 20)])];
      await run(cash(30)); // plan 30, 20 already stored for this hand-over
      expect(recordPayment).toHaveBeenCalledTimes(1);
      expect(recordPayment).toHaveBeenCalledWith("inv-1", expect.objectContaining({ amount: 10 }));
    });
    it("a sibling-invoice first attempt that failed part-way is resumed: only the unpaid sibling is recorded", async () => {
      order = orderRow("DELIVERED");
      invoices = [inv("inv-1", 30, "PAID", [pay("pay-1", 30)], 1), inv("inv-2", 10, "SENT", [], 2)];
      const res = await run();
      expect(recordPayment.mock.calls.map((c) => [c[0], c[1].amount])).toEqual([["inv-2", 10]]);
      expect(res).toMatchObject({ paid: 40, balanceDue: 0, paymentRecorded: true });
    });
    it("a VOIDED tender does not count: the replay records the payment (like the counter sale)", async () => {
      order = orderRow("DELIVERED");
      invoices = [
        inv("inv-1", 37.25, "SENT", [pay("pay-0", 37.25, "CASH", T_DELIVERED + 1, "VOID")]),
      ];
      await run();
      expect(recordPayment).toHaveBeenCalledTimes(1);
    });
    it("a first call whose payment failed is finished by a retry: no status write, one payment", async () => {
      order = orderRow("DELIVERED");
      invoices = [inv("inv-1", 37.25, "SENT")];
      const res = await run();
      expect(changeStatus).not.toHaveBeenCalled();
      expect(recordPayment).toHaveBeenCalledTimes(1);
      expect(res).toMatchObject({ paymentRecorded: true, alreadyPickedUp: true });
    });
    it("a DELIVERED order with no invoice is a 409 pointing at Generate Invoice, not a fabricated figure", async () => {
      order = orderRow("DELIVERED");
      invoices = [];
      const e = await errorOf(run());
      expect(e.getStatus()).toBe(409);
      expect(recordPayment).not.toHaveBeenCalled();
    });
    it("a DELIVERED order whose deliveredAt is unknown treats every stored tender as this hand-over's (never collects twice)", async () => {
      order = orderRow("DELIVERED", { deliveredAt: null });
      invoices = [inv("inv-1", 37.25, "PAID", [pay("pay-1", 37.25, "CASH", T_DEPOSIT)])];
      await run();
      expect(recordPayment).not.toHaveBeenCalled();
    });
    it("the race loser (changeStatus refuses because a concurrent call just delivered it) continues as the replay", async () => {
      changeStatus.mockImplementation(async () => {
        order = { ...order, status: "DELIVERED", deliveredAt: new Date(T_DELIVERED) };
        invoices = [inv("inv-1", 37.25, "PAID", [pay("pay-1", 37.25)])];
        throw new BadRequestException("Invalid status transition");
      });
      const res = await run();
      expect(recordPayment).not.toHaveBeenCalled();
      expect(res).toMatchObject({ paid: 37.25, alreadyPickedUp: true, paymentRecorded: true });
    });
  });

  // ── the tender step is serialised on the order ─────────────────────────────
  describe("the counter-tender advisory lock", () => {
    it("the payment runs under the shared counter-tender lock keyed on the order, in wait mode", async () => {
      await run();
      expect(mockLockCalls).toEqual([{ family: "counter-tender", key: "ord-1", mode: "wait" }]);
    });
    it("ON_ACCOUNT takes no money and no lock", async () => {
      await run({ payment: { method: "ON_ACCOUNT" } });
      expect(mockLockCalls).toEqual([]);
    });
    it.each([
      ["a lock timeout", () => new LockTimeoutError("counter-tender", "ord-1", 20000)],
      ["an unavailable lock", () => new LockUnavailableError(new Error("conn"))],
    ])("%s: the hand-over stands, paymentRecorded false, nothing recorded", async (_n, make) => {
      mockLockFailure.error = make();
      const res = await run();
      expect(order.status).toBe("DELIVERED");
      expect(recordPayment).not.toHaveBeenCalled();
      expect(res).toMatchObject({
        paymentRecorded: false,
        paymentErrorCode: "COUNTER_PAYMENT_NOT_RECORDED",
        paid: 0,
        balanceDue: 37.25,
      });
    });
    it("a lock that is not acquired reads as an unrecorded payment too", async () => {
      mockLockFailure.notAcquired = true;
      const res = await run();
      expect(recordPayment).not.toHaveBeenCalled();
      expect(res).toMatchObject({ paymentRecorded: false });
    });
  });

  // ── never over-collects ─────────────────────────────────────────────────────
  describe("over-collection", () => {
    it.each(["CARD", "CHECK"])(
      "%s above the balance is refused as a 200 body, the order is still handed over",
      async (method) => {
        const res = await run({ payment: { method, amount: 50, reference: "r1" } });
        expect(changeStatus).toHaveBeenCalledTimes(1);
        expect(recordPayment).not.toHaveBeenCalled();
        expect(res).toMatchObject({
          paymentRecorded: false,
          paymentErrorCode: "COUNTER_PAYMENT_EXCEEDS_TOTAL",
          paid: 0,
          balanceDue: 37.25,
        });
      },
    );
    it("change comes only from stored figures: a partial stored tender while money is owed has NO change", async () => {
      const res = await run(cash(20));
      expect(res.change).toBeUndefined();
      expect(res.balanceDue).toBe(17.25);
    });
  });

  // ── failures after the hand-over ────────────────────────────────────────────
  describe("payment failure", () => {
    it("recordPayment throwing leaves the order DELIVERED with an open invoice and answers paymentRecorded:false", async () => {
      recordPayment.mockRejectedValue(new Error("boom"));
      const res = await run();
      expect(order.status).toBe("DELIVERED");
      expect(res).toMatchObject({
        paymentRecorded: false,
        paymentErrorCode: "COUNTER_PAYMENT_NOT_RECORDED",
        paid: 0,
        balanceDue: 37.25,
      });
      expect(res.paymentId).toBeUndefined();
    });
    it("changeStatus failing (e.g. the invoice could not be created) propagates and no payment is attempted", async () => {
      changeStatus.mockRejectedValue(new Error("invoice failed"));
      await expect(run()).rejects.toThrow("invoice failed");
      expect(recordPayment).not.toHaveBeenCalled();
    });
  });
});
