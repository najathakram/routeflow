import { BadRequestException, NotFoundException, ParseUUIDPipe } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { getTierPrice } from "@routeflow/pricing";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { CustomerPriceHistoryController } from "./customer-price-history.controller";
import {
  CustomerPriceHistoryService,
  PRICE_SUMMARY_MAX_PRODUCTS,
  parseProductIds,
} from "./customer-price-history.service";

// Wrap the REAL resolver so a test can prove the service calls it (never a copy of it).
jest.mock("@routeflow/pricing", () => {
  const actual = jest.requireActual("@routeflow/pricing");
  return { ...actual, getTierPrice: jest.fn(actual.getTierPrice) };
});

const PRODUCT = {
  id: "p1",
  name: "Widget",
  unit: "pc",
  unitsPerBox: null,
  averageCost: 3,
  pricePerUnit: 10,
  priceTier2: 9,
  priceTier3: 8,
  priceTier4: null,
  priceTier5: null,
};
const line = (o: Record<string, unknown> = {}) => ({
  id: "ii1",
  productId: "p1",
  product: { unit: "pc", unitsPerBox: null },
  qty: 1,
  unitPrice: 10,
  priceType: "STANDARD",
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  ...o,
});
const inv = (id: string, iso: string, price: number, extra: Record<string, unknown> = {}) => ({
  id,
  invoiceNumber: id.toUpperCase(),
  issueDate: new Date(iso),
  orderId: `o-${id}`,
  order: { orderNumber: `ORD-${id}` },
  items: [line({ id: `${id}-l`, unitPrice: price })],
  ...extra,
});
const other = (cid: string, price: number, iso = "2026-09-01T00:00:00Z", itemExtra = {}) => ({
  id: `x-${cid}-${price}`,
  customerId: cid,
  issueDate: new Date(iso),
  items: [line({ unitPrice: price, ...itemExtra })],
});

describe("CustomerPriceHistoryService v1.1", () => {
  let service: CustomerPriceHistoryService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    (getTierPrice as jest.Mock).mockClear();
    prisma = createMockPrisma();
    prisma.customer.findFirst.mockResolvedValue({
      id: "c1",
      businessName: "Acme Foods",
      pricingTier: 2,
    });
    prisma.product.findFirst.mockResolvedValue(PRODUCT);
    prisma.customerPrice.findFirst.mockResolvedValue(null);
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.order.findMany.mockResolvedValue([]);
    prisma.stockMovement.findMany.mockResolvedValue([]);
    const mod = await Test.createTestingModule({
      providers: [CustomerPriceHistoryService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(CustomerPriceHistoryService);
  });

  const run = (o: { compare?: string } = {}) =>
    service.getHistory("c1", "p1", { role: UserRole.OPERATOR, compare: o.compare });

  describe("references", () => {
    it("tierPrice goes through the real getTierPrice with the customer's default tier", async () => {
      prisma.invoice.findMany.mockResolvedValue([inv("a", "2026-06-10T00:00:00Z", 10)]);
      const r = await run();
      expect(getTierPrice).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }), 2);
      expect(r.references).toEqual({ listPrice: 10, tierPrice: 9, changeSinceLast: null });
    });

    it("a per-product CustomerPrice tier wins over the customer default (order-create rule)", async () => {
      prisma.customerPrice.findFirst.mockResolvedValue({ pricingTier: 3 });
      prisma.invoice.findMany.mockResolvedValue([inv("a", "2026-06-10T00:00:00Z", 10)]);
      const r = await run();
      expect(getTierPrice).toHaveBeenCalledWith(expect.anything(), 3);
      expect(r.references.tierPrice).toBe(8);
    });

    it("a null CustomerPrice.pricingTier (MSRP-only row) falls back to the customer tier", async () => {
      prisma.customerPrice.findFirst.mockResolvedValue({ pricingTier: null });
      prisma.invoice.findMany.mockResolvedValue([inv("a", "2026-06-10T00:00:00Z", 10)]);
      expect((await run()).references.tierPrice).toBe(9);
    });

    it("is null for list and tier when there is no history row", async () => {
      const r = await run();
      expect(r.references).toEqual({ listPrice: null, tierPrice: null, changeSinceLast: null });
    });

    it("changeSinceLast = (last - previous) / previous in the same unit, 4dp", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        inv("b", "2026-06-10T00:00:00Z", 10.5),
        inv("a", "2026-05-10T00:00:00Z", 9.7),
      ]);
      // (10.5 - 9.7) / 9.7 = 0.082474...
      expect((await run()).references.changeSinceLast).toBe(0.0825);
    });

    it("changeSinceLast ignores rows of another unit and is null when previous is 0", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        inv("c", "2026-06-10T00:00:00Z", 10),
        inv("b", "2026-05-10T00:00:00Z", 50, {
          items: [line({ unitPrice: 50, unitLabel: "Case", boxes: 2, pieces: 0, unitsPerBox: 12 })],
        }),
      ]);
      expect((await run()).references.changeSinceLast).toBeNull();
      prisma.invoice.findMany.mockResolvedValue([
        inv("c", "2026-06-10T00:00:00Z", 10),
        inv("a", "2026-05-10T00:00:00Z", 0),
      ]);
      expect((await run()).references.changeSinceLast).toBeNull();
    });

    it("a case row quotes list/tier per case (price per pack), a piece row per piece", async () => {
      prisma.product.findFirst.mockResolvedValue({ ...PRODUCT, unitsPerBox: 12 });
      prisma.invoice.findMany.mockResolvedValue([
        inv("a", "2026-06-10T00:00:00Z", 100, {
          items: [
            line({
              unitPrice: 100,
              unitLabel: "Case",
              unitsPerBox: 12,
              boxes: 1,
              pieces: 0,
              qty: 12,
            }),
          ],
        }),
      ]);
      expect((await run()).references).toMatchObject({ listPrice: 10, tierPrice: 9 });
      prisma.invoice.findMany.mockResolvedValue([
        inv("a", "2026-06-10T00:00:00Z", 1, {
          items: [line({ unitPrice: 1, unitLabel: "Piece", unitsPerBox: 1 })],
        }),
      ]);
      const r = await run();
      expect(r.rows[0].unitsPerBox).toBeNull();
      expect(r.references.listPrice).toBe(0.83);
    });
  });

  describe("?compare=all aggregate", () => {
    const withOthers = (rows: unknown[]) =>
      prisma.invoice.findMany.mockImplementation(async (args: any) =>
        args.where.customerId?.not ? rows : [inv("a", "2026-06-10T00:00:00Z", 10)],
      );
    const othersCall = () =>
      prisma.invoice.findMany.mock.calls
        .map((c: any[]) => c[0])
        .find((a: any) => a.where.customerId?.not);

    it("is absent without ?compare and issues no extra invoice query", async () => {
      const r = await run();
      expect("aggregate" in r).toBe(false);
      expect(prisma.invoice.findMany).toHaveBeenCalledTimes(1);
    });

    it("low/median/high over OTHER customers, excluding this one, tenant-scoped, 180 days", async () => {
      withOthers([other("c2", 8), other("c3", 12), other("c4", 10), other("c5", 14)]);
      const r = await run({ compare: "all" });
      expect(r.aggregate).toEqual({
        low: 8,
        median: 11,
        high: 14,
        customers: 4,
        unitLabel: "pc",
      });
      const call = othersCall();
      expect(call.where.customerId).toEqual({ not: "c1" });
      expect(call.where.tenantId).toBe("test-tenant");
      expect(call.where.status).toBeDefined();
      const days = (Date.now() - call.where.issueDate.gte.getTime()) / 86_400_000;
      expect(days).toBeGreaterThan(179.9);
      expect(days).toBeLessThan(180.1);
    });

    it("never leaks a customer id or name", async () => {
      withOthers([other("secret-c2", 8), other("secret-c3", 12), other("secret-c4", 10)]);
      const r = await run({ compare: "all" });
      expect(JSON.stringify(r.aggregate)).not.toMatch(/secret|customerId|businessName|name/i);
      expect(Object.keys(r.aggregate!).sort()).toEqual(
        ["customers", "high", "low", "median", "unitLabel"].sort(),
      );
      expect(JSON.stringify(othersCall().select)).not.toMatch(/businessName|customer:/);
    });

    it("is null with fewer than 3 distinct other customers (2 customers, many invoices)", async () => {
      withOthers([other("c2", 8), other("c2", 9), other("c3", 12), other("c3", 13)]);
      expect((await run({ compare: "all" })).aggregate).toBeNull();
      withOthers([]);
      expect((await run({ compare: "all" })).aggregate).toBeNull();
    });

    it("uses the most common unit only (units never mixed)", async () => {
      withOthers([
        other("c2", 8),
        other("c3", 9),
        other("c4", 10),
        other("c5", 99, undefined, { unitLabel: "Case", unitsPerBox: 12 }),
        other("c6", 98, undefined, { unitLabel: "Case", unitsPerBox: 12 }),
      ]);
      const a = (await run({ compare: "all" })).aggregate!;
      expect(a.unitLabel).toBe("pc");
      expect(a.high).toBe(10);
      expect(a.customers).toBe(3);
    });

    it("ignores any value other than 'all'", async () => {
      expect("aggregate" in (await run({ compare: "yes" }))).toBe(false);
    });
  });

  describe("price-summary batch", () => {
    const sum = (ids: string) => service.getPriceSummary("c1", ids, { role: UserRole.OPERATOR });

    it("the API cap equals the shared PRICE_SUMMARY_MAX_PRODUCTS", () => {
      const shared = (require("@routeflow/types") as { PRICE_SUMMARY_MAX_PRODUCTS: number })
        .PRICE_SUMMARY_MAX_PRODUCTS;
      expect(PRICE_SUMMARY_MAX_PRODUCTS).toBe(shared);
    });

    it("rejects empty and >50 distinct ids; dedupes", async () => {
      await expect(sum("")).rejects.toBeInstanceOf(BadRequestException);
      const ids51 = Array.from({ length: PRICE_SUMMARY_MAX_PRODUCTS + 1 }, (_, i) => `p${i}`);
      await expect(sum(ids51.join(","))).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.invoice.findMany).not.toHaveBeenCalled();
      expect(parseProductIds("a, b,a,,b ")).toEqual(["a", "b"]);
      const ids50 = ids51.slice(0, 50);
      await expect(sum(ids50.join(","))).resolves.toEqual(
        Object.fromEntries(
          ids50.map((i) => [
            i,
            { last3: [], low: null, high: null, unitLabel: null, unitsPerBox: null },
          ]),
        ),
      );
    });

    it("404s an unknown customer (tenant isolation) before reading sales", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);
      await expect(sum("p1")).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.customer.findFirst.mock.calls[0][0].where).toEqual({
        id: "c1",
        tenantId: "test-tenant",
      });
      expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    });

    it("reads ONCE, through Invoice with the tenant and the customer", async () => {
      await sum("p1,p2,p3");
      expect(prisma.invoice.findMany).toHaveBeenCalledTimes(1);
      const where = prisma.invoice.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        tenantId: "test-tenant",
        customerId: "c1",
        items: { some: { productId: { in: ["p1", "p2", "p3"] } } },
      });
      expect(where.status).toBeDefined();
    });

    it("splits per product: last3 newest-first, low/high over the returned lines", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        {
          ...inv("d", "2026-06-04T00:00:00Z", 12),
          items: [line({ productId: "p1", unitPrice: 12 })],
        },
        {
          ...inv("c", "2026-06-03T00:00:00Z", 5),
          items: [
            line({ productId: "p1", unitPrice: 11 }),
            line({ productId: "p2", unitPrice: 5 }),
          ],
        },
        {
          ...inv("b", "2026-06-02T00:00:00Z", 10),
          items: [line({ productId: "p1", unitPrice: 10 })],
        },
        {
          ...inv("a", "2026-06-01T00:00:00Z", 9),
          items: [line({ productId: "p1", unitPrice: 9 })],
        },
      ]);
      const r = await sum("p1,p2,p9");
      expect(r.p1.last3.map((x) => x.unitPrice)).toEqual([12, 11, 10]);
      expect(r.p1.last3[0]).toEqual({
        date: "2026-06-04T00:00:00.000Z",
        unitPrice: 12,
        unitLabel: "pc",
        unitsPerBox: null,
      });
      expect([r.p1.low, r.p1.high]).toEqual([9, 12]);
      expect(r.p2).toEqual({
        last3: [
          { date: "2026-06-03T00:00:00.000Z", unitPrice: 5, unitLabel: "pc", unitsPerBox: null },
        ],
        low: 5,
        high: 5,
        unitLabel: "pc",
        unitsPerBox: null,
      });
      expect(r.p9).toEqual({
        last3: [],
        low: null,
        high: null,
        unitLabel: null,
        unitsPerBox: null,
      });
    });

    it("excludeOrderId drops the order being edited: its invoice never reaches last3, low or high (hunt2 F6)", async () => {
      // Newest priced line is on the order being edited (o9); an older one is on another order; the
      // oldest is an invoice with no order (it stays, as in the history endpoint).
      const rows = [
        {
          ...inv("n", "2026-06-05T00:00:00Z", 20, { orderId: "o9" }),
          items: [line({ productId: "p1", unitPrice: 20 })],
        },
        {
          ...inv("m", "2026-06-01T00:00:00Z", 10),
          items: [line({ productId: "p1", unitPrice: 10 })],
        },
        {
          ...inv("l", "2026-05-01T00:00:00Z", 8, { orderId: null }),
          items: [line({ productId: "p1", unitPrice: 8 })],
        },
      ];
      // A DB double that honours the order filter the history endpoint uses.
      prisma.invoice.findMany.mockImplementation(async (args: any) => {
        const or: Array<Record<string, any>> | undefined = args.where.OR;
        return rows.filter(
          (r) =>
            !or ||
            or.some((c) =>
              c.orderId === null ? r.orderId === null : r.orderId !== c.orderId?.not,
            ),
        );
      });
      const plain = await sum("p1");
      expect(plain.p1.last3.map((x) => x.unitPrice)).toEqual([20, 10, 8]);
      expect([plain.p1.low, plain.p1.high]).toEqual([8, 20]);

      const edited = await service.getPriceSummary("c1", "p1", {
        role: UserRole.OPERATOR,
        excludeOrderId: "o9",
      });
      expect(edited.p1.last3.map((x) => x.unitPrice)).toEqual([10, 8]);
      expect([edited.p1.low, edited.p1.high]).toEqual([8, 10]);
    });

    it("without excludeOrderId the read has no order filter at all", async () => {
      await sum("p1");
      expect(prisma.invoice.findMany.mock.calls[0][0].where.OR).toBeUndefined();
    });

    it("never mixes units: low/high are over the NEWEST sale's unit group and carry that unit", async () => {
      // a $2 piece price (newest) and a $24 case price (older): the range must not be $2-$24
      prisma.invoice.findMany.mockResolvedValue([
        {
          ...inv("c", "2026-06-03T00:00:00Z", 2),
          items: [line({ productId: "p1", unitPrice: 2.5, unitLabel: "Each" })],
        },
        {
          ...inv("b", "2026-06-02T00:00:00Z", 24),
          items: [
            line({
              productId: "p1",
              unitPrice: 24,
              unitLabel: "Case",
              boxes: 2,
              pieces: 0,
              unitsPerBox: 12,
            }),
          ],
        },
        {
          ...inv("a", "2026-06-01T00:00:00Z", 2),
          items: [line({ productId: "p1", unitPrice: 2, unitLabel: "Each" })],
        },
      ]);
      const r = await sum("p1");
      expect([r.p1.low, r.p1.high, r.p1.unitLabel, r.p1.unitsPerBox]).toEqual([
        2,
        2.5,
        "Each",
        null,
      ]);

      // newest is the case: the figures are case figures
      prisma.invoice.findMany.mockResolvedValue([
        {
          ...inv("d", "2026-06-04T00:00:00Z", 26),
          items: [
            line({
              productId: "p1",
              unitPrice: 26,
              unitLabel: "Case",
              boxes: 2,
              pieces: 0,
              unitsPerBox: 12,
            }),
          ],
        },
        {
          ...inv("c", "2026-06-03T00:00:00Z", 2),
          items: [line({ productId: "p1", unitPrice: 2, unitLabel: "Each" })],
        },
        {
          ...inv("b", "2026-06-02T00:00:00Z", 24),
          items: [
            line({
              productId: "p1",
              unitPrice: 24,
              unitLabel: "Case",
              boxes: 2,
              pieces: 0,
              unitsPerBox: 12,
            }),
          ],
        },
      ]);
      const r2 = await sum("p1");
      expect([r2.p1.low, r2.p1.high, r2.p1.unitLabel, r2.p1.unitsPerBox]).toEqual([
        24,
        26,
        "Case",
        12,
      ]);
    });

    it("each last3 row carries its OWN pack size (a 24-pack and a 12-pack are not interchangeable)", async () => {
      const boxLine = (price: number, pack: number | null) =>
        line({
          productId: "p1",
          unitPrice: price,
          unitLabel: "Box",
          boxes: 1,
          pieces: 0,
          unitsPerBox: pack,
        });
      prisma.invoice.findMany.mockResolvedValue([
        { ...inv("c", "2026-06-03T00:00:00Z", 24), items: [boxLine(24, 24)] },
        { ...inv("b", "2026-06-02T00:00:00Z", 12), items: [boxLine(12, 12)] },
        {
          ...inv("a", "2026-06-01T00:00:00Z", 2),
          items: [line({ productId: "p1", unitPrice: 2, unitLabel: "Each" })],
        },
      ]);
      const r = await sum("p1");
      expect(r.p1.last3.map((x) => [x.unitPrice, x.unitLabel, x.unitsPerBox])).toEqual([
        [24, "Box", 24],
        [12, "Box", 12],
        [2, "Each", null],
      ]);
    });

    it("matches the single endpoint's invoiced rows for the same product", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        inv("c", "2026-06-03T00:00:00Z", 11),
        inv("b", "2026-06-02T00:00:00Z", 10.5, {
          items: [
            line({ unitPrice: 126, unitLabel: "Case", boxes: 2, pieces: 0, unitsPerBox: 12 }),
          ],
        }),
        inv("a", "2026-06-01T00:00:00Z", 9),
      ]);
      const single = await run();
      const batch = await sum("p1");
      expect(batch.p1.last3).toEqual(
        single.rows
          .filter((x) => x.source === "INVOICE")
          .slice(0, 3)
          .map((x) => ({
            date: x.date,
            unitPrice: x.unitPrice,
            unitLabel: x.unitLabel,
            unitsPerBox: x.unitsPerBox,
          })),
      );
    });
  });

  describe("controller", () => {
    it("price-summary is staff only and routed at customers/:customerId/price-summary", () => {
      const proto = CustomerPriceHistoryController.prototype;
      expect(Reflect.getMetadata("path", proto.getPriceSummary)).toBe(":customerId/price-summary");
      expect(Reflect.getMetadata(ROLES_KEY, proto.getPriceSummary)).toEqual([UserRole.OPERATOR]);
    });

    it("passes compare and productIds through", async () => {
      const svc = {
        getHistory: jest.fn().mockResolvedValue({}),
        getPriceSummary: jest.fn().mockResolvedValue({}),
      };
      const c = new CustomerPriceHistoryController(svc as any);
      const user = { role: UserRole.OPERATOR } as any;
      await c.getPriceHistory("c1", "p1", "10", "all", user);
      expect(svc.getHistory).toHaveBeenCalledWith("c1", "p1", {
        limit: "10",
        compare: "all",
        role: UserRole.OPERATOR,
      });
      await c.getPriceSummary("c1", "a,b", user);
      expect(svc.getPriceSummary).toHaveBeenCalledWith("c1", "a,b", { role: UserRole.OPERATOR });
    });

    it("price-summary passes the edited order's id through as excludeOrderId (hunt2 F6)", async () => {
      const svc = { getPriceSummary: jest.fn().mockResolvedValue({}) };
      const c = new CustomerPriceHistoryController(svc as any);
      const user = { role: UserRole.OPERATOR } as any;
      await c.getPriceSummary("c1", "a,b", user, "3f2c7a54-1b2c-4d5e-8f90-1234567890ab");
      expect(svc.getPriceSummary).toHaveBeenCalledWith("c1", "a,b", {
        role: UserRole.OPERATOR,
        excludeOrderId: "3f2c7a54-1b2c-4d5e-8f90-1234567890ab",
      });
    });

    it("price-summary validates excludeOrderId as an optional UUID (a repeated param is a 400)", async () => {
      const args = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        CustomerPriceHistoryController,
        "getPriceSummary",
      ) as Record<string, { data?: string; pipes?: unknown[] }>;
      const param = Object.values(args).find((a) => a.data === "excludeOrderId");
      const pipe = param?.pipes?.find((p) => p instanceof ParseUUIDPipe) as
        ParseUUIDPipe | undefined;
      expect(pipe).toBeDefined();
      const meta = { type: "query" as const, data: "excludeOrderId" };
      await expect(pipe!.transform(undefined as never, meta)).resolves.toBeUndefined();
      await expect(pipe!.transform(["a", "b"] as never, meta)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
