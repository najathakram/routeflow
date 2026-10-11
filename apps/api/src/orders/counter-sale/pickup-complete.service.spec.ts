// OrdersService / InvoicesService pull ESM-only modules (@react-pdf/renderer, expo-server-sdk)
// Jest's CommonJS parser cannot load; this spec drives them through mocks at the module boundary.
jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));

// The invoice settle shared with changeStatus(DELIVERED): the repair path of a DELIVERED order with no
// invoice. A stand-in so the spec drives WHAT the repair does to the stored invoices.
const mockSettle = jest.fn();
jest.mock("../order-status-invoicing", () => ({
  settleOrderInvoice: (...a: unknown[]) => mockSettle(...a),
}));
// The tenant's send-time credit sweep switch (the walk-in open-credit guard asks it).
const mockSweepOn = { on: false };
jest.mock("../../credit-notes/auto-apply-candidates", () => ({
  ...jest.requireActual("../../credit-notes/auto-apply-candidates"),
  creditAutoApplyOnSend: async () => mockSweepOn.on,
}));

// The shared Postgres advisory lock becomes an in-process stand-in with the same contract (fn never
// runs without the lock); the calls are recorded and a failure can be injected.
const mockLockCalls: Array<{ family: string; key: string; mode: string }> = [];
const mockLockFailure: { error: Error | null; notAcquired: boolean; claimError: Error | null } = {
  error: null,
  notAcquired: false,
  claimError: null,
};
jest.mock("../../common/db-locks", () => ({
  ...jest.requireActual("../../common/db-locks"),
  withAdvisoryLock: async (opts: any, fn: () => Promise<unknown>) => {
    mockLockCalls.push({ family: opts.family, key: opts.key, mode: opts.mode });
    // The first lock is the hand-over claim section: injected failures target the tender's lock.
    const isClaim = mockLockCalls.length === 1;
    if (isClaim && mockLockFailure.claimError) throw mockLockFailure.claimError;
    if (!isClaim && mockLockFailure.error) throw mockLockFailure.error;
    if (!isClaim && mockLockFailure.notAcquired) return { acquired: false };
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
    customerId: "cust-1",
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
  const run = (body: unknown = cash(), key = KEY) =>
    service.complete("ord-1", body as never, staff, key);
  let claims: any[];

  beforeEach(async () => {
    calls.length = 0;
    claims = [];
    mockSettle.mockReset();
    mockSweepOn.on = false;
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
    prisma.auditLog.findFirst.mockImplementation(async () => claims[0] ?? null);
    prisma.auditLog.create.mockImplementation(async ({ data }: any) => {
      calls.push("claim");
      claims.push(data);
      return data;
    });
    prisma.creditNote.findMany.mockResolvedValue([]);
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
        expect(calls).toEqual(["claim", "changeStatus", "send", "recordPayment"]);
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
    // Nothing owed (the deposit covered it): the till takes no money, so there is nothing to refuse.
    describe("balance already 0", () => {
      const deposit = (amount: number) => pay("dep-1", amount, "CASH", T_DEPOSIT);
      const walkIn = () => {
        order = orderRow("CONFIRMED", { customer: { isWalkIn: true } });
      };
      it("a walk-in with nothing owed and no payment completes (was 400 WALK_IN_NO_ACCOUNT)", async () => {
        walkIn();
        invoices = [inv("inv-1", 37.25, "DRAFT", [deposit(37.25)])];
        const res = await run({});
        expect(changeStatus).toHaveBeenCalledTimes(1);
        expect(recordPayment).not.toHaveBeenCalled();
        expect(res).toMatchObject({
          total: 37.25,
          paid: 37.25,
          balanceDue: 0,
          paymentRecorded: true,
        });
        expect(res.paymentId).toBeUndefined();
      });
      it("a CASH payment sent while nothing is owed is ignored: no recordPayment", async () => {
        invoices = [inv("inv-1", 37.25, "DRAFT", [deposit(37.25)])];
        const res = await run(cash(50));
        expect(changeStatus).toHaveBeenCalledTimes(1);
        expect(recordPayment).not.toHaveBeenCalled();
        expect(res).toMatchObject({ paid: 37.25, balanceDue: 0, paymentRecorded: true });
      });
      it("a VOID / WRITTEN_OFF invoice is not part of the balance", async () => {
        walkIn();
        invoices = [
          inv("inv-1", 37.25, "DRAFT", [deposit(37.25)]),
          inv("inv-void", 20, "VOID", [], 2),
          inv("inv-wo", 15, "WRITTEN_OFF", [], 3),
        ];
        prisma.invoice.findMany.mockImplementation(async (args: any) => {
          const out = args?.where?.status?.notIn ?? [];
          return invoices
            .filter((i) => !out.includes(i.status))
            .map((i) => ({ ...i, payments: [...i.payments], invoiceNumber: `N-${i.id}` }));
        });
        const res = await run({});
        expect(recordPayment).not.toHaveBeenCalled();
        expect(res).toMatchObject({ total: 37.25, balanceDue: 0, paymentRecorded: true });
      });
      it("control: a walk-in who still owes money with no payment is refused as before", async () => {
        walkIn();
        invoices = [inv("inv-1", 37.25, "DRAFT", [deposit(10)])];
        const e = await errorOf(run({}));
        expect(e.getResponse().code).toBe("WALK_IN_NO_ACCOUNT");
        nothingWritten();
      });
    });
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
      // the claim section, then the tender, both under the per-order lock (never nested)
      expect(mockLockCalls).toEqual([
        { family: "counter-tender", key: "ord-1", mode: "wait" },
        { family: "counter-tender", key: "ord-1", mode: "wait" },
      ]);
    });
    it("ON_ACCOUNT takes no money and no lock", async () => {
      await run({ payment: { method: "ON_ACCOUNT" } });
      expect(mockLockCalls).toHaveLength(1); // the claim only: no tender lock
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
  // ── the invoices final AFTER the hand-over decide what is owed ─────────────
  describe("a remainder / rebuild appearing at DELIVERED", () => {
    // Before changeStatus: one fully paid invoice. After: it plus a new unpaid remainder invoice.
    const remainderAtDelivery = () => {
      invoices = [inv("inv-1", 37.25, "SENT", [pay("dep-1", 37.25, "CASH", T_DEPOSIT)])];
      changeStatus.mockImplementation(async () => {
        calls.push("changeStatus");
        order = { ...order, status: "DELIVERED", deliveredAt: new Date(T_DELIVERED) };
        invoices.push(inv("inv-2", 12.5, "DRAFT", [], 2));
        return order;
      });
    };
    it("(a) CASH sent: the tender IS recorded against the remainder", async () => {
      remainderAtDelivery();
      const res = await run(cash());
      expect(recordPayment).toHaveBeenCalledWith(
        "inv-2",
        expect.objectContaining({ amount: 12.5, method: "CASH" }),
      );
      expect(res).toMatchObject({ balanceDue: 0, paymentRecorded: true });
    });
    it("(b) a walk-in, NO payment: 200, paymentRecorded false + PICKUP_PAYMENT_REQUIRED, no row", async () => {
      order = orderRow("CONFIRMED", { customer: { isWalkIn: true } });
      remainderAtDelivery();
      const res = await run({});
      expect(recordPayment).not.toHaveBeenCalled();
      expect(res).toMatchObject({
        balanceDue: 12.5,
        paymentRecorded: false,
        paymentErrorCode: "PICKUP_PAYMENT_REQUIRED",
      });
    });
    it("(b2) a named customer, NO payment, fully paid before: same PICKUP_PAYMENT_REQUIRED", async () => {
      remainderAtDelivery();
      const res = await run({});
      expect(recordPayment).not.toHaveBeenCalled();
      expect(res).toMatchObject({
        paymentRecorded: false,
        paymentErrorCode: "PICKUP_PAYMENT_REQUIRED",
      });
    });
  });

  describe("owed / excused judged on the final invoices", () => {
    it("(c) truly nothing owed + no payment (walk-in): 200, no row, recorded", async () => {
      order = orderRow("CONFIRMED", { customer: { isWalkIn: true } });
      invoices = [inv("inv-1", 37.25, "SENT", [pay("dep-1", 37.25, "CASH", T_DEPOSIT)])];
      const res = await run({});
      expect(recordPayment).not.toHaveBeenCalled();
      expect(res).toMatchObject({ balanceDue: 0, paymentRecorded: true });
    });
    it("(d) a named customer owing + no payment: unchanged, on account and settled", async () => {
      const res = await run({});
      expect(recordPayment).not.toHaveBeenCalled();
      expect(res).toMatchObject({ balanceDue: 37.25, paymentRecorded: true });
      expect(res.paymentErrorCode).toBeUndefined();
    });
    it("(e) a walk-in owing + no payment: 400 WALK_IN_NO_ACCOUNT before any write", async () => {
      order = orderRow("CONFIRMED", { customer: { isWalkIn: true } });
      const e = await errorOf(run({}));
      expect(e.getStatus()).toBe(400);
      expect(e.getResponse().code).toBe("WALK_IN_NO_ACCOUNT");
      nothingWritten();
    });
    it("(f) nothing owed + CASH sent: no row", async () => {
      invoices = [inv("inv-1", 37.25, "SENT", [pay("dep-1", 37.25, "CASH", T_DEPOSIT)])];
      const res = await run(cash());
      expect(recordPayment).not.toHaveBeenCalled();
      expect(res).toMatchObject({ balanceDue: 0, paymentRecorded: true });
    });
    it("a replay with CASH sent and money owed tenders (finishes a PICKUP_PAYMENT_REQUIRED)", async () => {
      order = orderRow("DELIVERED");
      invoices = [inv("inv-1", 37.25, "SENT", [pay("dep-1", 25, "CASH", T_DEPOSIT)])];
      const res = await run(cash());
      expect(recordPayment).toHaveBeenCalledWith(
        "inv-1",
        expect.objectContaining({ amount: 12.25, method: "CASH" }),
      );
      expect(res).toMatchObject({ balanceDue: 0, paymentRecorded: true, alreadyPickedUp: true });
    });
  });

  // ── L1: the hand-over key is persisted (AuditLog claim row), one key per order ──
  describe("the Idempotency-Key claim", () => {
    it("writes the claim BEFORE the hand-over, and a different key on a completed order is 409 with no money", async () => {
      await run(cash(), "key-1");
      expect(calls.indexOf("claim")).toBeLessThan(calls.indexOf("changeStatus"));
      expect(claims[0]).toMatchObject({
        action: "PICKUP_COMPLETE_CLAIM",
        entityType: "Order",
        entityId: "ord-1",
        meta: { idempotencyKey: "key-1" },
      });
      const paid = recordPayment.mock.calls.length;
      const e = await errorOf(run({ payment: { method: "CARD", amount: 100 } }, "key-2"));
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse().code).toBe("PICKUP_KEY_CONFLICT");
      expect(recordPayment).toHaveBeenCalledTimes(paid);
      expect(changeStatus).toHaveBeenCalledTimes(1);
    });
    it("a retry that ADDS the payment adopts it on the claim, so a later different payment under that key is 409", async () => {
      claims.push({ id: "claim-1", meta: { idempotencyKey: "key-1", bodyHash: null } });
      prisma.auditLog.update.mockImplementation(async ({ data }: any) => {
        claims[0] = { ...claims[0], ...data };
        return claims[0];
      });
      await run(cash(), "key-1");
      expect((claims[0].meta as { bodyHash?: string }).bodyHash).toEqual(expect.any(String));
      const paid = recordPayment.mock.calls.length;
      const e = await errorOf(run({ payment: { method: "CARD", amount: 100 } }, "key-1"));
      expect(e.getResponse().code).toBe("PICKUP_KEY_CONFLICT");
      expect(recordPayment).toHaveBeenCalledTimes(paid);
    });
    it("a claim lock outage is a coded 503 LOCK_UNAVAILABLE before any write", async () => {
      mockLockFailure.claimError = new LockUnavailableError(new Error("conn"));
      try {
        const e = await errorOf(run(cash(), "key-1"));
        expect(e.getStatus()).toBe(503);
        expect(e.getResponse().code).toBe("LOCK_UNAVAILABLE");
        nothingWritten();
      } finally {
        mockLockFailure.claimError = null;
      }
    });
    it("liveness: a walk-in short found AFTER the hand-over -> a corrected retry under a NEW key records once", async () => {
      prisma.auditLog.update.mockImplementation(async ({ data }: any) => {
        claims[0] = { ...claims[0], ...data };
        return claims[0];
      });
      order = orderRow("CONFIRMED", { customer: { isWalkIn: true } });
      invoices = [inv("inv-1", 20, "SENT", [])];
      changeStatus.mockImplementation(async () => {
        calls.push("changeStatus");
        order = { ...order, status: "DELIVERED", deliveredAt: new Date(T_DELIVERED) };
        invoices.push(inv("inv-2", 12.5, "DRAFT", [], 2));
        return order;
      });
      const first = await run({ payment: { method: "CASH", amount: 20 } }, "key-1");
      expect(first).toMatchObject({
        paymentRecorded: false,
        paymentErrorCode: "COUNTER_TENDER_SHORT",
      });
      expect(recordPayment).not.toHaveBeenCalled();
      const res = await run({ payment: { method: "CASH", amount: 32.5 } }, "key-2");
      expect(res).toMatchObject({ paymentRecorded: true, balanceDue: 0 });
      const taken = recordPayment.mock.calls.reduce(
        (t: number, c: any[]) => t + Number(c[1].amount),
        0,
      );
      expect(taken).toBe(32.5);
      expect(changeStatus).toHaveBeenCalledTimes(1);
    });
    it("liveness: claim -> changeStatus REFUSES -> a retry with a NEW key hands over and tenders once", async () => {
      prisma.auditLog.update.mockImplementation(async ({ data }: any) => {
        claims[0] = { ...claims[0], ...data };
        return claims[0];
      });
      const real = changeStatus.getMockImplementation()!;
      changeStatus.mockRejectedValueOnce(
        Object.assign(new Error("refused"), { getStatus: () => 409 }),
      );
      await expect(run(cash(), "key-1")).rejects.toThrow("refused");
      expect(claims).toHaveLength(1);
      changeStatus.mockImplementation(real);
      const res = await run(cash(), "key-2");
      expect(order.status).toBe("DELIVERED");
      expect(res).toMatchObject({ paymentRecorded: true, balanceDue: 0 });
      expect(invoices[0].payments).toHaveLength(1);
      expect(claims).toHaveLength(1);
      expect((claims[0].meta as { idempotencyKey?: string }).idempotencyKey).toBe("key-2");
    });
  });

  describe("a crash between the claim and the hand-over", () => {
    it("a same-key retry completes the hand-over: DELIVERED, invoice, ONE payment row", async () => {
      const real = changeStatus.getMockImplementation()!;
      changeStatus.mockRejectedValueOnce(new Error("process died"));
      await expect(run(cash())).rejects.toThrow("process died");
      expect(claims).toHaveLength(1);
      changeStatus.mockImplementation(real);
      const res = await run(cash());
      expect(order.status).toBe("DELIVERED");
      expect(res).toMatchObject({ paymentRecorded: true, balanceDue: 0 });
      expect(invoices[0].payments).toHaveLength(1);
      expect(claims).toHaveLength(1);
    });
    it("the same key with a different payment is 409 PICKUP_KEY_CONFLICT", async () => {
      await run(cash());
      const e = await errorOf(run({ payment: { method: "CARD", amount: 5 } }));
      expect(e.getResponse().code).toBe("PICKUP_KEY_CONFLICT");
    });
  });

  // ── L4: a post-commit failure is a coded 200; the SAME-key retry finishes it once ──
  describe("a same-key retry after a post-commit tender failure", () => {
    it("completes the payment exactly once", async () => {
      const real = recordPayment.getMockImplementation()!;
      recordPayment.mockRejectedValueOnce(new Error("db blip"));
      const first = await run(cash());
      expect(first).toMatchObject({
        paymentRecorded: false,
        paymentErrorCode: "COUNTER_PAYMENT_NOT_RECORDED",
      });
      recordPayment.mockImplementation(real);
      const second = await run(cash());
      expect(second).toMatchObject({ paymentRecorded: true, balanceDue: 0, alreadyPickedUp: true });
      expect(invoices[0].payments).toHaveLength(1);
      expect(changeStatus).toHaveBeenCalledTimes(1);
    });
  });

  // ── L2: a walk-in cannot leave a partial or take credit ──
  describe("a walk-in", () => {
    beforeEach(() => {
      order = orderRow("CONFIRMED", { customer: { isWalkIn: true } });
    });
    it.each(["CASH", "CARD", "CHECK"])(
      "a %s tender below the owed balance is 400 COUNTER_TENDER_SHORT before any write",
      async (method) => {
        const e = await errorOf(run({ payment: { method, amount: 20, reference: "1001" } }));
        expect(e.getStatus()).toBe(400);
        expect(e.getResponse().code).toBe("COUNTER_TENDER_SHORT");
        nothingWritten();
      },
    );
    it("open credit with the sweep on is 409 WALK_IN_OPEN_CREDIT before any write", async () => {
      mockSweepOn.on = true;
      prisma.creditNote.findMany.mockResolvedValue([{ amount: 10, amountUsed: 0 }]);
      const e = await errorOf(run());
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse().code).toBe("WALK_IN_OPEN_CREDIT");
      nothingWritten();
    });
    it("a full CASH tender still completes", async () => {
      const res = await run(cash(37.25));
      expect(res).toMatchObject({ balanceDue: 0, paymentRecorded: true });
    });
  });

  // ── L3: a DELIVERED order with no invoice is repaired, never stranded ──
  describe("a DELIVERED order with no invoice", () => {
    beforeEach(() => {
      order = orderRow("DELIVERED");
      invoices = [];
      claims.push({ meta: { idempotencyKey: KEY } });
    });
    it("the same-key retry creates the invoice through the shared settle and records the tender", async () => {
      mockSettle.mockImplementation(async () => {
        invoices.push(inv("inv-1", 37.25));
      });
      const res = await run(cash());
      expect(mockSettle).toHaveBeenCalledTimes(1);
      expect(recordPayment).toHaveBeenCalledWith(
        "inv-1",
        expect.objectContaining({ amount: 37.25, method: "CASH" }),
      );
      expect(res).toMatchObject({ paymentRecorded: true, balanceDue: 0 });
    });
    it("a repair that creates nothing is a coded 409 PICKUP_INVOICE_MISSING", async () => {
      mockSettle.mockResolvedValue(undefined);
      const e = await errorOf(run(cash()));
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse().code).toBe("PICKUP_INVOICE_MISSING");
    });
  });
});
