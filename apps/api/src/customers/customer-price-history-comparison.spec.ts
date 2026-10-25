import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { CustomerPriceHistoryService } from "./customer-price-history.service";

/**
 * SA-954 (owner 16:15Z): `?compare=all` carries, per plot unit, two reference lines next to this customer's own:
 *  - likeForLike (line 2): OTHER customers' lines in the plot unit's name AND pack, monthly mean of the line price;
 *  - converted (line 3): ALL customers' lines with a known pack, in any unit, monthly per-base mean re-expressed in the
 *    plot unit with ONE rounding (F6: 25.11 per Box of 12, never the round-first 25.08).
 * Floor: at least 3 distinct OTHER buyers in the month, for both lines (this customer's lines count in line 3's mean, never
 * toward its floor). A line whose pack cannot be read is left out, never guessed. The plot units come from this
 * customer's own rows; with none, the summary unit. `aggregate` stays other-customers-only.
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
const MONTH = "2026-09-";

type Item = Record<string, unknown>;
const piece = (price: number): Item => ({
  unitPrice: price,
  unitLabel: null,
  unitsPerBox: null,
  boxes: null,
  pieces: null,
  qty: 1,
});
/** A named-unit line of `pack` pieces, sold by the unit (the shape buildLine writes). */
const unit = (label: string, pack: number, price: number): Item => ({
  unitPrice: price,
  unitLabel: label,
  unitsPerBox: pack,
  boxes: 1,
  pieces: 0,
  qty: pack,
});
/** A pre-snapshot line: split but no usable snapshot, so its pack is unknown. */
const unknownPack = (label: string, price: number): Item => ({
  unitPrice: price,
  unitLabel: label,
  unitsPerBox: null,
  boxes: 1,
  pieces: 0,
  qty: 1,
});
let seq = 0;
const sale = (cid: string, item: Item, day = "05", month = MONTH) => ({
  id: `inv-${++seq}`,
  invoiceNumber: `INV-${seq}`,
  customerId: cid,
  issueDate: new Date(`${month}${day}T00:00:00Z`),
  orderId: `o-${seq}`,
  order: { orderNumber: `ORD-${seq}` },
  items: [{ id: `it-${seq}`, productId: "p1", priceType: "STANDARD", ...item }],
});

describe("customer price history: comparison (SA-954)", () => {
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

  /** `own`: this customer's history read; `all`: the compare read (every customer, this one included). */
  const world = (own: unknown[], all: unknown[]) =>
    prisma.invoice.findMany.mockImplementation(async (args: any) =>
      args.where.issueDate ? all : own,
    );
  const run = () =>
    service.getHistory("c1", "p1", { role: UserRole.OPERATOR, compare: "all" }) as Promise<any>;
  const entry = (r: any, label: string, pack: number | null) =>
    (r.comparison ?? []).find((e: any) => e.unitLabel === label && e.unitsPerBox === pack);

  describe("F6 (observed): one month, four units", () => {
    // this customer: Box of 12 @ 25.00. Others: Box of 24 @ 46.80, Piece @ 2.15, Case of 48 @ 105.00, and a
    // pre-snapshot Box @ 9.99 whose pack is unknown.
    const mine = sale("c1", unit("Box", 12, 25));
    const everyone = [
      mine,
      sale("c2", unit("Box", 24, 46.8)),
      sale("c3", piece(2.15)),
      sale("c4", unit("Case", 48, 105)),
      sale("c5", unknownPack("Box", 9.99)),
    ];

    it("line 3 is 25.11 per Box of 12 (red value on #3752's head: no comparison at all)", async () => {
      world([mine], everyone);
      const e = entry(await run(), "Box", 12);
      expect(e.converted).toEqual([{ month: "2026-09", average: 25.11 }]);
    });

    it("the unknown-pack line is left out of line 3: it is not averaged and not counted toward the floor", async () => {
      // c2 and c3 known, c5 unknown: only 2 other buyers with a known pack, so the month is withheld
      world([mine], [mine, everyone[1], everyone[2], everyone[4]]);
      expect(entry(await run(), "Box", 12).converted).toEqual([]);
    });

    it("line 2 for the Box of 12 is empty: no other buyer bought that unit and pack", async () => {
      world([mine], everyone);
      expect(entry(await run(), "Box", 12).likeForLike).toEqual([]);
    });
  });

  describe("line 2 is like for like: this customer's unit AND pack", () => {
    it("the (Box, 12) entry's line 2 comes from the 12-pack buyers only; line 3 from every known-pack line", async () => {
      const mine = sale("c1", unit("Box", 12, 24));
      world(
        [mine],
        [
          mine,
          sale("c2", unit("Box", 12, 24)),
          sale("c3", unit("Box", 12, 26)),
          sale("c4", unit("Box", 12, 25)),
          sale("c5", unit("Box", 24, 60)), // the pack the other buyers mostly buy: 2.50 per piece
          sale("c6", unit("Box", 24, 60)),
          sale("c7", unit("Box", 24, 60)),
        ],
      );
      const e = entry(await run(), "Box", 12);
      expect(e.likeForLike).toEqual([{ month: "2026-09", average: 25 }]);
      // per base: 2, 2, 26/12, 25/12 x ... mean over all 7 lines, scaled to 12 pieces
      const perBase = [24 / 12, 24 / 12, 26 / 12, 25 / 12, 2.5, 2.5, 2.5];
      const mean = perBase.reduce((s, v) => s + v, 0) / perBase.length;
      expect(e.converted).toEqual([
        { month: "2026-09", average: Math.round(mean * 12 * 100) / 100 },
      ]);
      // the summary's unit is the most-bought one (Box of 24); the entry is this customer's
      expect(entry(await run(), "Box", 24)).toBeUndefined();
    });

    it("a unit with a different pack name is the same unit only by name and pack", async () => {
      const mine = sale("c1", unit("Box", 12, 24));
      world(
        [mine],
        [
          mine,
          sale("c2", unit("Case", 12, 24)),
          sale("c3", unit("Case", 12, 24)),
          sale("c4", unit("Case", 12, 24)),
        ],
      );
      // "Case" is a different unit name from "Box": no like-for-like, but line 3 converts them all
      const e = entry(await run(), "Box", 12);
      expect(e.likeForLike).toEqual([]);
      expect(e.converted).toEqual([{ month: "2026-09", average: 24 }]);
    });
  });

  describe("the floor: 3 distinct OTHER buyers per month", () => {
    const mine = sale("c1", piece(2));
    it("this customer plus 2 other buyers: line 3 is withheld", async () => {
      world([mine], [mine, sale("c2", piece(2.1)), sale("c3", piece(2.2))]);
      const e = entry(await run(), "pc", null);
      expect(e.converted).toEqual([]);
      expect(e.likeForLike).toEqual([]);
    });

    it("this customer plus 3 other buyers: line 3 shows, and line 2 shows the others' mean", async () => {
      world([mine], [mine, sale("c2", piece(2.1)), sale("c3", piece(2.2)), sale("c4", piece(2.3))]);
      const e = entry(await run(), "pc", null);
      expect(e.converted).toEqual([{ month: "2026-09", average: 2.15 }]); // (2 + 2.1 + 2.2 + 2.3) / 4
      expect(e.likeForLike).toEqual([{ month: "2026-09", average: 2.2 }]); // (2.1 + 2.2 + 2.3) / 3
    });

    it("3 sales from 2 other buyers is still below the floor", async () => {
      world([mine], [mine, sale("c2", piece(2.1)), sale("c2", piece(2.2)), sale("c3", piece(2.3))]);
      expect(entry(await run(), "pc", null).converted).toEqual([]);
    });

    it("months are judged one by one and a withheld month is a gap (never filled)", async () => {
      const aug = (c: string, p: number) => sale(c, piece(p), "10", "2026-08-");
      world(
        [mine],
        [
          mine,
          sale("c2", piece(2.1)),
          sale("c3", piece(2.2)),
          sale("c4", piece(2.3)),
          aug("c2", 9),
          aug("c3", 9),
        ],
      );
      const e = entry(await run(), "pc", null);
      expect(e.likeForLike.map((p: any) => p.month)).toEqual(["2026-09"]);
      expect(e.converted.map((p: any) => p.month)).toEqual(["2026-09"]);
    });

    it("points run oldest first", async () => {
      const mk = (m: string) => [
        sale("c2", piece(2), "05", m),
        sale("c3", piece(2), "06", m),
        sale("c4", piece(2), "07", m),
      ];
      world([mine], [mine, ...mk("2026-09-"), ...mk("2026-08-")]);
      const e = entry(await run(), "pc", null);
      expect(e.likeForLike.map((p: any) => p.month)).toEqual(["2026-08", "2026-09"]);
    });
  });

  describe("the plot units", () => {
    it("one entry per distinct (unit, pack) this customer has a known-pack row for", async () => {
      const a = sale("c1", unit("Box", 12, 24), "01");
      const b = sale("c1", piece(2), "02");
      const c = sale("c1", unknownPack("Box", 9), "03"); // unknown pack: no entry
      world([a, b, c], [a, b, c]);
      const r = await run();
      expect(r.comparison.map((e: any) => [e.unitLabel, e.unitsPerBox]).sort()).toEqual(
        [
          ["Box", 12],
          ["pc", null],
        ].sort(),
      );
    });

    it("never sold to this customer: one entry in the summary's unit (the most bought by others) at its most common pack", async () => {
      world(
        [],
        [
          sale("c2", unit("Case", 12, 100)),
          sale("c3", unit("Case", 12, 110)),
          sale("c4", unit("Case", 12, 120)),
          sale("c5", unit("Case", 24, 999)),
          sale("c6", piece(1)),
        ],
      );
      const r = await run();
      expect(r.comparison).toHaveLength(1);
      expect(r.comparison[0]).toMatchObject({ unitLabel: "Case", unitsPerBox: 12 });
      expect(r.comparison[0].likeForLike).toEqual([{ month: "2026-09", average: 110 }]);
    });

    it("never sold and no other customer's sales: no entry (the web says so)", async () => {
      world([], []);
      expect((await run()).comparison).toEqual([]);
    });
  });

  describe("what stays", () => {
    it("aggregate is still OTHER customers only: this customer's sale never moves it", async () => {
      const mine = sale("c1", piece(500));
      world([mine], [mine, sale("c2", piece(8)), sale("c3", piece(10)), sale("c4", piece(12))]);
      const r = await run();
      expect(r.aggregate).toMatchObject({
        low: 8,
        median: 10,
        high: 12,
        customers: 3,
        unitLabel: "pc",
      });
      expect(Object.keys(r.aggregate).sort()).toEqual(
        ["customers", "high", "low", "median", "unitLabel"].sort(),
      );
    });

    it("no customer id or name anywhere in comparison", async () => {
      const mine = sale("c1", piece(2));
      world(
        [mine],
        [
          mine,
          sale("secret-c2", piece(2)),
          sale("secret-c3", piece(2)),
          sale("secret-c4", piece(2)),
        ],
      );
      const r = await run();
      expect(JSON.stringify(r.comparison)).not.toMatch(/secret|customerId|businessName|c1|name/i);
      expect(Object.keys(r.comparison[0]).sort()).toEqual(
        ["converted", "likeForLike", "unitLabel", "unitsPerBox"].sort(),
      );
    });

    it("one compare read, tenant-scoped, over the 180-day window, with no customer filter", async () => {
      world([], []);
      await run();
      const call = prisma.invoice.findMany.mock.calls
        .map((c: any[]) => c[0])
        .find((a: any) => a.where.issueDate);
      expect(call.where.tenantId).toBe("test-tenant");
      expect(call.where.customerId).toBeUndefined();
      const days = (Date.now() - call.where.issueDate.gte.getTime()) / 86_400_000;
      expect(days).toBeGreaterThan(179.9);
      expect(days).toBeLessThan(180.1);
      expect(prisma.invoice.findMany).toHaveBeenCalledTimes(2);
    });

    it("no ?compare: no comparison and no compare read", async () => {
      world([], []);
      const r: any = await service.getHistory("c1", "p1", { role: UserRole.OPERATOR });
      expect("comparison" in r).toBe(false);
      expect(prisma.invoice.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe("B1073 / G4: one conversion pair in the service", () => {
    it("no price is divided or multiplied by the pack inline: the service goes through @routeflow/pricing", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const src: string = require("fs").readFileSync(
        require("path").join(__dirname, "customer-price-history.service.ts"),
        "utf8",
      );
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(/\/\s*productPackNow/);
      expect(code).not.toMatch(/pieceCost\s*\*\s*\(/);
      expect(code).toMatch(/priceInUnit\(/);
      expect(code).toMatch(/pricePerBaseUnit\(/);
    });
  });
});
