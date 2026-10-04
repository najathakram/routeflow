// OrdersService / InvoicesService pull ESM-only modules (@react-pdf/renderer, expo-server-sdk)
// Jest's CommonJS parser cannot load; this spec drives them through mocks at the module boundary.
jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));

import { ConflictException, BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { CounterSaleService } from "./counter-sale.service";
import { WalkInCustomerService } from "./walk-in-customer";
import { FULFILMENT_CAPABILITY_READER } from "./fulfilment-capability-reader";
import type { FulfilmentCapability } from "./capability-shape";
import { OrdersService } from "../orders.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { PrismaService } from "../../prisma/prisma.service";
import { createMockPrisma } from "../../testing/prisma-mock";

/**
 * POST /orders/counter-sale orchestration (SA-655, item C step 2). Every collaborator is a mock:
 * `createSale` (the prod-proven create -> DELIVERED -> invoice -> send) and `recordPayment` are
 * spies, so the spec proves WHAT the counter-sale layer hands them and in what order. The money
 * itself (line math, tax, totals) stays in create()/@routeflow/pricing; no number is derived here
 * except the payment split and the change.
 *
 * (f) Staff oversell is allowed by policy (oversell-policy.ts: resolveOversellAllowed is true for
 * OPERATOR/TENANT_ADMIN), so there is deliberately NO staff stock-refusal case: the stock is
 * decremented once, inside create(), and this layer touches no stock.
 */

// The exact #3188 deriveFulfilmentCapability shape.
const cap = (counter: "always" | "optional" | "off", over: Partial<FulfilmentCapability> = {}) =>
  ({
    methods: counter === "always" ? ["PICKUP", "SHIP"] : ["ROUTE", "SHIP"],
    staffDefault: counter === "always" ? "PICKUP" : "ROUTE",
    staffOpensAs: counter === "always" ? "counter" : "order",
    portalMethods: [],
    portalDefault: null,
    counter,
    fleet: true,
    consistent: true,
    ...over,
  }) as FulfilmentCapability;

const staff = { sub: "op-1", role: "OPERATOR", tenantId: "t-1" } as never;
const item = { productId: "p1", qty: 2, unitPrice: 5 };

type Inv = { id: string; total: number; status: string; createdAt: Date; payments: any[] };

describe("CounterSaleService.ring", () => {
  let service: CounterSaleService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let createSale: jest.Mock;
  let recordPayment: jest.Mock;
  let walkIn: { getOrCreateWalkIn: jest.Mock };
  let reader: { get: jest.Mock };
  let invoices: Inv[];
  let replay: boolean;

  const inv = (id: string, total: number, payments: any[] = [], at = 1): Inv => ({
    id,
    total,
    status: "SENT",
    createdAt: new Date(2026, 9, 4, 12, 0, at),
    payments,
  });
  const errorOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as any;
    }
    throw new Error("expected a rejection");
  };
  const codeOf = async (p: Promise<unknown>) => (await errorOf(p)).getResponse().code;

  beforeEach(async () => {
    prisma = createMockPrisma();
    invoices = [inv("inv-1", 37.25)];
    replay = false;
    createSale = jest.fn(async (_dto: any, _u: any, sale: any) => {
      if (replay) sale?.onReplay?.();
      return { id: "inv-1", orderId: "ord-1", invoiceNumber: "INV-1" };
    });
    recordPayment = jest.fn(async (invoiceId: string, dto: any) => {
      const target = invoices.find((i) => i.id === invoiceId)!;
      if (target.payments.some((p) => p.status !== "VOID" && p.method !== "CREDIT_NOTE"))
        throw new BadRequestException("Invoice is already fully paid");
      target.payments.push({
        id: `pay-${invoiceId}`,
        amount: dto.amount,
        method: dto.method,
        status: "PAID",
      });
      return { id: invoiceId, createdPaymentId: `pay-${invoiceId}` };
    });
    walkIn = { getOrCreateWalkIn: jest.fn().mockResolvedValue("cust-walkin") };
    reader = { get: jest.fn().mockResolvedValue(cap("optional")) };

    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    prisma.product.findMany.mockResolvedValue([{ id: "p1" }]);
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.order.findFirst.mockResolvedValue({ id: "ord-1", orderNumber: "ORD-1" });
    prisma.invoice.findMany.mockImplementation(async () =>
      invoices.map((i) => ({ ...i, payments: [...i.payments], invoiceNumber: `N-${i.id}` })),
    );

    const mod = await Test.createTestingModule({
      providers: [
        CounterSaleService,
        { provide: OrdersService, useValue: { createSale } },
        { provide: InvoicesService, useValue: { recordPayment } },
        { provide: WalkInCustomerService, useValue: walkIn },
        { provide: PrismaService, useValue: prisma },
        { provide: FULFILMENT_CAPABILITY_READER, useValue: reader },
      ],
    }).compile();
    service = mod.get(CounterSaleService);
  });

  const named = (payment: any, extra: any = {}) => ({
    customerId: "cust-1",
    items: [item],
    payment,
    ...extra,
  });

  // ── 1. gate ───────────────────────────────────────────────────────────────
  describe("gate", () => {
    it("counter off: 403 COUNTER_SALES_DISABLED and NOTHING is written or called", async () => {
      reader.get.mockResolvedValue(cap("off"));
      const e = await errorOf(service.ring(named({ method: "CASH" }) as never, staff));
      expect(e.getStatus()).toBe(403);
      expect(e.getResponse().code).toBe("COUNTER_SALES_DISABLED");
      expect(createSale).not.toHaveBeenCalled();
      expect(recordPayment).not.toHaveBeenCalled();
      expect(walkIn.getOrCreateWalkIn).not.toHaveBeenCalled();
      expect(prisma.customer.create).not.toHaveBeenCalled();
    });

    it("walk-in sale on a tenant with the counter off creates no walk-in customer", async () => {
      reader.get.mockResolvedValue(cap("off"));
      await expect(
        service.ring({ walkIn: true, items: [item], payment: { method: "CASH" } } as never, staff),
      ).rejects.toMatchObject({ status: 403 });
      expect(walkIn.getOrCreateWalkIn).not.toHaveBeenCalled();
    });

    it.each(["always", "optional"] as const)("counter %s is allowed", async (counter) => {
      reader.get.mockResolvedValue(cap(counter));
      await expect(service.ring(named({ method: "CASH" }) as never, staff)).resolves.toBeDefined();
      expect(reader.get).toHaveBeenCalledWith("test-tenant");
    });

    it("a carrier tenant (no fleet, counter optional) still rings PICKUP counter sales", async () => {
      reader.get.mockResolvedValue(cap("optional", { fleet: false, methods: ["SHIP"] }));
      await service.ring(named({ method: "CASH" }) as never, staff);
      expect(createSale).toHaveBeenCalledWith(
        expect.anything(),
        staff,
        expect.objectContaining({ fulfillPath: "PICKUP" }),
      );
    });
  });

  // ── 2/3. selection, tenant scope, walk-in ──────────────────────────────────
  describe("customer selection", () => {
    it("customerId together with walkIn is 400 WALK_IN_WITH_CUSTOMER; neither is a 400", async () => {
      expect(
        await codeOf(service.ring(named({ method: "CASH" }, { walkIn: true }) as never, staff)),
      ).toBe("WALK_IN_WITH_CUSTOMER");
      await expect(
        service.ring({ items: [item], payment: { method: "CASH" } } as never, staff),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(createSale).not.toHaveBeenCalled();
    });

    it("walk-in + ON_ACCOUNT is 400 WALK_IN_NO_ACCOUNT and writes nothing (no walk-in row either)", async () => {
      const p = service.ring(
        { walkIn: true, items: [item], payment: { method: "ON_ACCOUNT" } } as never,
        staff,
      );
      expect(await codeOf(p)).toBe("WALK_IN_NO_ACCOUNT");
      expect(walkIn.getOrCreateWalkIn).not.toHaveBeenCalled();
      expect(createSale).not.toHaveBeenCalled();
    });

    it("another tenant's customer id is a 404 (tenant-scoped lookup) before anything is created", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);
      await expect(service.ring(named({ method: "CASH" }) as never, staff)).rejects.toMatchObject({
        status: 404,
      });
      expect(createSale).not.toHaveBeenCalled();
    });

    it("another tenant's / unknown product id is a 404 before anything is created", async () => {
      prisma.product.findMany.mockResolvedValue([]);
      await expect(service.ring(named({ method: "CASH" }) as never, staff)).rejects.toMatchObject({
        status: 404,
      });
      expect(createSale).not.toHaveBeenCalled();
    });

    it("a walk-in sale sells to the tenant's walk-in customer and suppresses the INVOICE_SENT email", async () => {
      await service.ring(
        { walkIn: true, items: [item], payment: { method: "CASH" } } as never,
        staff,
      );
      expect(walkIn.getOrCreateWalkIn).toHaveBeenCalledTimes(1);
      expect(createSale.mock.calls[0][0].customerId).toBe("cust-walkin");
      expect(createSale.mock.calls[0][2].suppressInvoiceNotify).toBe(true);
    });

    it("a named customer's sale does NOT suppress the invoice email", async () => {
      await service.ring(named({ method: "CASH" }) as never, staff);
      expect(createSale.mock.calls[0][2].suppressInvoiceNotify).toBeFalsy();
    });

    it("a walk-in holding open credit is refused 409 WALK_IN_OPEN_CREDIT BEFORE create (send would auto-apply it)", async () => {
      prisma.creditNote.findMany.mockResolvedValue([{ amount: 10, amountUsed: 4 }]);
      const e = await errorOf(
        service.ring({ walkIn: true, items: [item], payment: { method: "CASH" } } as never, staff),
      );
      expect(e).toBeInstanceOf(ConflictException);
      expect(e.getResponse().code).toBe("WALK_IN_OPEN_CREDIT");
      expect(createSale).not.toHaveBeenCalled();
    });

    it("a fully consumed credit note does not block the walk-in", async () => {
      prisma.creditNote.findMany.mockResolvedValue([{ amount: 10, amountUsed: 10 }]);
      await expect(
        service.ring({ walkIn: true, items: [item], payment: { method: "CASH" } } as never, staff),
      ).resolves.toBeDefined();
    });
  });

  // ── 4. lines + 5. sequence ─────────────────────────────────────────────────
  describe("lines and sequence", () => {
    it("hands create() (via createSale) the lines unchanged; priceReason becomes overrideReason", async () => {
      await service.ring(
        named(
          { method: "CASH" },
          {
            notes: "front desk",
            items: [
              { productId: "p1", boxes: 1, pieces: 3, unitPrice: 4.5, priceReason: "damaged box" },
              { productId: "p1", qty: 2 },
            ],
          },
        ) as never,
        staff,
        "key-1",
      );
      const dto = createSale.mock.calls[0][0];
      expect(dto).toMatchObject({
        customerId: "cust-1",
        notes: "front desk",
        deliveredNow: true,
        idempotencyKey: "key-1",
      });
      expect(dto.items).toEqual([
        { productId: "p1", boxes: 1, pieces: 3, unitPrice: 4.5, overrideReason: "damaged box" },
        { productId: "p1", qty: 2 },
      ]);
    });

    it("create()'s existing 400 for an unreasoned price override surfaces untouched", async () => {
      const boom = new BadRequestException("A reason is required to change Widget");
      createSale.mockRejectedValue(boom);
      await expect(
        service.ring(
          named({ method: "CASH" }, { items: [{ ...item, unitPrice: 1 }] }) as never,
          staff,
        ),
      ).rejects.toBe(boom);
      expect(recordPayment).not.toHaveBeenCalled();
    });

    it("createSale is called as a PICKUP counter sale, THEN recordPayment runs; ON_ACCOUNT records none", async () => {
      await service.ring(named({ method: "CASH" }) as never, staff);
      expect(createSale).toHaveBeenCalledWith(
        expect.objectContaining({ deliveredNow: true }),
        staff,
        expect.objectContaining({ fulfillPath: "PICKUP" }),
      );
      expect(createSale.mock.invocationCallOrder[0]).toBeLessThan(
        recordPayment.mock.invocationCallOrder[0],
      );

      recordPayment.mockClear();
      invoices = [inv("inv-1", 37.25)];
      const r = await service.ring(named({ method: "ON_ACCOUNT" }) as never, staff);
      expect(recordPayment).not.toHaveBeenCalled();
      expect(r).toMatchObject({
        total: 37.25,
        paid: 0,
        balanceDue: 37.25,
        paymentRecorded: true,
      });
      expect(r.paymentId).toBeUndefined();
    });

    it("never touches stock itself: the only decrement is create()'s own (no inventory collaborator)", () => {
      expect(Object.keys(service as object).filter((k) => /stock|inventory/i.test(k))).toEqual([]);
    });
  });

  // ── 7. money ───────────────────────────────────────────────────────────────
  describe("money", () => {
    it("CASH 50 on 37.25: pays 37.25, change 12.75, balance 0", async () => {
      const r = await service.ring(named({ method: "CASH", amount: 50 }) as never, staff);
      expect(recordPayment).toHaveBeenCalledWith("inv-1", {
        amount: 37.25,
        method: "CASH",
        reference: undefined,
      });
      expect(r).toEqual({
        orderId: "ord-1",
        orderNumber: "ORD-1",
        invoiceId: "inv-1",
        invoiceNumber: "N-inv-1",
        total: 37.25,
        paid: 37.25,
        balanceDue: 0,
        change: 12.75,
        paymentId: "pay-inv-1",
        paymentRecorded: true,
      });
    });

    it("CARD exact: recorded as CREDIT_CARD with the reference; no change", async () => {
      const r = await service.ring(named({ method: "CARD", reference: "auth-77" }) as never, staff);
      expect(recordPayment).toHaveBeenCalledWith("inv-1", {
        amount: 37.25,
        method: "CREDIT_CARD",
        reference: "auth-77",
      });
      expect(r.change).toBeUndefined();
      expect(r.balanceDue).toBe(0);
    });

    it("CHECK without a number is 400 COUNTER_CHECK_NUMBER_REQUIRED BEFORE the sale is created", async () => {
      expect(await codeOf(service.ring(named({ method: "CHECK" }) as never, staff))).toBe(
        "COUNTER_CHECK_NUMBER_REQUIRED",
      );
      expect(createSale).not.toHaveBeenCalled();
    });

    it("CASH short of the total: the sale stands (open invoice), 201 paymentRecorded:false TENDER_SHORT, no payment", async () => {
      const r = await service.ring(named({ method: "CASH", amount: 30 }) as never, staff);
      expect(recordPayment).not.toHaveBeenCalled();
      expect(r).toMatchObject({
        paymentRecorded: false,
        paymentErrorCode: "COUNTER_TENDER_SHORT",
        paid: 0,
        balanceDue: 37.25,
      });
    });

    it("CARD above the total is COUNTER_PAYMENT_EXCEEDS_TOTAL, nothing recorded", async () => {
      const r = await service.ring(named({ method: "CARD", amount: 99 }) as never, staff);
      expect(recordPayment).not.toHaveBeenCalled();
      expect(r).toMatchObject({
        paymentRecorded: false,
        paymentErrorCode: "COUNTER_PAYMENT_EXCEEDS_TOTAL",
      });
    });

    it("the tender is judged against the POST-send balance (credit already applied by send)", async () => {
      invoices = [
        inv("inv-1", 40, [{ id: "cn-pay", amount: 10, method: "CREDIT_NOTE", status: "PAID" }]),
      ];
      const r = await service.ring(named({ method: "CASH", amount: 30 }) as never, staff);
      expect(recordPayment).toHaveBeenCalledWith("inv-1", expect.objectContaining({ amount: 30 }));
      expect(r).toMatchObject({ total: 40, paid: 40, balanceDue: 0, paymentRecorded: true });
      expect(r.change).toBeUndefined();
    });

    it("mixed regulated order: sibling invoices are paid oldest-first from one tender", async () => {
      invoices = [inv("inv-1", 30, [], 1), inv("inv-2", 7.25, [], 2)];
      const r = await service.ring(named({ method: "CASH", amount: 40 }) as never, staff);
      expect(recordPayment.mock.calls.map((c) => [c[0], c[1].amount])).toEqual([
        ["inv-1", 30],
        ["inv-2", 7.25],
      ]);
      expect(r).toMatchObject({ total: 37.25, paid: 37.25, balanceDue: 0, change: 2.75 });
    });
  });

  // ── 8. refusals ────────────────────────────────────────────────────────────
  describe("refusals and partial failure", () => {
    it.each(["CREDIT_LIMIT_EXCEEDED", "REGULATED_AUTH_REQUIRED", "SELLING_RESTRICTED"])(
      "create()'s %s 409 propagates unchanged and no payment is attempted",
      async (code) => {
        const boom = new ConflictException({ code, message: "refused" });
        createSale.mockRejectedValue(boom);
        await expect(service.ring(named({ method: "CASH" }) as never, staff)).rejects.toBe(boom);
        expect(recordPayment).not.toHaveBeenCalled();
      },
    );

    it("recordPayment failing AFTER the sale committed: 201, paymentRecorded:false, the invoice stays open", async () => {
      recordPayment.mockRejectedValue(new Error("db went away"));
      const r = await service.ring(named({ method: "CASH", amount: 50 }) as never, staff);
      expect(r).toMatchObject({
        invoiceId: "inv-1",
        total: 37.25,
        paid: 0,
        balanceDue: 37.25,
        paymentRecorded: false,
        paymentErrorCode: "COUNTER_PAYMENT_NOT_RECORDED",
      });
      expect(r.change).toBeUndefined(); // no money moved, so no change is owed
    });
  });

  // ── 9. idempotency ─────────────────────────────────────────────────────────
  describe("Idempotency-Key", () => {
    it("the same key twice: createSale replays, exactly ONE payment, identical response + replayed:true", async () => {
      const first = await service.ring(named({ method: "CASH", amount: 50 }) as never, staff, "k");
      replay = true;
      const second = await service.ring(named({ method: "CASH", amount: 50 }) as never, staff, "k");
      expect(recordPayment).toHaveBeenCalledTimes(1);
      expect(second).toEqual({ ...first, replayed: true });
      expect(first.replayed).toBeUndefined();
    });

    it("a replay after a refused tender finishes the sale when retried with a corrected payment", async () => {
      await service.ring(named({ method: "CASH", amount: 30 }) as never, staff, "k");
      expect(recordPayment).not.toHaveBeenCalled();
      replay = true;
      const retry = await service.ring(named({ method: "CASH", amount: 40 }) as never, staff, "k");
      expect(recordPayment).toHaveBeenCalledTimes(1);
      expect(retry).toMatchObject({ paymentRecorded: true, paid: 37.25, replayed: true });
    });

    it("paymentRecorded on a replay comes from what is STORED, not from this call", async () => {
      invoices = [
        inv("inv-1", 37.25, [{ id: "p0", amount: 37.25, method: "CASH", status: "PAID" }]),
      ];
      replay = true;
      const r = await service.ring(named({ method: "CASH", amount: 50 }) as never, staff, "k");
      expect(recordPayment).not.toHaveBeenCalled();
      expect(r).toMatchObject({ paymentRecorded: true, paid: 37.25, paymentId: "p0" });
    });

    it("a VOID payment does not count: the replay records a fresh one", async () => {
      invoices = [
        inv("inv-1", 37.25, [{ id: "p0", amount: 37.25, method: "CASH", status: "VOID" }]),
      ];
      replay = true;
      await service.ring(named({ method: "CASH" }) as never, staff, "k");
      expect(recordPayment).toHaveBeenCalledTimes(1);
    });

    it("a concurrent double submit: the loser's payment is refused by the invoice lock, the stored payment makes it paymentRecorded:true, one payment exists", async () => {
      // Both requests read the invoice before either paid (the stale first read of the loser).
      const stale = invoices.map((i) => ({
        ...i,
        payments: [] as any[],
        invoiceNumber: "N-inv-1",
      }));
      await service.ring(named({ method: "CASH" }) as never, staff, "k");
      replay = true;
      prisma.invoice.findMany.mockResolvedValueOnce(stale);
      const loser = await service.ring(named({ method: "CASH" }) as never, staff, "k");
      expect(recordPayment).toHaveBeenCalledTimes(2); // the loser tried; the invoice row lock said no
      expect(invoices[0].payments).toHaveLength(1);
      expect(loser).toMatchObject({ paymentRecorded: true, replayed: true, paid: 37.25 });
    });
  });
});
