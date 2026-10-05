import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { createMockPrisma } from "../testing/prisma-mock";
import {
  CustomerOrderSuggestionsService,
  ORDER_AGAIN_COUNT,
  USUALLY_BUYS_CANDIDATES,
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

/** One groupBy row: the order-line count of a product, as the database ranks it. */
const count = (productId: string, n: number) => ({ productId, _count: { _all: n } });

const orderLine = (productId: string, o: Record<string, unknown> = {}) => ({
  productId,
  qty: D(3),
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  unitPrice: D("99.00"), // a historical price: must never reach the response
  ...o,
});

const orderRow = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  status: "DELIVERED",
  orderDate: null,
  createdAt: new Date("2026-09-30T09:00:00Z"),
  lineItems: [orderLine("p1")],
  ...o,
});

const ALLOW = { outcome: "ALLOW", reasons: [] };
const blocked = (...ids: string[]) => ({
  outcome: "BLOCK",
  reasons: ids.map((productId) => ({
    productId,
    productName: productId,
    ruleId: "r1",
    reason: "FEDERAL_BAN",
  })),
});

describe("CustomerOrderSuggestionsService", () => {
  let service: CustomerOrderSuggestionsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let restrictions: { evaluate: jest.Mock };

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    prisma = createMockPrisma();
    prisma.customer.findFirst.mockResolvedValue({ id: "c1" });
    prisma.orderItem.groupBy.mockResolvedValue([]);
    prisma.order.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([]);
    restrictions = { evaluate: jest.fn().mockResolvedValue(ALLOW) };
    const mod = await Test.createTestingModule({
      providers: [
        CustomerOrderSuggestionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SellingRestrictionsService, useValue: restrictions },
      ],
    }).compile();
    service = mod.get(CustomerOrderSuggestionsService);
  });

  afterEach(() => jest.useRealTimers());

  describe("tenant isolation", () => {
    it("scopes the customer, count, order and product reads to the request tenant", async () => {
      prisma.orderItem.groupBy.mockResolvedValue([count("p1", 2)]);
      prisma.order.findMany.mockResolvedValue([orderRow("o1")]);
      prisma.product.findMany.mockResolvedValue([product("p1")]);
      await service.getSuggestions("c1");
      expect(prisma.customer.findFirst.mock.calls[0][0].where).toEqual({
        id: "c1",
        tenantId: "test-tenant",
      });
      // OrderItem.tenantId is nullable: the count scopes THROUGH the order's tenant, never an item column.
      expect(prisma.orderItem.groupBy.mock.calls[0][0].where.order).toMatchObject({
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
      expect(restrictions.evaluate.mock.calls[0].slice(0, 2)).toEqual(["test-tenant", "c1"]);
    });

    it("404s another tenant's (unfound) customer and never reads orders", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);
      await expect(service.getSuggestions("other")).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.orderItem.groupBy).not.toHaveBeenCalled();
      expect(prisma.order.findMany).not.toHaveBeenCalled();
    });

    it("refuses a request with no tenant context", async () => {
      prisma.getTenantId.mockReturnValue(null);
      await expect(service.getSuggestions("c1")).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("usually buys", () => {
    it("counts in the database, bounded, over the last 90 days of placed, non-cancelled lines", async () => {
      await service.getSuggestions("c1");
      const args = prisma.orderItem.groupBy.mock.calls[0][0];
      const since = new Date(NOW.getTime() - USUALLY_BUYS_DAYS * 86_400_000);
      expect(USUALLY_BUYS_DAYS).toBe(90);
      expect(args.by).toEqual(["productId"]);
      expect(args.take).toBe(USUALLY_BUYS_CANDIDATES);
      expect(args.orderBy).toEqual([{ _count: { productId: "desc" } }, { productId: "asc" }]);
      expect(args.where.order.status).toEqual({ notIn: ["CANCELLED", "DRAFT"] });
      expect(args.where.status).toEqual({ not: "CANCELLED" });
      // The business date when set, else the entry timestamp.
      expect(args.where.order.OR).toEqual([
        { orderDate: { gte: since } },
        { orderDate: null, createdAt: { gte: since } },
      ]);
      expect(args.where.productId).toEqual({ not: null });
      expect(args.where.product).toEqual({ isActive: true });
      // The line read is the aggregate: nothing is pulled into memory to be counted.
      expect(prisma.orderItem.findMany).not.toHaveBeenCalled();
    });

    it("offers the top 8 in the database's order, most bought first", async () => {
      const rows = Array.from({ length: 10 }, (_, i) => count(`p${i + 1}`, 10 - i));
      prisma.orderItem.groupBy.mockResolvedValue(rows);
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

    it("returns no history prices anywhere in the payload", async () => {
      prisma.orderItem.groupBy.mockResolvedValue([count("p1", 1)]);
      prisma.order.findMany.mockResolvedValue([orderRow("o1")]);
      prisma.product.findMany.mockResolvedValue([product("p1")]);
      const out = await service.getSuggestions("c1");
      expect(JSON.stringify(out)).not.toContain("99");
      expect(JSON.stringify(out)).not.toMatch(/unitPrice|lastPrice/);
      expect(JSON.stringify(prisma.order.findMany.mock.calls[0][0].select)).not.toContain(
        "unitPrice",
      );
    });

    it("carries the product's CURRENT catalog columns, including the active flag", async () => {
      prisma.orderItem.groupBy.mockResolvedValue([count("p1", 1)]);
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
    it("takes the last 5 placed, non-cancelled orders, newest first, that have re-orderable lines", async () => {
      await service.getSuggestions("c1");
      const args = prisma.order.findMany.mock.calls[0][0];
      expect(ORDER_AGAIN_COUNT).toBe(5);
      expect(args.take).toBe(5);
      // A DRAFT is not an order yet; a cancelled one is not worth repeating.
      expect(args.where.status).toEqual({ notIn: ["CANCELLED", "DRAFT"] });
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
            orderLine("p1", { qty: D(30), boxes: 2, pieces: 6, unitsPerBox: 12 }),
            orderLine("p2", { qty: D(4), unitLabel: "Carton" }),
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

  describe("banned products (selling restrictions)", () => {
    it("asks the order-save helper once, as STAFF, about every product it might offer", async () => {
      prisma.orderItem.groupBy.mockResolvedValue([count("p1", 3), count("p2", 2)]);
      prisma.order.findMany.mockResolvedValue([
        orderRow("o1", { lineItems: [orderLine("p2"), orderLine("p3")] }),
      ]);
      prisma.product.findMany.mockResolvedValue([product("p1"), product("p2"), product("p3")]);
      await service.getSuggestions("c1");
      expect(restrictions.evaluate).toHaveBeenCalledTimes(1);
      const [, , lines, options] = restrictions.evaluate.mock.calls[0];
      expect(options).toEqual({ channel: "STAFF" });
      expect(lines.map((l: { productId: string }) => l.productId).sort()).toEqual([
        "p1",
        "p2",
        "p3",
      ]);
    });

    it("never suggests a banned product as a chip; the next product fills its place", async () => {
      const rows = Array.from({ length: 10 }, (_, i) => count(`p${i + 1}`, 10 - i));
      prisma.orderItem.groupBy.mockResolvedValue(rows);
      restrictions.evaluate.mockResolvedValue(blocked("p2"));
      prisma.product.findMany.mockResolvedValue([]);
      const out = await service.getSuggestions("c1");
      expect(out.usuallyBuys.map((u) => u.productId)).toEqual([
        "p1",
        "p3",
        "p4",
        "p5",
        "p6",
        "p7",
        "p8",
        "p9",
      ]);
      expect(prisma.product.findMany.mock.calls[0][0].where.id.in).not.toContain("p2");
    });

    it("drops a banned line from an order again, and an order left with no lines", async () => {
      restrictions.evaluate.mockResolvedValue(blocked("p2", "p9"));
      prisma.order.findMany.mockResolvedValue([
        orderRow("o1", { lineItems: [orderLine("p1"), orderLine("p2")] }),
        orderRow("o2", { lineItems: [orderLine("p9")] }),
      ]);
      prisma.product.findMany.mockResolvedValue([product("p1")]);
      const out = await service.getSuggestions("c1");
      expect(out.recentOrders.map((o) => o.id)).toEqual(["o1"]);
      expect(out.recentOrders[0].lines.map((l) => l.productId)).toEqual(["p1"]);
      expect(Object.keys(out.products)).toEqual(["p1"]);
    });

    it("fails closed on an INDETERMINATE answer, like the order save", async () => {
      restrictions.evaluate.mockResolvedValue({
        outcome: "INDETERMINATE",
        reasons: [
          {
            productId: "p1",
            productName: "p1",
            ruleId: "r1",
            reason: "INDETERMINATE_ADDRESS",
          },
        ],
      });
      prisma.orderItem.groupBy.mockResolvedValue([count("p1", 3), count("p2", 2)]);
      const out = await service.getSuggestions("c1");
      expect(out.usuallyBuys.map((u) => u.productId)).toEqual(["p2"]);
    });

    it("asks nothing when there is nothing to offer", async () => {
      await service.getSuggestions("c1");
      expect(restrictions.evaluate).not.toHaveBeenCalled();
    });
  });

  it("answers empty for a customer who never ordered, without a product read", async () => {
    const out = await service.getSuggestions("c1");
    expect(out).toEqual({ customerId: "c1", usuallyBuys: [], recentOrders: [], products: {} });
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });
});
