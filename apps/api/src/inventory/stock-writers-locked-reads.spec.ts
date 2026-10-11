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
});
