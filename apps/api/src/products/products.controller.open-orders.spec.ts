import "reflect-metadata";
import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { OrderStatus, UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { ACCRUAL_REVENUE_STATUSES } from "../common/invoiced-sales";
import { OPEN_ORDER_STATUSES } from "../invoices/credit-exposure";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { ProductsController } from "./products.controller";
import {
  CARD_OPEN_STATUSES,
  ProductOpenOrdersService,
  clampOpenOrdersLimit,
} from "./product-open-orders.service";

describe("GET /products/:id/open-orders", () => {
  it("is OPERATOR-only (TENANT_ADMIN by hierarchy), not DRIVER, and not under /analytics", () => {
    const handler = ProductsController.prototype.getOpenOrders;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.OPERATOR]);
    expect(Reflect.getMetadata("path", handler)).toBe(":id/open-orders");
    expect(Reflect.getMetadata("path", ProductsController)).toBe("products");
  });

  it("clamps limit 1–500 (default 200) before it reaches the service", async () => {
    const svc = { getOpenOrders: jest.fn().mockResolvedValue({}) };
    const c = new ProductsController({} as never, {} as never, svc as never);
    await c.getOpenOrders("p1");
    await c.getOpenOrders("p1", "0");
    await c.getOpenOrders("p1", "99999");
    await c.getOpenOrders("p1", "25.9");
    await c.getOpenOrders("p1", "");
    await c.getOpenOrders("p1", "abc");
    expect(svc.getOpenOrders.mock.calls.map((a) => a[1])).toEqual([200, 1, 500, 25, 200, 200]);
    expect(clampOpenOrdersLimit(undefined)).toBe(200);
    expect(clampOpenOrdersLimit("-5")).toBe(1);
  });
});

describe("ProductOpenOrdersService", () => {
  let service: ProductOpenOrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const ord = (
    id: string,
    customerId: string,
    name: string,
    status: OrderStatus,
    lines: any[],
  ) => ({
    id,
    orderNumber: `ORD-${id}`,
    orderDate: null,
    createdAt: new Date("2026-10-10T00:00:00Z"),
    status,
    customerId,
    customer: { id: customerId, businessName: name },
    lineItems: lines,
  });
  const ln = (id: string, qty: number, over: any = {}) => ({
    id,
    qty,
    boxes: null,
    pieces: null,
    unitsPerBox: 12,
    unitLabel: null,
    unitPrice: 5,
    priceType: null,
    ...over,
  });

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.product.findFirst.mockResolvedValue({ id: "p1" });
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.order.findMany.mockResolvedValue([]);
    const mod = await Test.createTestingModule({
      providers: [ProductOpenOrdersService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(ProductOpenOrdersService);
  });

  it("404s a product outside the tenant and never reads orders", async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    await expect(service.getOpenOrders("other", 200)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expect(prisma.product.findFirst.mock.calls[0][0].where).toEqual({
      id: "other",
      tenantId: "test-tenant",
    });
  });

  it("reads open statuses plus PARTIALLY_DELIVERED, no counter sales, scoped to the tenant", async () => {
    await service.getOpenOrders("p1", 200);
    const w = prisma.order.findMany.mock.calls[0][0].where;
    expect(w).toMatchObject({
      tenantId: "test-tenant",
      status: { in: [...OPEN_ORDER_STATUSES, OrderStatus.PARTIALLY_DELIVERED] },
      counterSale: false,
    });
    expect(CARD_OPEN_STATUSES).toEqual([
      OrderStatus.PENDING,
      OrderStatus.CONFIRMED,
      OrderStatus.OUT_FOR_DELIVERY,
      OrderStatus.PARTIALLY_DELIVERED,
    ]);
  });

  it("the shared OPEN_ORDER_STATUSES (credit exposure) does not gain PARTIALLY_DELIVERED", () => {
    expect([...OPEN_ORDER_STATUSES]).toEqual([
      OrderStatus.PENDING,
      OrderStatus.CONFIRMED,
      OrderStatus.OUT_FOR_DELIVERY,
    ]);
  });

  it("a partly delivered order shows its undelivered quantity", async () => {
    prisma.order.findMany.mockResolvedValue([
      ord("o1", "c1", "Acme Foods", OrderStatus.PARTIALLY_DELIVERED, [
        ln("l1", 24, { deliveredQty: 10 }),
      ]),
      ord("o2", "c2", "Globex Market", OrderStatus.PARTIALLY_DELIVERED, [
        ln("l2", 12, { deliveredQty: 12 }),
      ]),
    ]);
    const res = await service.getOpenOrders("p1", 200);
    // fully delivered line drops; the other owes 24 - 10 = 14 (1 box + 2 pcs of 12)
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]).toEqual(
      expect.objectContaining({
        orderId: "o1",
        status: "PARTIALLY_DELIVERED",
        qty: 24,
        remainingQty: 14,
        boxes: 1,
        pieces: 2,
      }),
    );
    expect(res.summary).toEqual({ orders: 1, customers: 1, totalQty: 14 });
  });

  it("summary counts orders, distinct customers and total remaining qty; the row splits the remainder by boxes", async () => {
    prisma.order.findMany.mockResolvedValue([
      ord("o1", "c1", "Acme Foods", OrderStatus.PENDING, [ln("l1", 30), ln("l2", 6)]),
      ord("o2", "c1", "Acme Foods", OrderStatus.CONFIRMED, [ln("l3", 12)]),
      ord("o3", "c2", "Globex Market", OrderStatus.OUT_FOR_DELIVERY, [ln("l4", 24)]),
    ]);
    // l1 is part billed: 30 ordered, 6 already invoiced
    prisma.invoice.findMany.mockResolvedValue([{ items: [{ orderItemId: "l1", qty: 6 }] }]);
    const res = await service.getOpenOrders("p1", 200);
    expect(res.productId).toBe("p1");
    expect(res.summary).toEqual({ orders: 3, customers: 2, totalQty: 24 + 6 + 12 + 24 });
    expect(res.truncated).toBe(false);
    // billed qty is read through Invoice with an explicit tenant and only ISSUED invoices
    expect(prisma.invoice.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: "test-tenant",
      status: { notIn: [...ACCRUAL_REVENUE_STATUSES.notIn] },
    });
    const l1 = res.lines.find((l) => l.qty === 30)!;
    expect(l1).toEqual(
      expect.objectContaining({
        orderId: "o1",
        orderNumber: "ORD-o1",
        status: "PENDING",
        customerId: "c1",
        customerName: "Acme Foods",
        remainingQty: 24,
        boxes: 2,
        pieces: 0,
        unitsPerBox: 12,
      }),
    );
    expect(res.lines[0].orderDate).toBe("2026-10-10T00:00:00.000Z");
  });

  it("truncated is true past the cap and the lines are cut to the cap", async () => {
    prisma.order.findMany.mockResolvedValue([
      ord("o1", "c1", "Acme Foods", OrderStatus.PENDING, [ln("a", 1)]),
      ord("o2", "c1", "Acme Foods", OrderStatus.PENDING, [ln("b", 1)]),
      ord("o3", "c2", "Globex Market", OrderStatus.PENDING, [ln("c", 1)]),
    ]);
    const res = await service.getOpenOrders("p1", 2);
    expect(res.lines).toHaveLength(2);
    expect(res.truncated).toBe(true);
    expect(res.summary).toEqual({ orders: 2, customers: 1, totalQty: 2 });
  });

  it("a full order window whose lines are mostly billed out still reports truncated", async () => {
    // limit 1 -> take 2: both orders are read, one line is billed out, so found.length (1) <= limit
    prisma.order.findMany.mockResolvedValue([
      ord("o1", "c1", "Acme Foods", OrderStatus.PENDING, [ln("a", 5)]),
      ord("o2", "c1", "Acme Foods", OrderStatus.PENDING, [ln("b", 5)]),
    ]);
    prisma.invoice.findMany.mockResolvedValue([{ items: [{ orderItemId: "a", qty: 5 }] }]);
    const res = await service.getOpenOrders("p1", 1);
    expect(res.lines.map((l) => l.orderId)).toEqual(["o2"]);
    expect(res.truncated).toBe(true);
  });
});
