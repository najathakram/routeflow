import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import {
  CustomerOrderSuggestionsService,
  ORDER_AGAIN_COUNT,
  USUALLY_BUYS_DAYS,
  USUALLY_BUYS_LIMIT,
} from "./customer-order-suggestions.service";

const NOW = new Date("2026-10-04T12:00:00Z");
const D = (n: number | string) => n; // Prisma Decimal stand-in: Number() accepts it

const product = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  name: `Product ${id}`,
  variantName: null,
  parentProductId: null,
  parent: null,
  unit: "each",
  unitsPerBox: null,
  pricePerUnit: D("5.00"),
  priceTier2: D("4.50"),
  priceTier3: D("4.00"),
  priceTier4: D("3.50"),
  priceTier5: D("3.00"),
  averageCost: D("2.0000"),
  category: null,
  trackedCategoryId: null,
  isActive: true,
  ...o,
});

/** A usually-buys source line: one OrderItem row of `productId` on an order dated `at`. */
const line = (productId: string, at = "2026-09-20T10:00:00Z") => ({
  productId,
  order: { orderDate: null, createdAt: new Date(at) },
});

const orderRow = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  status: "DELIVERED",
  orderDate: null,
  createdAt: new Date("2026-09-30T09:00:00Z"),
  lineItems: [
    {
      productId: "p1",
      qty: D(3),
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      unitLabel: null,
      unitPrice: D("99.00"), // a historical price: must never reach the response
    },
  ],
  ...o,
});

describe("CustomerOrderSuggestionsService", () => {
  let service: CustomerOrderSuggestionsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    prisma = createMockPrisma();
    prisma.customer.findFirst.mockResolvedValue({ id: "c1" });
    prisma.orderItem.findMany.mockResolvedValue([]);
    prisma.order.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([]);
    const mod = await Test.createTestingModule({
      providers: [CustomerOrderSuggestionsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(CustomerOrderSuggestionsService);
  });

  afterEach(() => jest.useRealTimers());

  describe("tenant isolation", () => {
    it("scopes the customer, line, order and product reads to the request tenant", async () => {
      prisma.orderItem.findMany.mockResolvedValue([line("p1")]);
      prisma.order.findMany.mockResolvedValue([orderRow("o1")]);
      prisma.product.findMany.mockResolvedValue([product("p1")]);
      await service.getSuggestions("c1");
      expect(prisma.customer.findFirst.mock.calls[0][0].where).toEqual({
        id: "c1",
        tenantId: "test-tenant",
      });
      expect(prisma.orderItem.findMany.mock.calls[0][0].where.order).toMatchObject({
        tenantId: "test-tenant",
        customerId: "c1",
      });
      expect(prisma.order.findMany.mock.calls[0][0].where).toMatchObject({
        tenantId: "test-tenant",
        customerId: "c1",
      });
      expect(prisma.product.findMany.mock.calls[0][0].where).toMatchObject({
        tenantId: "test-tenant",
        id: { in: ["p1"] },
      });
    });

    it("404s another tenant's (unfound) customer and never reads orders", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);
      await expect(service.getSuggestions("other")).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.orderItem.findMany).not.toHaveBeenCalled();
      expect(prisma.order.findMany).not.toHaveBeenCalled();
    });

    it("refuses a request with no tenant context", async () => {
      prisma.getTenantId.mockReturnValue(null);
      await expect(service.getSuggestions("c1")).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("usually buys", () => {
    it("reads only the last 90 days of non-cancelled orders and lines", async () => {
      await service.getSuggestions("c1");
      const where = prisma.orderItem.findMany.mock.calls[0][0].where;
      const since = new Date(NOW.getTime() - USUALLY_BUYS_DAYS * 86_400_000);
      expect(USUALLY_BUYS_DAYS).toBe(90);
      expect(where.order.status).toEqual({ not: "CANCELLED" });
      expect(where.status).toEqual({ not: "CANCELLED" });
      // The business date when set, else the entry timestamp.
      expect(where.order.OR).toEqual([
        { orderDate: { gte: since } },
        { orderDate: null, createdAt: { gte: since } },
      ]);
      expect(where.productId).toEqual({ not: null });
      expect(where.product).toEqual({ isActive: true });
    });

    it("ranks by order-line count, most bought first, and keeps the top 8", async () => {
      // p1 x5, p2 x4 ... p10 x1 (ten distinct products)
      const lines: ReturnType<typeof line>[] = [];
      for (let i = 1; i <= 10; i++) for (let n = 0; n < 11 - i; n++) lines.push(line(`p${i}`));
      prisma.orderItem.findMany.mockResolvedValue(lines);
      prisma.product.findMany.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => product(`p${i + 1}`)),
      );
      const out = await service.getSuggestions("c1");
      expect(USUALLY_BUYS_LIMIT).toBe(8);
      expect(out.usuallyBuys).toHaveLength(8);
      expect(out.usuallyBuys.map((u) => u.productId)).toEqual([
        "p1",
        "p2",
        "p3",
        "p4",
        "p5",
        "p6",
        "p7",
        "p8",
      ]);
      expect(out.usuallyBuys[0]).toEqual({ productId: "p1", orderLineCount: 10 });
      expect(out.usuallyBuys[7]).toEqual({ productId: "p8", orderLineCount: 3 });
    });

    it("breaks a tie by the most recent order, then by product id", async () => {
      prisma.orderItem.findMany.mockResolvedValue([
        line("pB", "2026-09-01T00:00:00Z"),
        line("pA", "2026-09-01T00:00:00Z"),
        line("pC", "2026-09-25T00:00:00Z"),
      ]);
      prisma.product.findMany.mockResolvedValue([product("pA"), product("pB"), product("pC")]);
      const out = await service.getSuggestions("c1");
      expect(out.usuallyBuys.map((u) => u.productId)).toEqual(["pC", "pA", "pB"]);
    });

    it("returns no history prices anywhere in the payload", async () => {
      prisma.orderItem.findMany.mockResolvedValue([line("p1")]);
      prisma.order.findMany.mockResolvedValue([orderRow("o1")]);
      prisma.product.findMany.mockResolvedValue([product("p1")]);
      const out = await service.getSuggestions("c1");
      expect(JSON.stringify(out)).not.toContain("99");
      expect(JSON.stringify(out)).not.toMatch(/unitPrice|lastPrice/);
      // The line selects never ask for a price column at all.
      expect(prisma.orderItem.findMany.mock.calls[0][0].select).not.toHaveProperty("unitPrice");
      expect(JSON.stringify(prisma.order.findMany.mock.calls[0][0].select)).not.toContain(
        "unitPrice",
      );
    });

    it("carries the product's CURRENT catalog columns, including the active flag", async () => {
      prisma.orderItem.findMany.mockResolvedValue([line("p1")]);
      prisma.product.findMany.mockResolvedValue([
        product("p1", { unitsPerBox: 12, averageCost: D("1.5000"), parent: { name: "Parent" } }),
      ]);
      const out = await service.getSuggestions("c1");
      expect(out.products.p1).toMatchObject({
        id: "p1",
        unitsPerBox: 12,
        pricePerUnit: 5,
        priceTier3: 4,
        averageCost: 1.5,
        isActive: true,
        parent: { name: "Parent" },
      });
    });
  });

  describe("order again", () => {
    it("takes the last 5 non-cancelled orders, newest first, that have re-orderable lines", async () => {
      await service.getSuggestions("c1");
      const args = prisma.order.findMany.mock.calls[0][0];
      expect(ORDER_AGAIN_COUNT).toBe(5);
      expect(args.take).toBe(5);
      expect(args.where.status).toEqual({ not: "CANCELLED" });
      expect(args.orderBy).toEqual([
        { orderDate: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
        { id: "desc" },
      ]);
      // Cancelled and ad-hoc (unlisted) lines never come back as lines to re-add.
      expect(args.where.lineItems).toEqual({
        some: { productId: { not: null }, status: { not: "CANCELLED" }, compositionMode: null },
      });
      expect(args.select.lineItems.where).toEqual({
        productId: { not: null },
        status: { not: "CANCELLED" },
        compositionMode: null,
      });
    });

    it("summarises each order: id, number, date and its lines as ordered", async () => {
      prisma.order.findMany.mockResolvedValue([
        orderRow("o1", {
          orderDate: new Date("2026-09-28T00:00:00Z"),
          lineItems: [
            {
              productId: "p1",
              qty: D(30),
              boxes: 2,
              pieces: 6,
              unitsPerBox: 12,
              unitLabel: null,
            },
            {
              productId: "p2",
              qty: D(4),
              boxes: null,
              pieces: null,
              unitsPerBox: null,
              unitLabel: "Carton",
            },
          ],
        }),
        orderRow("o2"),
      ]);
      prisma.product.findMany.mockResolvedValue([product("p1"), product("p2")]);
      const out = await service.getSuggestions("c1");
      expect(out.recentOrders).toHaveLength(2);
      expect(out.recentOrders[0]).toEqual({
        id: "o1",
        orderNumber: "ORD-o1",
        date: "2026-09-28T00:00:00.000Z",
        status: "DELIVERED",
        lines: [
          { productId: "p1", qty: 30, boxes: 2, pieces: 6, unitsPerBox: 12, unitLabel: null },
          {
            productId: "p2",
            qty: 4,
            boxes: null,
            pieces: null,
            unitsPerBox: null,
            unitLabel: "Carton",
          },
        ],
      });
      // No business date -> the entry timestamp.
      expect(out.recentOrders[1].date).toBe("2026-09-30T09:00:00.000Z");
    });

    it("includes products only the recent orders reference (inactive ones flagged)", async () => {
      prisma.order.findMany.mockResolvedValue([orderRow("o1")]);
      prisma.product.findMany.mockResolvedValue([product("p1", { isActive: false })]);
      const out = await service.getSuggestions("c1");
      expect(prisma.product.findMany.mock.calls[0][0].where.id).toEqual({ in: ["p1"] });
      expect(out.products.p1.isActive).toBe(false);
      expect(out.usuallyBuys).toEqual([]);
    });
  });

  it("answers empty for a customer who never ordered, without a product read", async () => {
    const out = await service.getSuggestions("c1");
    expect(out).toEqual({ customerId: "c1", usuallyBuys: [], recentOrders: [], products: {} });
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });
});
