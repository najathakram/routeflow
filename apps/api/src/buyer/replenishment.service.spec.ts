import { Test } from "@nestjs/testing";
import { ReplenishmentService } from "./replenishment.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("ReplenishmentService", () => {
  let service: ReplenishmentService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const NOW = new Date("2026-07-09T00:00:00.000Z");
  const DAY = 86_400_000;
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

  const prod = (over: Record<string, unknown>) => ({
    id: "p",
    name: "P",
    unit: "ea",
    unitsPerBox: null,
    imageKeys: [] as string[],
    isActive: true,
    ...over,
  });

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [ReplenishmentService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(ReplenishmentService);
  });

  it("infers cadence, suggested qty and state from order history", async () => {
    const milk = prod({ id: "A", name: "Milk", unit: "gal", imageKeys: ["k1"] });
    const soda = prod({ id: "B", name: "Soda", unit: "case", unitsPerBox: 12 });
    const oneOff = prod({ id: "C", name: "Zeta" });
    prisma.order.findMany.mockResolvedValue([
      // Milk: two orders 10 days apart, last 10 days ago -> cadence 10, est-days-left 0 => LOW
      { createdAt: daysAgo(20), lineItems: [{ productId: "A", qty: 6, product: milk }] },
      { createdAt: daysAgo(10), lineItems: [{ productId: "A", qty: 6, product: milk }] },
      // Soda (boxed x12): two orders 7 days apart, last today -> cadence 7 => OK; qty 20,28 median 24
      { createdAt: daysAgo(7), lineItems: [{ productId: "B", qty: 20, product: soda }] },
      {
        createdAt: daysAgo(0),
        lineItems: [
          { productId: "B", qty: 28, product: soda },
          // inactive product + null-product line are ignored
          { productId: "X", qty: 99, product: prod({ id: "X", isActive: false }) },
          { productId: null, qty: 5, product: null },
        ],
      },
      // One-off: single order -> no cadence => OK
      { createdAt: daysAgo(3), lineItems: [{ productId: "C", qty: 5, product: oneOff }] },
    ]);

    const out = await service.estimates("cust-1", NOW);
    expect(out).toHaveLength(3); // A, B, C — inactive X + null-product line excluded

    const byId = Object.fromEntries(out.map((e) => [e.productId, e]));

    expect(byId.A).toMatchObject({
      name: "Milk",
      cadenceDays: 10,
      daysSinceLast: 10,
      estDaysLeft: 0,
      typicalQty: 6,
      suggestedQty: 6,
      unitsPerBox: null,
      imageKey: "k1",
      state: "low",
    });

    // Boxed: suggested qty rounds to whole boxes (median 24 = 2 boxes of 12)
    expect(byId.B).toMatchObject({
      name: "Soda",
      cadenceDays: 7,
      estDaysLeft: 7,
      typicalQty: 24,
      suggestedQty: 24,
      unitsPerBox: 12,
      state: "ok",
    });

    // Single order -> cadence unknown, never flagged low
    expect(byId.C).toMatchObject({
      cadenceDays: null,
      estDaysLeft: null,
      state: "ok",
      suggestedQty: 5,
    });
  });

  it("rounds a boxed suggested qty to the nearest whole box (>= 1 box)", async () => {
    const soda = prod({ id: "B", name: "Soda", unitsPerBox: 12 });
    prisma.order.findMany.mockResolvedValue([
      // median qty 20 -> round(20/12)=2 boxes -> 24
      { createdAt: daysAgo(14), lineItems: [{ productId: "B", qty: 20, product: soda }] },
      { createdAt: daysAgo(7), lineItems: [{ productId: "B", qty: 20, product: soda }] },
    ]);
    const out = await service.estimates("cust-1", NOW);
    expect(out[0].suggestedQty).toBe(24);
  });

  it("sorts overdue (low) products first", async () => {
    const overdue = prod({ id: "OD", name: "Overdue" });
    const fresh = prod({ id: "FR", name: "Fresh" });
    prisma.order.findMany.mockResolvedValue([
      // Overdue: cadence 7, last 21 days ago -> est-days-left -14 => low
      { createdAt: daysAgo(28), lineItems: [{ productId: "OD", qty: 2, product: overdue }] },
      { createdAt: daysAgo(21), lineItems: [{ productId: "OD", qty: 2, product: overdue }] },
      // Fresh: cadence 7, last today -> est-days-left 7 => ok
      { createdAt: daysAgo(7), lineItems: [{ productId: "FR", qty: 2, product: fresh }] },
      { createdAt: daysAgo(0), lineItems: [{ productId: "FR", qty: 2, product: fresh }] },
    ]);
    const out = await service.estimates("cust-1", NOW);
    expect(out.map((e) => e.productId)).toEqual(["OD", "FR"]);
    expect(out[0].state).toBe("low");
    expect(out[0].estDaysLeft).toBe(-14);
  });

  it("returns an empty list when the customer has no order history", async () => {
    prisma.order.findMany.mockResolvedValue([]);
    expect(await service.estimates("cust-1", NOW)).toEqual([]);
  });
});
