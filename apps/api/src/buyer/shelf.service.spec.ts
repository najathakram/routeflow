import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ShelfService } from "./shelf.service";
import { ReplenishmentService, ReplenishmentEstimate } from "./replenishment.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("ShelfService (P5-06)", () => {
  let service: ShelfService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let replenishment: { estimates: jest.Mock };
  let storage: { presignedUrls: jest.Mock };

  const NOW = new Date("2026-07-13T00:00:00.000Z");
  const DAY = 86_400_000;

  const est = (over: Partial<ReplenishmentEstimate>): ReplenishmentEstimate => ({
    productId: "p1",
    name: "Product",
    unit: "ea",
    unitsPerBox: null,
    imageKey: null,
    lastOrderedAt: "2026-07-01T00:00:00.000Z",
    orderCount: 3,
    cadenceDays: 10,
    daysSinceLast: 10,
    estDaysLeft: 0,
    typicalQty: 6,
    suggestedQty: 6,
    state: "low",
    ...over,
  });

  beforeEach(async () => {
    prisma = createMockPrisma();
    replenishment = { estimates: jest.fn().mockResolvedValue([]) };
    storage = {
      presignedUrls: jest.fn(async (keys: string[]) => keys.map((k) => `https://cdn/${k}`)),
    };

    const mod = await Test.createTestingModule({
      providers: [
        ShelfService,
        { provide: ReplenishmentService, useValue: replenishment },
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();
    service = mod.get(ShelfService);
  });

  it("shelf: overlays active snoozes and presigns image keys (snoozed rows KEPT)", async () => {
    replenishment.estimates.mockResolvedValue([
      est({ productId: "A", imageKey: "products/A/img-fp50x40.jpg" }),
      est({ productId: "B", name: "Beans" }),
    ]);
    prisma.replenishmentSnooze.findMany.mockResolvedValue([
      { productId: "A", snoozedUntil: new Date("2026-07-20T00:00:00.000Z") },
    ]);

    const out = await service.shelf("cust-1", NOW);

    expect(out).toHaveLength(2); // snoozed rows are kept, not dropped
    expect(out[0]).toMatchObject({
      productId: "A",
      snoozed: true,
      snoozedUntil: "2026-07-20T00:00:00.000Z",
      imageUrl: "https://cdn/products/A/img-fp50x40.jpg",
    });
    expect(out[1]).toMatchObject({
      productId: "B",
      snoozed: false,
      snoozedUntil: null,
      imageUrl: null,
    });
    // Only ACTIVE snoozes are read (tenant scoping rides forTenant()).
    expect(prisma.replenishmentSnooze.findMany).toHaveBeenCalledWith({
      where: { customerId: "cust-1", snoozedUntil: { gt: NOW } },
    });
  });

  it("lowItems: low && !snoozed only, at suggestedQty", async () => {
    replenishment.estimates.mockResolvedValue([
      est({ productId: "A", state: "low", suggestedQty: 6 }),
      est({ productId: "B", state: "low", suggestedQty: 24 }), // snoozed → excluded
      est({ productId: "C", state: "due-soon" }), // not low → excluded
      est({ productId: "D", state: "ok" }),
    ]);
    prisma.replenishmentSnooze.findMany.mockResolvedValue([
      { productId: "B", snoozedUntil: new Date("2026-07-20T00:00:00.000Z") },
    ]);

    const items = await service.lowItems("cust-1", NOW);
    expect(items).toEqual([{ productId: "A", qty: 6 }]);
  });

  it("lowItems: boxed products carry a box split (qty=pieces, boxes, pieces:0) so createOrder prices by the box", async () => {
    replenishment.estimates.mockResolvedValue([
      est({ productId: "A", state: "low", suggestedQty: 24, unitsPerBox: 12 }),
      est({ productId: "B", state: "low", suggestedQty: 6, unitsPerBox: null }),
    ]);
    prisma.replenishmentSnooze.findMany.mockResolvedValue([]);

    const items = await service.lowItems("cust-1", NOW);
    // Boxed A → 2 boxes of 12; non-boxed B → plain qty (no split).
    expect(items).toEqual([
      { productId: "A", qty: 24, boxes: 2, pieces: 0 },
      { productId: "B", qty: 6 },
    ]);
  });

  it("snooze: one cycle = now + cadenceDays, upserted on (tenant, customer, product)", async () => {
    replenishment.estimates.mockResolvedValue([est({ productId: "A", cadenceDays: 10 })]);

    const res = await service.snooze("cust-1", "A", "tenant-1", NOW);

    const expected = new Date(NOW.getTime() + 10 * DAY);
    expect(res).toEqual({ snoozedUntil: expected.toISOString() });
    expect(prisma.replenishmentSnooze.upsert).toHaveBeenCalledWith({
      where: {
        tenantId_customerId_productId: {
          tenantId: "tenant-1",
          customerId: "cust-1",
          productId: "A",
        },
      },
      create: {
        tenantId: "tenant-1",
        customerId: "cust-1",
        productId: "A",
        snoozedUntil: expected,
      },
      update: { snoozedUntil: expected },
    });
  });

  it("snooze: falls back to 14 days when cadence is unknown", async () => {
    replenishment.estimates.mockResolvedValue([est({ productId: "A", cadenceDays: null })]);
    const res = await service.snooze("cust-1", "A", "tenant-1", NOW);
    expect(res.snoozedUntil).toBe(new Date(NOW.getTime() + 14 * DAY).toISOString());
  });

  it("snooze: falls back to 14 days for a real product that is not in the estimates", async () => {
    replenishment.estimates.mockResolvedValue([]);
    // Not in estimates → validated against the catalog; a real product still snoozes.
    prisma.product.findFirst.mockResolvedValue({ id: "ZZZ" });
    const res = await service.snooze("cust-1", "ZZZ", "tenant-1", NOW);
    expect(res.snoozedUntil).toBe(new Date(NOW.getTime() + 14 * DAY).toISOString());
  });

  it("snooze: throws 404 (not a raw 500) for a productId that is neither estimated nor a real product", async () => {
    replenishment.estimates.mockResolvedValue([]);
    prisma.product.findFirst.mockResolvedValue(null);
    await expect(service.snooze("cust-1", "does-not-exist", "tenant-1", NOW)).rejects.toThrow(
      NotFoundException,
    );
    // No FK-constrained write is attempted for an unknown product.
    expect(prisma.replenishmentSnooze.upsert).not.toHaveBeenCalled();
  });

  it("unsnooze: deleteMany by customer+product (no-op safe)", async () => {
    await service.unsnooze("cust-1", "A");
    expect(prisma.replenishmentSnooze.deleteMany).toHaveBeenCalledWith({
      where: { customerId: "cust-1", productId: "A" },
    });
  });
});
