import { Test } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { StockAlertService } from "../stock-alerts/stock-alert.service";

/**
 * SA-767 L-2 (B286 / #2840), unit level: a manual stock / cost writer takes the Product lock FIRST,
 * then decides from the row it reads INSIDE its tx - never from the validation read it made before
 * the tx (a concurrent writer may have moved it in between). The real-Postgres proof of each race is
 * `sa767-stock-writers.db.spec.ts`; this pins the shape cheaply on every unit run.
 */
const D = (n: number | string) => new Prisma.Decimal(n);
const row = (over: Record<string, unknown> = {}) => ({
  id: "prod-1",
  name: "Widget",
  kind: "STANDARD",
  isActive: true,
  currentStock: D(10),
  averageCost: D(2),
  costingMethod: "AVCO",
  unitsPerBox: null,
  ...over,
});

describe("stock writers read the LOCKED row, not the pre-tx read (SA-767 L-2)", () => {
  let service: InventoryService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let lockStatement: jest.Mock;

  beforeEach(async () => {
    prisma = createMockPrisma();
    lockStatement = jest.fn().mockResolvedValue(0);
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({ ...prisma, $executeRaw: lockStatement, $queryRaw: jest.fn().mockResolvedValue([]) }),
    );
    prisma.stockMovement.count.mockResolvedValue(0);
    prisma.stockMovement.create.mockResolvedValue({ id: "mv-1" });
    const mod = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
      ],
    }).compile();
    service = mod.get(InventoryService);
    jest.spyOn(service, "fireStockAlerts").mockImplementation(() => undefined);
  });

  /** The lock statement ran before the call number `n` (1-based) of `fn`. */
  const lockedBefore = (fn: jest.Mock, n: number) =>
    lockStatement.mock.invocationCallOrder[0] < fn.mock.invocationCallOrder[n - 1];

  it("recordPurchase blends from the locked 20 @ 3.00, not the stale 10 @ 2.00", async () => {
    prisma.product.findUnique
      .mockResolvedValueOnce(row()) // the validation read, before the tx
      .mockResolvedValue(row({ currentStock: D(20), averageCost: D(3) })); // the locked read
    prisma.product.update.mockResolvedValue({ currentStock: D(25) });

    await service.recordPurchase({ productId: "prod-1", quantity: 5, unitCost: 4 } as any, "u-1");

    // (20 * 3 + 5 * 4) / 25 = 3.20 (the stale row would give (10 * 2 + 5 * 4) / 15 = 2.6667)
    expect(prisma.product.update.mock.calls[0][0].data.averageCost.toString()).toBe("3.2");
    expect(prisma.stockMovement.create.mock.calls[0][0].data.avgCostAfter.toString()).toBe("3.2");
    expect(prisma.stockMovement.create.mock.calls[0][0].data.stockAfter.toString()).toBe("25");
    expect(lockStatement).toHaveBeenCalledTimes(1);
    expect(lockedBefore(prisma.product.findUnique, 2)).toBe(true);
    expect(lockedBefore(prisma.product.update, 1)).toBe(true);
  });

  it("recordAdjustment stamps the movement and the new lot with the LOCKED average", async () => {
    prisma.product.findUnique
      .mockResolvedValueOnce(row())
      .mockResolvedValue(row({ averageCost: D(3) }));
    prisma.product.update.mockResolvedValue({ currentStock: D(15) });

    await service.recordAdjustment({ productId: "prod-1", quantity: 5 } as any, "u-1");

    expect(prisma.stockMovement.create.mock.calls[0][0].data.avgCostAfter.toString()).toBe("3");
    expect(prisma.stockLot.create.mock.calls[0][0].data.unitCost.toString()).toBe("3");
    expect(lockedBefore(prisma.product.findUnique, 2)).toBe(true);
  });

  it("a count REPLACE is counted minus the LOCKED stock, written as an increment", async () => {
    // validation read: 100 on hand; by the time the lock is granted a sale left 70
    prisma.product.findMany
      .mockResolvedValueOnce([row({ currentStock: D(100) })])
      .mockResolvedValue([row({ currentStock: D(70) })]);
    prisma.product.update.mockResolvedValue({ currentStock: D(90) });

    await service.commitStockCount(
      { sessionId: "s-1", items: [{ productId: "prod-1", quantity: 90, mode: "REPLACE" }] } as any,
      "u-1",
    );

    expect(prisma.product.update.mock.calls[0][0].data).toEqual({
      currentStock: { increment: D(20) },
    });
    const movement = prisma.stockMovement.create.mock.calls[0][0].data;
    expect(movement.quantity.toString()).toBe("20");
    expect(movement.stockAfter.toString()).toBe("90"); // the counter the update RETURNED
    expect(lockedBefore(prisma.product.findMany, 2)).toBe(true);
    expect(lockStatement).toHaveBeenCalledTimes(1);
  });

  it("the movement's stockAfter is the counter the update returned, whatever the delta implied", async () => {
    prisma.product.findMany.mockResolvedValue([row({ currentStock: D(70) })]);
    prisma.product.update.mockResolvedValue({ currentStock: D(88) });

    await service.commitStockCount(
      { sessionId: "s-2", items: [{ productId: "prod-1", quantity: 90, mode: "REPLACE" }] } as any,
      "u-1",
    );

    expect(prisma.stockMovement.create.mock.calls[0][0].data.stockAfter.toString()).toBe("88");
  });

  it("setCostBasis stamps stockAfter from the update's returned row, after the lock", async () => {
    prisma.product.findUnique.mockResolvedValue(row({ currentStock: D(100) }));
    prisma.product.findMany.mockResolvedValue([row({ currentStock: D(70) })]);
    prisma.product.update.mockResolvedValue({ currentStock: D(70) });

    await service.setCostBasis("prod-1", { unitCost: 5 } as any, "u-1");

    expect(prisma.stockMovement.create.mock.calls[0][0].data.stockAfter.toString()).toBe("70");
    expect(lockedBefore(prisma.product.findMany, 1)).toBe(true);
  });

  it("bulkSetCostBasis takes ONE lock statement for every product", async () => {
    const rows = [row(), row({ id: "prod-2", name: "Sugar" })];
    prisma.product.findMany.mockResolvedValue(rows);
    prisma.product.update.mockResolvedValue({ currentStock: D(10) });

    await service.bulkSetCostBasis(
      {
        items: [
          { productId: "prod-1", unitCost: 2 },
          { productId: "prod-2", unitCost: 3 },
        ],
      } as any,
      "u-1",
    );

    expect(lockStatement).toHaveBeenCalledTimes(1);
    expect(prisma.stockMovement.create).toHaveBeenCalledTimes(2);
  });

  it("a session commit locks every counted product once, before the cost row and the adjustment", async () => {
    const lines = [
      { productId: "prod-1", mode: "REPLACE", countedQty: D(90), unitCostOverride: D(5) },
      { productId: "prod-2", mode: "ADD", countedQty: D(4), unitCostOverride: null },
    ];
    prisma.stockCountSession.findUnique.mockResolvedValue({ id: "sess-1", status: "OPEN", lines });
    // L-2.1: the claim (CAS) wins, and the applied lines are the ones read inside the tx
    prisma.stockCountSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.stockCountLine.findMany.mockResolvedValue(lines);
    const rows = [
      row({ currentStock: D(70) }),
      row({ id: "prod-2", name: "Sugar", currentStock: D(6) }),
    ];
    prisma.product.findMany.mockResolvedValue(rows);
    prisma.product.update.mockResolvedValue({ currentStock: D(90) });

    await service.commitStockCountSession("sess-1", {} as any, { sub: "u-1" });

    expect(lockStatement).toHaveBeenCalledTimes(1);
    const types = prisma.stockMovement.create.mock.calls.map((c) => c[0].data.type);
    expect(types).toEqual(["COST_BASIS", "ADJUSTMENT", "ADJUSTMENT"]);
    // the REPLACE line: 90 counted - 70 locked = +20, valued at the corrected 5.00
    const adj = prisma.stockMovement.create.mock.calls[1][0].data;
    expect(adj.quantity.toString()).toBe("20");
    expect(adj.avgCostAfter.toString()).toBe("5");
    expect(lockedBefore(prisma.product.update, 1)).toBe(true);
  });
});
