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
 * SA-767 L-1 (B908): receivePurchaseOrder runs its whole tx inside retryStockTx. A 40P01 /
 * P2034 mid-body (after the movement / lot writes) re-runs it; Postgres rolls the failed attempt
 * back, so exactly one attempt's stock / cost writes commit and alerts fire once, with the
 * successful attempt's ids only. A non-conflict error propagates after ONE attempt. A conflict on
 * EVERY attempt (SA-767 Nit 6) is a coded 503 LOCK_UNAVAILABLE with nothing committed.
 */
const D = (n: number) => new Prisma.Decimal(n);
const po = {
  id: "po-1",
  poNumber: "PO-2026-0001",
  supplierId: "sup-1",
  status: "SENT",
  items: [
    {
      id: "poi-1",
      productId: "prod-1",
      qtyOrdered: D(10),
      qtyReceived: D(0),
      unitCost: D(3),
    },
  ],
};
const dto = { items: [{ id: "poi-1", receivedQty: 10 }] };
const deadlock = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });
const conflict = () => Object.assign(new Error("write conflict"), { code: "P2034" });

describe("receivePurchaseOrder retry (SA-767 L-1)", () => {
  let service: InventoryService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let alerts: jest.SpyInstance;
  let poReads = 0;

  beforeEach(async () => {
    prisma = createMockPrisma();
    // Per attempt: the first PO read is the fresh PO, the re-read after the loop sees it received.
    poReads = 0;
    prisma.purchaseOrder.findUnique.mockImplementation(async () =>
      ++poReads === 1 ? po : { ...po, items: [{ ...po.items[0], qtyReceived: D(10) }] },
    );
    prisma.purchaseOrder.update.mockResolvedValue({ id: "po-1", status: "RECEIVED" });
    prisma.product.findUnique.mockResolvedValue({
      id: "prod-1",
      name: "Flour",
      currentStock: D(5),
      averageCost: D(2),
      costingMethod: "AVCO",
      unitsPerBox: null,
    });
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

  /** The first `product.update` (the stock / cost write) throws `err`; tallies what each failed attempt wrote. */
  function failFirstStockWrite(err: unknown) {
    prisma.product.update.mockRejectedValueOnce(err);
    const real = prisma.tenantTransaction.getMockImplementation()!;
    const rolledBack = { movement: 0, lot: 0, product: 0 };
    prisma.tenantTransaction.mockImplementation(async (fn: any, opts?: any) => {
      const before = writes();
      poReads = 0;
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

  it("placement: the PO receive transaction runs inside retryStockTx", () => {
    const src = fs.readFileSync(path.join(__dirname, "inventory.service.ts"), "utf8");
    const body = src.slice(src.indexOf("async receivePurchaseOrder("));
    expect(body.slice(0, body.indexOf("\n  }\n"))).toMatch(
      /retryStockTx\(\s*["'`]inventory\.receivePurchaseOrder["'`]\s*,\s*\(\)\s*=>\s*this\.prisma\.tenantTransaction\(runBody\)/,
    );
  });

  it.each([
    ["40P01 deadlock", deadlock],
    ["P2034 conflict", conflict],
  ])(
    "a %s mid-body re-runs the whole tx; one attempt's writes commit, alerts fire once",
    async (_n, mk) => {
      const committed = failFirstStockWrite(mk());

      await service.receivePurchaseOrder("po-1", dto, "user-1");

      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
      expect(committed()).toEqual({ movement: 1, lot: 1, product: 1 });
      expect(alerts).toHaveBeenCalledTimes(1);
      expect(alerts).toHaveBeenCalledWith(["prod-1"]);
    },
  );

  it("a 40P01 on EVERY attempt is a coded 503 LOCK_UNAVAILABLE; nothing commits, no alerts", async () => {
    // Every stock write throws a deadlock: all 3 attempts roll back.
    prisma.product.update.mockRejectedValue(deadlock());
    const real = prisma.tenantTransaction.getMockImplementation()!;
    const rolledBack = { movement: 0, lot: 0, product: 0 };
    prisma.tenantTransaction.mockImplementation(async (fn: any, opts?: any) => {
      const before = writes();
      poReads = 0;
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

    const err: any = await service.receivePurchaseOrder("po-1", dto, "user-1").catch((e) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getResponse()).toMatchObject({ code: "LOCK_UNAVAILABLE" });
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(3);
    const t = writes();
    expect({
      movement: t.movement - rolledBack.movement,
      lot: t.lot - rolledBack.lot,
      product: t.product - rolledBack.product,
    }).toEqual({ movement: 0, lot: 0, product: 0 });
    expect(alerts).not.toHaveBeenCalled();
  });

  it("a non-conflict error propagates after ONE attempt and fires no alerts", async () => {
    prisma.product.update.mockRejectedValueOnce(new BadRequestException("nope"));

    await expect(service.receivePurchaseOrder("po-1", dto, "user-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(alerts).not.toHaveBeenCalled();
  });
});
