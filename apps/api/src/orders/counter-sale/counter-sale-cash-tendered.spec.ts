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

/**
 * SA-764 Rule 1: the counter tender stores the CASH handed over on Order.counterCashTendered, once, on a
 * NEW sale only; card / check / on-account sales leave it NULL. Rule 2: the by-key read returns it.
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
    prisma.order.findFirst.mockResolvedValue({ id: "ord-1", orderNumber: "ORD-1" });
    // The column behaves like the real one: the `counterCashTendered: null` filter only matches while unset.
    prisma.order.updateMany.mockImplementation(
      async ({
        where,
        data,
      }: {
        where: { counterCashTendered?: null };
        data: { counterCashTendered: number };
      }) => {
        if (where.counterCashTendered === null && stored !== null) return { count: 0 };
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
    const recordPayment = jest.fn(
      async (invoiceId: string, dto: { amount: number; method: string }) => {
        invoices
          .find((i) => i.id === invoiceId)!
          .payments.push({ id: "pay-1", amount: dto.amount, method: dto.method, status: "PAID" });
        return { id: invoiceId };
      },
    );
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

  it("(a) a new cash sale tendering 50 on 41.27 stores 50.00 once, through one idempotent updateMany", async () => {
    await ring({ method: "CASH", amount: 50 });
    expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: "ord-1", counterCashTendered: null },
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
    expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
  });

  it("(b) a second write cannot overwrite it either: the update is filtered on NULL", async () => {
    stored = 50;
    await ring({ method: "CASH", amount: 60 });
    expect(stored).toBe(50);
  });

  it.each([
    ["a card sale", { method: "CARD" }],
    ["a check sale", { method: "CHECK", reference: "1001" }],
    ["an on-account sale", { method: "ON_ACCOUNT" }],
  ])("(c) %s leaves it NULL", async (_label, payment) => {
    await ring(payment);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(stored).toBeNull();
  });

  it("a refused cash tender (zero) records nothing and stores nothing", async () => {
    await ring({ method: "CASH", amount: 0 });
    expect(stored).toBeNull();
  });

  it("(f) the by-key read returns the stored cashTendered", async () => {
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
