// OrdersService / InvoicesService pull ESM-only modules Jest's CommonJS parser cannot load: mocked at the boundary.
jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));
jest.mock("../../common/db-locks", () => ({
  ...jest.requireActual("../../common/db-locks"),
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
}));

import { Test } from "@nestjs/testing";
import type { FulfilmentCapability } from "@routeflow/types";
import { CounterSaleService } from "./counter-sale.service";
import { WalkInCustomerService } from "./walk-in-customer";
import { FULFILMENT_CAPABILITY_READER } from "./fulfilment-capability-reader";
import { OrdersService } from "../orders.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../../audit/audit.service";
import { createMockPrisma } from "../../testing/prisma-mock";
import { API_ERROR_CODES } from "../../common/api-error-codes";

/**
 * SA-764 Rule 1: the counter tender stores the CASH handed over on Order.counterCashTendered BEFORE the
 * payment loop (overwritable until a CASH tender row anchors it, then frozen: only a NULL is filled);
 * card / check / on-account sales leave it NULL. Rule 2: the by-key read returns it and its change.
 */
const staff = { sub: "op-1", role: "OPERATOR", tenantId: "t-1" } as never;
const capability = {
  methods: ["PICKUP", "SHIP"],
  staffDefault: "PICKUP",
  staffOpensAs: "counter",
  portalMethods: [],
  portalDefault: null,
  counter: "always",
  fleet: true,
  consistent: true,
} as FulfilmentCapability;

type Payment = { id: string; amount: number; method: string; status: string };
type Inv = { id: string; total: number; status: string; createdAt: Date; payments: Payment[] };

describe("counter sale: Order.counterCashTendered (SA-764)", () => {
  let service: CounterSaleService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let replay: boolean;
  let stored: number | null;
  let findReplayCandidateByKey: jest.Mock;
  let recordPayment: jest.Mock;
  const invoices: Inv[] = [];

  const ring = (payment: Record<string, unknown>, key = "k1") =>
    service.ring(
      { customerId: "cust-1", items: [{ productId: "p1", qty: 1 }], payment } as never,
      staff,
      key,
    );

  beforeEach(async () => {
    replay = false;
    stored = null;
    invoices.length = 0;
    invoices.push({
      id: "inv-1",
      total: 41.27,
      status: "SENT",
      createdAt: new Date(2026, 9, 4, 12),
      payments: [],
    });
    prisma = createMockPrisma();
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    prisma.product.findMany.mockResolvedValue([{ id: "p1" }]);
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.tenantConfig.findUnique.mockResolvedValue({ creditAutoApplyOnSend: false });
    prisma.order.findFirst.mockImplementation(async () => ({
      id: "ord-1",
      orderNumber: "ORD-1",
      counterCashTendered: stored,
    }));
    // The column behaves like the real one: the `counterCashTendered: null` filter only matches while unset,
    // the `{ not: null }` filter only while set.
    prisma.order.updateMany.mockImplementation(
      async ({
        where,
        data,
      }: {
        where: { counterCashTendered?: null | { not: null } };
        data: { counterCashTendered: number | null };
      }) => {
        if (where.counterCashTendered === null && stored !== null) return { count: 0 };
        if (where.counterCashTendered && stored === null) return { count: 0 };
        stored = data.counterCashTendered;
        return { count: 1 };
      },
    );
    prisma.invoice.findMany.mockImplementation(
      async ({ where }: { where?: { status?: { notIn?: string[] } } } = {}) =>
        invoices
          .filter((i) => !where?.status?.notIn?.includes(i.status))
          .map((i) => ({ ...i, payments: [...i.payments], invoiceNumber: `N-${i.id}` })),
    );
    findReplayCandidateByKey = jest.fn(async () => null);
    const createSale = jest.fn(
      async (_d: unknown, _u: unknown, sale?: { onReplay?: (o: unknown) => void }) => {
        if (replay) sale?.onReplay?.({ id: "ord-1", counterSale: true });
        return { id: "inv-1", orderId: "ord-1", invoiceNumber: "INV-1" };
      },
    );
    recordPayment = jest.fn(async (invoiceId: string, dto: { amount: number; method: string }) => {
      invoices
        .find((i) => i.id === invoiceId)!
        .payments.push({ id: "pay-1", amount: dto.amount, method: dto.method, status: "PAID" });
      return { id: invoiceId };
    });
    const mod = await Test.createTestingModule({
      providers: [
        CounterSaleService,
        { provide: OrdersService, useValue: { createSale, findReplayCandidateByKey } },
        { provide: InvoicesService, useValue: { recordPayment } },
        { provide: WalkInCustomerService, useValue: { getOrCreateWalkIn: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        {
          provide: FULFILMENT_CAPABILITY_READER,
          useValue: { get: jest.fn().mockResolvedValue(capability) },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    service = mod.get(CounterSaleService);
  });

  it("(a) a new cash sale tendering 50 on 41.27 stores 50.00 BEFORE the payment, with an unfiltered write", async () => {
    const order: string[] = [];
    prisma.order.updateMany.mockImplementationOnce(async () => {
      order.push("store");
      stored = 50;
      return { count: 1 };
    });
    recordPayment.mockImplementationOnce(async () => {
      order.push("pay");
      return { id: "inv-1" };
    });
    await ring({ method: "CASH", amount: 50 });
    expect(order).toEqual(["store", "pay"]);
    expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: "ord-1" },
      data: { counterCashTendered: 50 },
    });
    expect(stored).toBe(50);
  });

  it("(a) a cash tender with no stated amount stores the exact balance, rounded to cents", async () => {
    await ring({ method: "CASH" });
    expect(stored).toBe(41.27);
  });

  it("(b) a replay of the same key never overwrites the stored value", async () => {
    await ring({ method: "CASH", amount: 50 });
    replay = true;
    await ring({ method: "CASH", amount: 60 });
    expect(stored).toBe(50);
    // the second write is the frozen, NULL-filtered one
    expect(prisma.order.updateMany).toHaveBeenCalledTimes(2);
  });

  it("(c) once a CASH tender row exists the write is frozen: filtered on NULL, no such filter before", async () => {
    await ring({ method: "CASH", amount: 50 });
    expect(prisma.order.updateMany).toHaveBeenLastCalledWith({
      where: { id: "ord-1" },
      data: { counterCashTendered: 50 },
    });
    replay = true;
    const r = await ring({ method: "CASH", amount: 60 });
    expect(prisma.order.updateMany).toHaveBeenLastCalledWith({
      where: { id: "ord-1", counterCashTendered: null },
      data: { counterCashTendered: 60 },
    });
    expect(stored).toBe(50);
    expect(r.change).toBe(8.73);
  });

  it("(b) a stored amount with NO cash row yet is not anchored: the next tender overwrites it", async () => {
    stored = 50;
    await ring({ method: "CASH", amount: 60 });
    expect(stored).toBe(60);
  });

  it("(a) a failed first attempt retried under the SAME key (replay) overwrites the stored amount", async () => {
    recordPayment.mockRejectedValueOnce(new Error("lock timeout"));
    const first = await ring({ method: "CASH", amount: 50 }, "k1");
    expect(first.paymentRecorded).toBe(false);
    expect(stored).toBe(50);
    replay = true;
    const retry = await ring({ method: "CASH", amount: 60 }, "k1");
    expect(retry.replayed).toBe(true);
    // no CASH tender row anchors the 50 yet, so the retry's own cash amount replaces it (unfiltered write)
    expect(prisma.order.updateMany).toHaveBeenLastCalledWith({
      where: { id: "ord-1" },
      data: { counterCashTendered: 60 },
    });
    expect(stored).toBe(60);
    expect(retry.paymentRecorded).toBe(true);
    expect(retry.cashTendered).toBe(60);
    expect(retry.change).toBe(18.73);
  });

  it("(a) a failed first attempt retried under a NEW key and amount also ends on the NEW amount", async () => {
    recordPayment.mockRejectedValueOnce(new Error("lock timeout"));
    const first = await ring({ method: "CASH", amount: 50 }, "k1");
    expect(first.paymentRecorded).toBe(false);
    expect(stored).toBe(50);
    const retry = await ring({ method: "CASH", amount: 60 }, "k2");
    expect(stored).toBe(60);
    expect(retry.paymentRecorded).toBe(true);
    expect(retry.cashTendered).toBe(60);
    expect(retry.change).toBe(18.73);
  });

  it("(b) when the tendered write rejects, NO payment is recorded and the response says so", async () => {
    prisma.order.updateMany.mockRejectedValueOnce(new Error("db down"));
    const r = await ring({ method: "CASH", amount: 50 });
    expect(recordPayment).not.toHaveBeenCalled();
    expect(r.paymentRecorded).toBe(false);
    expect(r.paymentErrorCode).toBe(API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED);
    expect(invoices[0].payments).toHaveLength(0);
  });

  it.each([
    ["a card sale", { method: "CARD" }],
    ["a check sale", { method: "CHECK", reference: "1001" }],
    ["an on-account sale", { method: "ON_ACCOUNT" }],
  ])("(c) %s leaves it NULL", async (_label, payment) => {
    await ring(payment);
    if (payment.method === "ON_ACCOUNT") expect(prisma.order.updateMany).not.toHaveBeenCalled();
    // a card / check tender never writes a figure: its only write is the stale-clear, which matches nothing here
    else
      expect(prisma.order.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { counterCashTendered: expect.any(Number) } }),
      );
    expect(stored).toBeNull();
  });

  describe("row 638: a crashed cash attempt's stale tendered never outlives a non-cash retry", () => {
    const crashCash = async () => {
      recordPayment.mockRejectedValueOnce(new Error("lock timeout"));
      const first = await ring({ method: "CASH", amount: 50 }, "k1");
      expect(first.paymentRecorded).toBe(false);
      expect(stored).toBe(50);
      expect(invoices[0].payments).toHaveLength(0);
    };

    it.each([
      ["card", { method: "CARD" }],
      ["check", { method: "CHECK", reference: "1001" }],
    ])(
      "(1) a %s retry on the same key clears the stale figure BEFORE the payment",
      async (_l, payment) => {
        await crashCash();
        replay = true;
        const order: string[] = [];
        prisma.order.updateMany.mockImplementationOnce(async () => {
          order.push("clear");
          stored = null;
          return { count: 1 };
        });
        recordPayment.mockImplementationOnce(
          async (invoiceId: string, dto: { amount: number; method: string }) => {
            order.push("pay");
            invoices
              .find((i) => i.id === invoiceId)!
              .payments.push({
                id: "pay-2",
                amount: dto.amount,
                method: dto.method,
                status: "PAID",
              });
            return { id: invoiceId };
          },
        );
        const r = await ring(payment, "k1");
        expect(order).toEqual(["clear", "pay"]);
        expect(prisma.order.updateMany).toHaveBeenLastCalledWith({
          where: { id: "ord-1", counterCashTendered: { not: null } },
          data: { counterCashTendered: null },
        });
        expect(stored).toBeNull();
        expect(r.paymentRecorded).toBe(true);
        expect(r.cashTendered).toBeUndefined();
        expect(r.change).toBeUndefined();
      },
    );

    it("(2) a card retry under a NEW key clears it too", async () => {
      await crashCash();
      const r = await ring({ method: "CARD" }, "k2");
      expect(stored).toBeNull();
      expect(r.paymentRecorded).toBe(true);
      expect(r.cashTendered).toBeUndefined();
    });

    it("(3) a refused card amount over the balance clears it and takes no money", async () => {
      await crashCash();
      const r = await ring({ method: "CARD", amount: 99 }, "k1");
      expect(stored).toBeNull();
      expect(recordPayment).toHaveBeenCalledTimes(1); // only the crashed cash attempt
      expect(invoices[0].payments).toHaveLength(0);
      expect(r.paymentRecorded).toBe(false);
      expect(r.cashTendered).toBeUndefined();
    });

    it("(4) a refused zero cash tender clears it too", async () => {
      await crashCash();
      const r = await ring({ method: "CASH", amount: 0 }, "k1");
      expect(stored).toBeNull();
      expect(r.paymentRecorded).toBe(false);
      expect(r.cashTendered).toBeUndefined();
    });

    it("(5) when the clear rejects, NO payment is recorded and the response says so", async () => {
      await crashCash();
      prisma.order.updateMany.mockRejectedValueOnce(new Error("db down"));
      const r = await ring({ method: "CARD" }, "k1");
      expect(recordPayment).toHaveBeenCalledTimes(1);
      expect(invoices[0].payments).toHaveLength(0);
      expect(r.paymentRecorded).toBe(false);
      expect(r.paymentErrorCode).toBe(API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED);
    });

    it("(6) a refused tender whose clear fails reports not-recorded, not the refusal, and takes no money", async () => {
      await crashCash();
      prisma.order.updateMany.mockRejectedValueOnce(new Error("db down"));
      const r = await ring({ method: "CARD", amount: 99 }, "k1");
      expect(r.paymentRecorded).toBe(false);
      expect(invoices[0].payments).toHaveLength(0);
      expect(r.paymentErrorCode).toBe(API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED);
    });

    it("(7) once a tender row exists the figure is left alone: a CARD top-up never clears a stored cash anchor", async () => {
      replay = true;
      stored = 20;
      invoices[0].payments.push({ id: "p0", amount: 20, method: "CASH", status: "PAID" });
      await ring({ method: "CARD" }, "k1");
      expect(stored).toBe(20);
      expect(prisma.order.updateMany).not.toHaveBeenCalledWith({
        where: { id: "ord-1", counterCashTendered: { not: null } },
        data: { counterCashTendered: null },
      });
    });

    it("(8) a cash retry still just overwrites the stale figure (no separate clear)", async () => {
      await crashCash();
      prisma.order.updateMany.mockClear();
      await ring({ method: "CASH", amount: 60 }, "k2");
      expect(stored).toBe(60);
      expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  it("a refused cash tender (zero) records nothing and stores nothing", async () => {
    await ring({ method: "CASH", amount: 0 });
    expect(stored).toBeNull();
  });

  it("(f) the by-key read returns the stored cashTendered and its stored change", async () => {
    findReplayCandidateByKey.mockResolvedValue({
      id: "ord-1",
      orderNumber: "ORD-1",
      counterSale: true,
      status: "DELIVERED",
      counterCashTendered: "50.00",
    });
    invoices[0].payments.push({ id: "p0", amount: 41.27, method: "CASH", status: "PAID" });
    const r = await service.byKey("k1");
    expect(r.cashTendered).toBe(50);
    expect(r.change).toBe(8.73);
  });

  it("no stored tendered: a CASH sale with a cash tender row but NO stored tendered (legacy) serves no change", async () => {
    findReplayCandidateByKey.mockResolvedValue({
      id: "ord-1",
      orderNumber: "ORD-1",
      counterSale: true,
      status: "DELIVERED",
      counterCashTendered: null,
    });
    invoices[0].payments.push({ id: "p0", amount: 41.27, method: "CASH", status: "PAID" });
    const r = await service.byKey("k1");
    expect(r.method).toBe("CASH");
    expect(r.change).toBeUndefined();
    expect(r.cashTendered).toBeUndefined();
  });

  it("a CARD replay on a sale whose stored first tender is CASH serves the same change as by-key", async () => {
    replay = true;
    stored = 50;
    invoices[0].status = "PAID";
    invoices[0].payments.push({ id: "p0", amount: 41.27, method: "CASH", status: "PAID" });
    const r = await ring({ method: "CARD", amount: 41.27 });
    findReplayCandidateByKey.mockResolvedValue({
      id: "ord-1",
      orderNumber: "ORD-1",
      counterSale: true,
      status: "DELIVERED",
      counterCashTendered: 50,
    });
    const k = await service.byKey("k1");
    expect(k.change).toBe(8.73);
    expect(r.cashTendered).toBe(k.cashTendered);
    expect(r.change).toBe(k.change);
  });

  describe("row 290: an ON_ACCOUNT replay serves what by-key serves", () => {
    const keyed = (counterCashTendered: number | null) =>
      findReplayCandidateByKey.mockResolvedValue({
        id: "ord-1",
        orderNumber: "ORD-1",
        counterSale: true,
        status: "DELIVERED",
        counterCashTendered,
      });
    const wroteNothing = () => {
      expect(recordPayment).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    };

    it("(1) a CASH-first sale replayed as ON_ACCOUNT reads the same answer as by-key, and writes nothing", async () => {
      replay = true;
      stored = 50;
      invoices[0].status = "PAID";
      invoices[0].payments.push({ id: "p0", amount: 41.27, method: "CASH", status: "PAID" });
      const r = await ring({ method: "ON_ACCOUNT" });
      keyed(stored);
      const k = await service.byKey("k1", "ON_ACCOUNT");
      expect(k.change).toBe(8.73);
      expect(k.cashTendered).toBe(50);
      expect(r).toEqual(k);
      expect(r.paymentRecorded).toBe(true);
      expect(r.paymentId).toBe("p0");
      expect(invoices[0].payments).toHaveLength(1);
      wroteNothing();
    });

    it("(2) an ON_ACCOUNT-first sale replayed as ON_ACCOUNT is unchanged: no tender, no change", async () => {
      replay = true;
      const r = await ring({ method: "ON_ACCOUNT" });
      keyed(null);
      const k = await service.byKey("k1", "ON_ACCOUNT");
      expect(r).toEqual(k);
      expect(r.method).toBe("ON_ACCOUNT");
      expect(r.paymentRecorded).toBe(true);
      expect(r.change).toBeUndefined();
      expect(r.cashTendered).toBeUndefined();
      expect(r.paymentId).toBeUndefined();
      expect(r.paid).toBe(0);
      wroteNothing();
    });

    it("(3) a CASH-first sale replayed as CARD is unchanged: still serves by-key, writes nothing", async () => {
      replay = true;
      stored = 50;
      invoices[0].status = "PAID";
      invoices[0].payments.push({ id: "p0", amount: 41.27, method: "CASH", status: "PAID" });
      const r = await ring({ method: "CARD", amount: 41.27 });
      keyed(stored);
      const k = await service.byKey("k1", "CARD");
      expect(r).toEqual(k);
      expect(r.change).toBe(8.73);
      expect(invoices[0].payments).toHaveLength(1);
      wroteNothing();
    });

    it("(5) a failed CASH attempt (tendered stored, no CASH row) replayed as ON_ACCOUNT serves cashTendered, no change", async () => {
      replay = true;
      stored = 60;
      const r = await ring({ method: "ON_ACCOUNT" });
      keyed(stored);
      const k = await service.byKey("k1", "ON_ACCOUNT");
      expect(r).toEqual(k);
      expect(r.cashTendered).toBe(60);
      expect(r.change).toBeUndefined();
      expect(r.paymentId).toBeUndefined();
      expect(r.paymentRecorded).toBe(true);
      expect(invoices[0].payments).toHaveLength(0);
      wroteNothing();
    });

    it("(4) a CARD-first sale replayed as ON_ACCOUNT reads the same answer as by-key, and writes nothing", async () => {
      replay = true;
      invoices[0].status = "PAID";
      invoices[0].payments.push({ id: "p0", amount: 41.27, method: "CREDIT_CARD", status: "PAID" });
      const r = await ring({ method: "ON_ACCOUNT" });
      keyed(null);
      const k = await service.byKey("k1", "ON_ACCOUNT");
      expect(r).toEqual(k);
      expect(r.change).toBeUndefined();
      expect(r.cashTendered).toBeUndefined();
      expect(r.paymentId).toBe("p0");
      wroteNothing();
    });
  });

  it("readInvoices reads the payments oldest first so the first stored tender is deterministic", async () => {
    await ring({ method: "CASH", amount: 41.27 });
    const args = prisma.invoice.findMany.mock.calls.map(([a]: [any]) => a);
    expect(args.length).toBeGreaterThan(0);
    for (const a of args) expect(a.include.payments).toEqual({ orderBy: { createdAt: "asc" } });
  });

  it("(f) a sale with no stored tendered (card / legacy) reads back without the field", async () => {
    findReplayCandidateByKey.mockResolvedValue({
      id: "ord-1",
      orderNumber: "ORD-1",
      counterSale: true,
      status: "DELIVERED",
      counterCashTendered: null,
    });
    const r = await service.byKey("k1");
    expect(r.cashTendered).toBeUndefined();
  });
});
