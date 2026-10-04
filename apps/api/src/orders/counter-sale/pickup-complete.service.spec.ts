// OrdersService / InvoicesService pull ESM-only modules (@react-pdf/renderer, expo-server-sdk)
// Jest's CommonJS parser cannot load; this spec drives them through mocks at the module boundary.
jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));

import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PickupCompleteService } from "./pickup-complete.service";
import { OrdersService } from "../orders.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { PrismaService } from "../../prisma/prisma.service";
import { createMockPrisma } from "../../testing/prisma-mock";

/**
 * POST /orders/:id/pickup-complete orchestration (SA-655 item 11). Every collaborator is a mock:
 * `changeStatus` (the EXISTING DELIVERED transition: it makes the invoice, moves no stock), `send` and
 * `recordPayment` are spies, so the spec proves WHAT this layer hands them and in what order. No line,
 * tax or total math is derived here: only the payment split (counter-sale-payment.ts) and the change.
 */
const staff = { sub: "op-1", role: "OPERATOR", tenantId: "t-1" } as never;

type Inv = { id: string; total: number; status: string; createdAt: Date; payments: any[] };

describe("PickupCompleteService.complete", () => {
  let service: PickupCompleteService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let order: any;
  let invoices: Inv[];
  let changeStatus: jest.Mock;
  let decrementStockForSale: jest.Mock;
  let send: jest.Mock;
  let recordPayment: jest.Mock;
  const calls: string[] = [];

  const inv = (id: string, total: number, status = "DRAFT", payments: any[] = [], at = 1): Inv => ({
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

  beforeEach(async () => {
    calls.length = 0;
    prisma = createMockPrisma();
    order = orderRow("OUT_FOR_DELIVERY");
    invoices = [inv("inv-1", 37.25)];
    changeStatus = jest.fn(async () => {
      calls.push("changeStatus");
      order = { ...order, status: "DELIVERED" };
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
        .payments.push({
          id: `pay-${invoiceId}`,
          amount: dto.amount,
          method: dto.method,
          status: "PAID",
        });
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

  // ── 11a. refusals write nothing ─────────────────────────────────────────────
  describe("11a refusals", () => {
    it.each(["ROUTE", "SHIP"])(
      "a %s order is 400 PICKUP_ONLY and nothing is written",
      async (fulfillPath) => {
        order = orderRow("CONFIRMED", { fulfillPath });
        const e = await errorOf(
          service.complete("ord-1", { payment: { method: "CASH" } } as never, staff),
        );
        expect(e.getStatus()).toBe(400);
        expect(e.getResponse().code).toBe("PICKUP_ONLY");
        nothingWritten();
      },
    );
    it.each(["PENDING", "DRAFT", "CANCELLED"])(
      "a %s pickup order is 409 PICKUP_NOT_READY and nothing is written",
      async (status) => {
        order = orderRow(status);
        const e = await errorOf(
          service.complete("ord-1", { payment: { method: "CASH" } } as never, staff),
        );
        expect(e.getStatus()).toBe(409);
        expect(e.getResponse().code).toBe("PICKUP_NOT_READY");
        nothingWritten();
      },
    );
    it("an order of another tenant (not found under the tenant scope) is 404", async () => {
      order = null;
      const e = await errorOf(
        service.complete("ord-x", { payment: { method: "CASH" } } as never, staff),
      );
      expect(e.getStatus()).toBe(404);
      nothingWritten();
    });
    it("the lookup is tenant-scoped (forTenant)", async () => {
      await service.complete("ord-1", { payment: { method: "CASH" } } as never, staff);
      expect(prisma.forTenant).toHaveBeenCalled();
    });
  });

  // ── 11b. the hand-over ──────────────────────────────────────────────────────
  describe("11b CONFIRMED / OUT_FOR_DELIVERY", () => {
    it.each(["CONFIRMED", "OUT_FOR_DELIVERY"])(
      "%s: changeStatus(DELIVERED) once, no stock call, invoice sent, then the payment",
      async (status) => {
        order = orderRow(status);
        const res = await service.complete(
          "ord-1",
          { payment: { method: "CASH" } } as never,
          staff,
        );
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
          paymentId: "pay-inv-1",
        });
        expect(res.alreadyPickedUp).toBeUndefined();
        expect(res.change).toBeUndefined();
      },
    );
    it("cash over the balance pays the balance and returns the change (response-only)", async () => {
      const res = await service.complete(
        "ord-1",
        { payment: { method: "CASH", amount: 40 } } as never,
        staff,
      );
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
      const res = await service.complete(
        "ord-1",
        { payment: { method: "CASH", amount: 20 } } as never,
        staff,
      );
      expect(res).toMatchObject({ paid: 20, balanceDue: 17.25, paymentRecorded: true });
      expect(res.change).toBeUndefined();
    });
    it("a card is mapped to CREDIT_CARD, a check carries its number", async () => {
      await service.complete(
        "ord-1",
        { payment: { method: "CARD", reference: "auth9" } } as never,
        staff,
      );
      expect(recordPayment).toHaveBeenCalledWith(
        "inv-1",
        expect.objectContaining({ method: "CREDIT_CARD", reference: "auth9" }),
      );
    });
    it("only DRAFT invoices are sent; an already-SENT one is not re-sent", async () => {
      invoices = [inv("inv-1", 37.25, "SENT")];
      await service.complete("ord-1", { payment: { method: "CASH" } } as never, staff);
      expect(send).not.toHaveBeenCalled();
      expect(recordPayment).toHaveBeenCalledTimes(1);
    });
    it("a mixed regulated order's sibling invoices: all are sent and the payment is spread oldest first", async () => {
      invoices = [inv("inv-1", 30, "DRAFT", [], 1), inv("inv-2", 10, "DRAFT", [], 2)];
      const res = await service.complete("ord-1", { payment: { method: "CASH" } } as never, staff);
      expect(send).toHaveBeenCalledTimes(2);
      expect(recordPayment.mock.calls.map((c) => [c[0], c[1].amount])).toEqual([
        ["inv-1", 30],
        ["inv-2", 10],
      ]);
      expect(res).toMatchObject({ invoiceId: "inv-1", total: 40, paid: 40, balanceDue: 0 });
    });
    it("a walk-in's invoice is sent without the INVOICE_SENT message", async () => {
      order = orderRow("CONFIRMED", { customer: { isWalkIn: true } });
      await service.complete("ord-1", { payment: { method: "CASH" } } as never, staff);
      expect(send).toHaveBeenCalledWith("inv-1", { suppressNotify: true });
    });
  });

  // ── 11c. on account / walk-in ───────────────────────────────────────────────
  describe("11c on account", () => {
    it("ON_ACCOUNT records no payment; the invoice stays open for the customer's account", async () => {
      const res = await service.complete(
        "ord-1",
        { payment: { method: "ON_ACCOUNT" } } as never,
        staff,
      );
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
      const res = await service.complete("ord-1", {} as never, staff);
      expect(recordPayment).not.toHaveBeenCalled();
      expect(res).toMatchObject({ paid: 0, balanceDue: 37.25, paymentRecorded: true });
    });
    it.each([{ payment: { method: "ON_ACCOUNT" } }, {}])(
      "a walk-in on account (%j) is 400 WALK_IN_NO_ACCOUNT before any write",
      async (body) => {
        order = orderRow("CONFIRMED", { customer: { isWalkIn: true } });
        const e = await errorOf(service.complete("ord-1", body as never, staff));
        expect(e.getStatus()).toBe(400);
        expect(e.getResponse().code).toBe("WALK_IN_NO_ACCOUNT");
        nothingWritten();
      },
    );
    it("a check without its number is 400 before any write", async () => {
      const e = await errorOf(
        service.complete("ord-1", { payment: { method: "CHECK" } } as never, staff),
      );
      expect(e.getResponse().code).toBe("COUNTER_CHECK_NUMBER_REQUIRED");
      nothingWritten();
    });
    it("a negative amount is 400 before any write", async () => {
      await expect(
        service.complete("ord-1", { payment: { method: "CASH", amount: -1 } } as never, staff),
      ).rejects.toBeInstanceOf(BadRequestException);
      nothingWritten();
    });
  });

  // ── 11d. idempotent ─────────────────────────────────────────────────────────
  describe("11d a second call", () => {
    it("on a DELIVERED order writes no status, sends nothing, records no second payment: same figures, alreadyPickedUp", async () => {
      order = orderRow("DELIVERED");
      invoices = [
        inv("inv-1", 37.25, "PAID", [
          { id: "pay-1", amount: 37.25, method: "CASH", status: "PAID" },
        ]),
      ];
      const res = await service.complete("ord-1", { payment: { method: "CASH" } } as never, staff);
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
    it("a prior PARTIAL payment is not topped up by a replay", async () => {
      order = orderRow("DELIVERED");
      invoices = [
        inv("inv-1", 37.25, "PARTIAL", [
          { id: "pay-1", amount: 20, method: "CASH", status: "PAID" },
        ]),
      ];
      const res = await service.complete("ord-1", { payment: { method: "CASH" } } as never, staff);
      expect(recordPayment).not.toHaveBeenCalled();
      expect(res).toMatchObject({ paid: 20, balanceDue: 17.25, alreadyPickedUp: true });
    });
    it("a VOIDED tender does not count: a replay records the payment (like the counter sale)", async () => {
      order = orderRow("DELIVERED");
      invoices = [
        inv("inv-1", 37.25, "SENT", [
          { id: "pay-0", amount: 37.25, method: "CASH", status: "VOID" },
        ]),
      ];
      await service.complete("ord-1", { payment: { method: "CASH" } } as never, staff);
      expect(recordPayment).toHaveBeenCalledTimes(1);
    });
    it("a first call whose payment failed is finished by a retry: no status write, one payment", async () => {
      order = orderRow("DELIVERED");
      invoices = [inv("inv-1", 37.25, "SENT")];
      const res = await service.complete("ord-1", { payment: { method: "CASH" } } as never, staff);
      expect(changeStatus).not.toHaveBeenCalled();
      expect(recordPayment).toHaveBeenCalledTimes(1);
      expect(res).toMatchObject({ paymentRecorded: true, alreadyPickedUp: true });
    });
    it("a DELIVERED order with no invoice is a 409 pointing at Generate Invoice, not a fabricated figure", async () => {
      order = orderRow("DELIVERED");
      invoices = [];
      const e = await errorOf(
        service.complete("ord-1", { payment: { method: "CASH" } } as never, staff),
      );
      expect(e.getStatus()).toBe(409);
      expect(recordPayment).not.toHaveBeenCalled();
    });
  });

  // ── 11e. never over-collects ────────────────────────────────────────────────
  describe("11e over-collection", () => {
    it.each(["CARD", "CHECK"])(
      "%s above the balance is refused as a 200 body, the order is still handed over",
      async (method) => {
        const res = await service.complete(
          "ord-1",
          { payment: { method, amount: 50, reference: "r1" } } as never,
          staff,
        );
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
    it("the payment never exceeds the post-send balance (credit auto-applied by send is netted)", async () => {
      send.mockImplementation(async (id: string) => {
        invoices.find((i) => i.id === id)!.status = "SENT";
        invoices[0].payments.push({
          id: "cn-1",
          amount: 10,
          method: "CREDIT_NOTE",
          status: "PAID",
        });
        return { id };
      });
      const res = await service.complete("ord-1", { payment: { method: "CASH" } } as never, staff);
      expect(recordPayment).toHaveBeenCalledWith(
        "inv-1",
        expect.objectContaining({ amount: 27.25 }),
      );
      expect(res).toMatchObject({ total: 37.25, paid: 37.25, balanceDue: 0 });
    });
  });

  // ── 11f. failures after the hand-over ───────────────────────────────────────
  describe("11f payment failure", () => {
    it("recordPayment throwing leaves the order DELIVERED with an open invoice and answers paymentRecorded:false", async () => {
      recordPayment.mockRejectedValue(new Error("boom"));
      const res = await service.complete("ord-1", { payment: { method: "CASH" } } as never, staff);
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
      await expect(
        service.complete("ord-1", { payment: { method: "CASH" } } as never, staff),
      ).rejects.toThrow("invoice failed");
      expect(recordPayment).not.toHaveBeenCalled();
    });
  });
});
