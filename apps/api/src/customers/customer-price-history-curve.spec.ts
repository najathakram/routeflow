import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import {
  COMPARE_INVOICE_CAP,
  COMPARE_WINDOW_DAYS,
  CustomerPriceHistoryService,
} from "./customer-price-history.service";
import {
  COMPARE_MIN_CUSTOMERS_NO_SALES_ACCESS,
  compareMinCustomers,
} from "./price-history-comparison";

/**
 * W-1058 H-2 (SA-1069 A-2 section 2): the curve draws every month with a value. Normal staff have no floor on the
 * lines or the panel; the curve has no date bound (the invoice cap is the only bound); the panel is the last 180 days
 * back from the newest sale to ANOTHER customer; an OPERATOR denied both ORDERS and FINANCE keeps a floor of 3,
 * decided on the server from the denials the controller passes in. Only real months are sent, never an invented one.
 */
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
type Item = Record<string, unknown>;
const piece = (price: number): Item => ({
  unitPrice: price,
  unitLabel: null,
  unitsPerBox: null,
  boxes: null,
  pieces: null,
  qty: 1,
});
let seq = 0;
const saleAt = (cid: string, item: Item, when: Date | string) => ({
  id: `inv-${++seq}`,
  invoiceNumber: `INV-${seq}`,
  customerId: cid,
  issueDate: typeof when === "string" ? new Date(`${when}T00:00:00Z`) : when,
  orderId: `o-${seq}`,
  order: { orderNumber: `ORD-${seq}` },
  items: [{ id: `it-${seq}`, productId: "p1", priceType: "STANDARD", ...item }],
});
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const monthOf = (d: Date) => d.toISOString().slice(0, 7);

const NO_SALES_ACCESS = ["ORDERS", "FINANCE"];

describe("W-1058 H-2: the price history curve (API)", () => {
  let service: CustomerPriceHistoryService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    seq = 0;
    prisma = createMockPrisma();
    prisma.customer.findFirst.mockResolvedValue({ id: "c1", businessName: "Acme", pricingTier: 1 });
    prisma.product.findFirst.mockResolvedValue(PRODUCT);
    prisma.customerPrice.findFirst.mockResolvedValue(null);
    prisma.order.findMany.mockResolvedValue([]);
    prisma.stockMovement.findMany.mockResolvedValue([]);
    const mod = await Test.createTestingModule({
      providers: [CustomerPriceHistoryService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(CustomerPriceHistoryService);
  });

  /** `own`: this customer's history read (filtered to the customer); `all`: the compare read (every customer). */
  const world = (own: unknown[], all: unknown[]) =>
    prisma.invoice.findMany.mockImplementation(async (args: any) =>
      args.where.customerId ? own : all,
    );
  /** `"not passed"`: the controller handed no denials in (the service must fail closed for an OPERATOR). */
  const run = (denied: readonly string[] | "not passed" = []) =>
    service.getHistory("c1", "p1", {
      role: UserRole.OPERATOR,
      compare: "all",
      deniedGroups: denied === "not passed" ? undefined : denied,
    }) as Promise<any>;
  const pc = (r: any) => r.comparison.find((e: any) => e.unitLabel === "pc");
  const compareCall = () =>
    prisma.invoice.findMany.mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => !a.where.customerId);

  describe("H5: a month with one other buyer is drawn", () => {
    it("line 2 and line 3 both carry the month (red on master: withheld under 3 other buyers)", async () => {
      const mine = saleAt("c1", piece(2), "2026-03-05");
      world([mine], [mine, saleAt("c2", piece(2.1), "2026-03-07")]);
      const e = pc(await run());
      expect(e.likeForLike).toEqual([{ month: "2026-03", average: 2.1 }]);
      expect(e.converted).toEqual([{ month: "2026-03", average: 2.05 }]);
    });
  });

  describe("H8 / H-2.2: only real months are sent", () => {
    it("sales in Jan and Apr and nothing between: two points, no Feb or Mar", async () => {
      const mine = saleAt("c1", piece(2), "2026-01-05");
      world(
        [mine],
        [
          mine,
          saleAt("c2", piece(2.2), "2026-01-06"),
          saleAt("c2", piece(2.4), "2026-04-06"),
          saleAt("c1", piece(2.6), "2026-04-08"),
        ],
      );
      const e = pc(await run());
      expect(e.likeForLike.map((p: any) => p.month)).toEqual(["2026-01", "2026-04"]);
      expect(e.converted.map((p: any) => p.month)).toEqual(["2026-01", "2026-04"]);
      expect(JSON.stringify(e)).not.toMatch(/2026-0[23]/);
    });
  });

  describe("H9: one sale in all", () => {
    it("sends exactly one point on line 3 and none on line 2", async () => {
      const mine = saleAt("c1", piece(2), "2026-03-05");
      world([mine], [mine]);
      const e = pc(await run());
      expect(e.converted).toEqual([{ month: "2026-03", average: 2 }]);
      expect(e.likeForLike).toEqual([]);
    });
  });

  describe("H10 / H-2.5: no date bound", () => {
    it("an other-customer sale 300 days old is on the curve, and the compare read has no issueDate filter", async () => {
      const old = daysAgo(300);
      const mine = saleAt("c1", piece(2), old);
      world([mine], [mine, saleAt("c2", piece(2.4), old)]);
      const e = pc(await run());
      expect(e.likeForLike).toEqual([{ month: monthOf(old), average: 2.4 }]);
      const call = compareCall();
      expect(call.where.issueDate).toBeUndefined();
      expect(call.where.tenantId).toBe("test-tenant");
      expect(call.where.customerId).toBeUndefined();
      expect(call.take).toBe(COMPARE_INVOICE_CAP);
    });
  });

  describe("H11 / H-2.1: a month with only this customer's sales", () => {
    it("has a point on line 3 and none on line 2", async () => {
      const mine = saleAt("c1", piece(2), "2026-02-05");
      world(
        [mine],
        [mine, saleAt("c2", piece(2.2), "2026-03-06"), saleAt("c1", piece(3), "2026-03-09")],
      );
      const e = pc(await run());
      expect(e.converted.map((p: any) => p.month)).toEqual(["2026-02", "2026-03"]);
      expect(e.likeForLike.map((p: any) => p.month)).toEqual(["2026-03"]);
    });
  });

  describe("H12 / H-2.8: the panel is 180 days back from the newest sale to another customer", () => {
    it("the newest other sale 300 days ago: the panel shows it, with its month", async () => {
      const newest = daysAgo(300);
      const mine = saleAt("c1", piece(5), daysAgo(2));
      world([mine], [mine, saleAt("c2", piece(2.4), newest)]);
      const r = await run();
      expect(r.aggregate).toEqual({
        low: 2.4,
        median: 2.4,
        high: 2.4,
        customers: 1,
        unitLabel: "pc",
        newestMonth: monthOf(newest),
      });
    });

    it("counts back from that sale, not from today, and drops anything older than the window", async () => {
      const newest = daysAgo(300);
      const inside = new Date(newest.getTime() - (COMPARE_WINDOW_DAYS - 1) * 86_400_000);
      const outside = new Date(newest.getTime() - (COMPARE_WINDOW_DAYS + 20) * 86_400_000);
      const mine = saleAt("c1", piece(5), daysAgo(2));
      world(
        [mine],
        [
          mine,
          saleAt("c2", piece(2), newest),
          saleAt("c3", piece(4), inside),
          saleAt("c4", piece(99), outside),
        ],
      );
      const r = await run();
      expect(r.aggregate).toMatchObject({ low: 2, high: 4, customers: 2 });
      expect(r.aggregate.newestMonth).toBe(monthOf(newest));
    });

    it("this customer's own sales never set the window or the figures", async () => {
      const mine = saleAt("c1", piece(500), daysAgo(1));
      world([mine], [mine]);
      expect((await run()).aggregate).toBeNull();
    });
  });

  describe("H13 / H-2.10: the staff-only check lives on the server", () => {
    const month = (m: string, buyers: string[]) =>
      buyers.map((b, i) => saleAt(b, piece(2 + i / 10), `${m}-0${i + 1}`));

    it("an OPERATOR denied ORDERS and FINANCE: a one-buyer month is withheld, a month of 3 joins", async () => {
      const mine = saleAt("c1", piece(2), "2026-02-05");
      const all = [
        mine,
        ...month("2026-03", ["c2"]),
        ...month("2026-04", ["c2", "c3", "c4"]),
        saleAt("c1", piece(3), "2026-05-09"), // a month with only this customer's sales
      ];
      world([mine], all);
      const r = await run(NO_SALES_ACCESS);
      const e = pc(r);
      expect(e.likeForLike.map((p: any) => p.month)).toEqual(["2026-04"]);
      expect(e.converted.map((p: any) => p.month)).toEqual(["2026-04"]);
    });

    it("the same OPERATOR's panel keeps the floor of 3", async () => {
      const mine = saleAt("c1", piece(2), "2026-02-05");
      world(
        [mine],
        [mine, saleAt("c2", piece(2.1), "2026-03-07"), saleAt("c3", piece(2.2), "2026-03-08")],
      );
      expect((await run(NO_SALES_ACCESS)).aggregate).toBeNull();
      world(
        [mine],
        [
          mine,
          saleAt("c2", piece(2.1), "2026-03-07"),
          saleAt("c3", piece(2.2), "2026-03-08"),
          saleAt("c4", piece(2.3), "2026-03-09"),
        ],
      );
      expect((await run(NO_SALES_ACCESS)).aggregate).toMatchObject({ customers: 3 });
    });

    it("an OPERATOR denied only ORDERS, or only FINANCE, gets no floor", async () => {
      const mine = saleAt("c1", piece(2), "2026-02-05");
      world([mine], [mine, saleAt("c2", piece(2.1), "2026-03-07")]);
      expect(pc(await run(["ORDERS"])).likeForLike).toHaveLength(1);
      expect(pc(await run(["FINANCE"])).likeForLike).toHaveLength(1);
      expect(pc(await run(["PRICING", "ORDERS", "INVENTORY"] as never)).likeForLike).toHaveLength(
        1,
      );
    });

    it("an OPERATOR whose denials were not passed in fails closed (floor 3)", async () => {
      const mine = saleAt("c1", piece(2), "2026-02-05");
      world([mine], [mine, saleAt("c2", piece(2.1), "2026-03-07")]);
      const r = await run("not passed");
      expect(pc(r).likeForLike).toEqual([]);
      expect(r.aggregate).toBeNull();
    });

    it("a TENANT_ADMIN is unaffected by the groups handed in", async () => {
      const mine = saleAt("c1", piece(2), "2026-02-05");
      world([mine], [mine, saleAt("c2", piece(2.1), "2026-03-07")]);
      const r = (await service.getHistory("c1", "p1", {
        role: UserRole.TENANT_ADMIN,
        compare: "all",
        deniedGroups: NO_SALES_ACCESS,
      })) as any;
      expect(pc(r).likeForLike).toHaveLength(1);
    });

    describe("the predicate", () => {
      it("is one named constant, 3", () => {
        expect(COMPARE_MIN_CUSTOMERS_NO_SALES_ACCESS).toBe(3);
      });
      it.each([
        [UserRole.OPERATOR, ["ORDERS", "FINANCE"], 3],
        [UserRole.OPERATOR, ["FINANCE", "ORDERS", "PRICING"], 3],
        [UserRole.OPERATOR, ["ORDERS"], 0],
        [UserRole.OPERATOR, ["FINANCE"], 0],
        [UserRole.OPERATOR, [], 0],
        [UserRole.OPERATOR, undefined, 3],
        [UserRole.TENANT_ADMIN, ["ORDERS", "FINANCE"], 0],
        [UserRole.TENANT_ADMIN, [], 0],
        [UserRole.SUPER_ADMIN, ["ORDERS", "FINANCE"], 0],
        [UserRole.DRIVER, [], 3],
        [null, [], 3],
      ])("%s denied %j -> floor %s", (role, denied, floor) => {
        expect(compareMinCustomers(role, denied)).toBe(floor);
      });
    });
  });

  describe("H14: the payload carries no customer id or name", () => {
    it("neither the lines nor the panel", async () => {
      const mine = saleAt("c1", piece(2), "2026-03-05");
      world(
        [mine],
        [
          mine,
          saleAt("secret-c2", piece(2.1), "2026-03-06"),
          saleAt("secret-c3", piece(2.2), "2026-03-07"),
        ],
      );
      const r = await run();
      const json = JSON.stringify([r.comparison, r.aggregate]);
      expect(json).not.toMatch(/secret|customerId|businessName|"c1"|Acme/i);
      expect(Object.keys(r.aggregate).sort()).toEqual(
        ["customers", "high", "low", "median", "newestMonth", "unitLabel"].sort(),
      );
      expect(Object.keys(r.comparison[0]).sort()).toEqual(
        ["converted", "likeForLike", "unitLabel", "unitsPerBox"].sort(),
      );
    });
  });
});
