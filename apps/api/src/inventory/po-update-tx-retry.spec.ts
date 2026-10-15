import * as fs from "fs";
import * as path from "path";
import { Test } from "@nestjs/testing";
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { StockAlertService } from "../stock-alerts/stock-alert.service";

/**
 * SA-767 r-note Nit 5 + Nit 6: updatePurchaseOrder writes stock (the re-apply leg reverses the PO's
 * receipts and re-posts them), so it is a stock writer: its whole tx runs inside retryStockTx. A
 * 40P01 / P2034 mid-body re-runs it; Postgres rolls the failed attempt back, so exactly one attempt's
 * stock writes commit and the alert id list is rebuilt per attempt (alerts fire once, after commit).
 * A conflict on EVERY attempt is a coded 503 LOCK_UNAVAILABLE with nothing committed; a non-conflict
 * error propagates after ONE attempt.
 */
const D = (n: number | string) => new Prisma.Decimal(n);
const poLine = {
  id: "poi-1",
  poId: "po-1",
  productId: "prod-1",
  qtyOrdered: D(10),
  qtyReceived: D(10),
  unitCost: D(3),
  totalCost: D(30),
  sku: null,
  packSize: null,
};
const po = { id: "po-1", poNumber: "PO-2026-0001", supplierId: "sup-1", status: "RECEIVED" };
const movement = {
  id: "mv-1",
  productId: "prod-1",
  type: "PURCHASE",
  quantity: D(10),
  unitCost: D(3),
  supplierId: "sup-1",
  notes: null as string | null,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
};
const lot = {
  id: "lot-1",
  productId: "prod-1",
  qty: D(10),
  remainingQty: D(10),
  notes: null as string | null,
  purchaseDate: new Date("2026-08-01T00:00:00.000Z"),
};
const dto = {
  reapplyInventory: true,
  items: [{ id: "poi-1", productId: "prod-1", qtyOrdered: 10, unitCost: 4 }],
};
const deadlock = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });
const conflict = () => Object.assign(new Error("write conflict"), { code: "P2034" });

describe("updatePurchaseOrder retry (SA-767 Nit 5 / Nit 6)", () => {
  let service: InventoryService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let alerts: jest.SpyInstance;

  beforeEach(async () => {
    prisma = createMockPrisma();
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({ ...prisma, $executeRaw: jest.fn().mockResolvedValue(0) }),
    );
    prisma.purchaseOrder.findUnique.mockResolvedValue({ ...po, items: [poLine] });
    prisma.purchaseOrder.update.mockResolvedValue({});
    prisma.purchaseOrder.findUniqueOrThrow.mockResolvedValue({ id: "po-1" });
    prisma.product.findMany.mockResolvedValue([{ id: "prod-1" }]);
    prisma.product.findUnique.mockResolvedValue({
      id: "prod-1",
      name: "Widget",
      currentStock: D(10),
      averageCost: D(3),
      costingMethod: "AVCO",
    });
    prisma.stockMovement.findMany.mockResolvedValue([movement]);
    prisma.stockLot.findMany.mockResolvedValue([lot]);
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
    alerts = jest.spyOn(service, "fireStockAlerts").mockImplementation(() => undefined);
  });

  const writes = () => ({
    movement: prisma.stockMovement.create.mock.calls.length,
    lot: prisma.stockLot.create.mock.calls.length,
    product: prisma.product.update.mock.calls.length,
  });

  /** Tallies the writes of every attempt that threw (Postgres rolls those back); `committed()` is what stays. */
  function trackRollbacks() {
    const real = prisma.tenantTransaction.getMockImplementation()!;
    const rolledBack = { movement: 0, lot: 0, product: 0 };
    prisma.tenantTransaction.mockImplementation(async (fn: any, opts?: any) => {
      const before = writes();
      try {
        return await real(fn, opts);
      } catch (e) {
        const after = writes();
        rolledBack.movement += after.movement - before.movement;
        rolledBack.lot += after.lot - before.lot;
        rolledBack.product += after.product - before.product;
        throw e;
      }
    });
    return () => {
      const t = writes();
      return {
        movement: t.movement - rolledBack.movement,
        lot: t.lot - rolledBack.lot,
        product: t.product - rolledBack.product,
      };
    };
  }

  it("placement: the PO edit transaction runs inside retryStockTx", () => {
    const src = fs.readFileSync(path.join(__dirname, "inventory.service.ts"), "utf8");
    const body = src.slice(src.indexOf("async updatePurchaseOrder("));
    expect(body.slice(0, body.indexOf("\n  }\n"))).toMatch(
      /retryStockTx\(\s*["'`]inventory\.updatePurchaseOrder["'`]\s*,\s*\(\)\s*=>\s*this\.stockTx\(runBody\)/,
    );
    // SA-767 R6: stockTx is the 15 s budget (the 5 s lock timeout fires before P2028), and the PO row lock waits at most 5 s
    expect(src).toMatch(/private stockTx<T>[\s\S]*?tenantTransaction\(fn, STOCK_TX_OPTIONS\)/);
    expect(src).toMatch(
      /private async lockPurchaseOrder[\s\S]*?await setStockLockTimeout\(tx\);[\s\S]*?FOR UPDATE/,
    );
  });

  it("a clean run commits the reversal and the re-post once, and fires alerts once", async () => {
    const committed = trackRollbacks();

    await service.updatePurchaseOrder("po-1", dto, "user-1");

    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(committed().movement).toBe(2); // the compensating ADJUSTMENT + the re-posted PURCHASE
    expect(alerts).toHaveBeenCalledTimes(1);
    expect(alerts).toHaveBeenCalledWith(["prod-1"]);
  });

  it.each([
    ["40P01 deadlock", deadlock],
    ["P2034 conflict", conflict],
  ])(
    "a %s mid-body re-runs the whole tx; one attempt's writes commit, alerts fire once",
    async (_n, mk) => {
      // The first product write is the reversal's stock restore: the attempt has already written a movement.
      prisma.product.update.mockRejectedValueOnce(mk());
      const committed = trackRollbacks();

      await service.updatePurchaseOrder("po-1", dto, "user-1");

      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
      expect(committed().movement).toBe(2);
      expect(committed().lot).toBe(1);
      expect(alerts).toHaveBeenCalledTimes(1);
      // The id list is rebuilt per attempt: the failed attempt's ids do not leak into the alert.
      expect(alerts).toHaveBeenCalledWith(["prod-1"]);
    },
  );

  it("a 40P01 on EVERY attempt is a coded 503 LOCK_UNAVAILABLE; nothing commits, no alerts", async () => {
    prisma.product.update.mockRejectedValue(deadlock());
    const committed = trackRollbacks();

    const err: any = await service.updatePurchaseOrder("po-1", dto, "user-1").catch((e) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getResponse()).toMatchObject({ code: "LOCK_UNAVAILABLE" });
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(3);
    expect(committed()).toEqual({ movement: 0, lot: 0, product: 0 });
    expect(alerts).not.toHaveBeenCalled();
  });

  it("a non-conflict error propagates after ONE attempt and fires no alerts", async () => {
    prisma.product.update.mockRejectedValueOnce(new BadRequestException("nope"));

    await expect(service.updatePurchaseOrder("po-1", dto, "user-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(alerts).not.toHaveBeenCalled();
  });
});
