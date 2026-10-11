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
 * SA-767 L-2 (r-note Nit 5 + Nit 6): the manual stock writers (purchase, adjustment, counts, cost
 * basis) are stock writers, so each whole tx runs inside `retryStockTx`. A 40P01 / P2034 mid-body
 * re-runs it; Postgres rolls the failed attempt back, so exactly one attempt's writes commit and the
 * alert fires once, after the commit. A conflict on EVERY attempt is a coded 503 LOCK_UNAVAILABLE
 * with nothing committed; a non-conflict error propagates after ONE attempt.
 */
const D = (n: number | string) => new Prisma.Decimal(n);
const deadlock = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });
const conflict = () => Object.assign(new Error("write conflict"), { code: "P2034" });

interface Writer {
  name: string;
  label: string;
  /** The method's name in inventory.service.ts (placement check). */
  method: string;
  call: (svc: InventoryService) => Promise<unknown>;
  /** Extra mock setup for this writer. */
  setup?: (prisma: ReturnType<typeof createMockPrisma>) => void;
  /** Alerts fire for these product ids after the commit (null = this writer fires none). */
  alerts: string[] | null;
  /** Committed writes of ONE clean attempt. */
  clean: { movement: number; lot: number; product: number };
}

const WRITERS: Writer[] = [
  {
    name: "recordPurchase",
    label: "inventory.recordPurchase",
    method: "recordPurchase",
    call: (svc) =>
      svc.recordPurchase({ productId: "prod-1", quantity: 5, unitCost: 3.5 } as any, "user-1"),
    alerts: ["prod-1"],
    clean: { movement: 1, lot: 1, product: 1 },
  },
  {
    name: "recordAdjustment",
    label: "inventory.recordAdjustment",
    method: "recordAdjustment",
    call: (svc) => svc.recordAdjustment({ productId: "prod-1", quantity: 5 } as any, "user-1"),
    alerts: ["prod-1"],
    clean: { movement: 1, lot: 1, product: 1 },
  },
  {
    name: "commitStockCount",
    label: "inventory.commitStockCount",
    method: "commitStockCount",
    call: (svc) =>
      svc.commitStockCount(
        {
          sessionId: "s-1",
          items: [{ productId: "prod-1", quantity: 15, mode: "REPLACE" }],
        } as any,
        "user-1",
      ),
    alerts: ["prod-1"],
    clean: { movement: 1, lot: 1, product: 1 },
  },
  {
    name: "commitStockCountSession",
    label: "inventory.commitStockCountSession",
    method: "commitStockCountSession",
    setup: (prisma) =>
      prisma.stockCountSession.findUnique.mockResolvedValue({
        id: "sess-1",
        status: "OPEN",
        lines: [
          { productId: "prod-1", mode: "REPLACE", countedQty: D(15), unitCostOverride: null },
        ],
      }),
    call: (svc) => svc.commitStockCountSession("sess-1", {} as any, { sub: "user-1" }),
    alerts: ["prod-1"],
    clean: { movement: 1, lot: 1, product: 1 },
  },
  {
    name: "setCostBasis",
    label: "inventory.setCostBasis",
    method: "setCostBasis",
    call: (svc) => svc.setCostBasis("prod-1", { unitCost: 3 } as any, "user-1"),
    alerts: null,
    clean: { movement: 1, lot: 0, product: 1 },
  },
  {
    name: "bulkSetCostBasis",
    label: "inventory.bulkSetCostBasis",
    method: "bulkSetCostBasis",
    call: (svc) =>
      svc.bulkSetCostBasis({ items: [{ productId: "prod-1", unitCost: 3 }] } as any, "user-1"),
    alerts: null,
    clean: { movement: 1, lot: 0, product: 1 },
  },
];

describe.each(WRITERS)("$name tx retry (SA-767 L-2)", (writer) => {
  let service: InventoryService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let alerts: jest.SpyInstance;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const row = {
      id: "prod-1",
      name: "Widget",
      kind: "STANDARD",
      isActive: true,
      currentStock: D(10),
      averageCost: D(2),
      costingMethod: "AVCO",
      unitsPerBox: null,
    };
    prisma.product.findUnique.mockResolvedValue(row);
    prisma.product.findMany.mockResolvedValue([row]);
    writer.setup?.(prisma);
    prisma.product.update.mockResolvedValue({ currentStock: D(15) });
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
    alerts = jest.spyOn(service, "fireStockAlerts").mockImplementation(() => undefined);
  });

  const writes = () => ({
    movement: prisma.stockMovement.create.mock.calls.length,
    lot: prisma.stockLot.create.mock.calls.length,
    product: prisma.product.update.mock.calls.length,
  });

  /** Tallies the writes of every attempt that threw (Postgres rolls those back); the rest committed. */
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

  it("placement: the tx runs inside retryStockTx, not the bare retry", () => {
    const src = fs.readFileSync(path.join(__dirname, "inventory.service.ts"), "utf8");
    const body = src.slice(src.indexOf(`async ${writer.method}(`));
    const method = body.slice(0, body.indexOf("\n  }\n"));
    expect(method).toContain(`retryStockTx("${writer.label}"`);
    expect(method).not.toMatch(/retryOnTxConflict\(/);
  });

  it("a clean run commits once, fires its alerts once", async () => {
    const committed = trackRollbacks();

    await writer.call(service);

    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(committed()).toEqual(writer.clean);
    if (writer.alerts) expect(alerts).toHaveBeenCalledWith(writer.alerts);
  });

  it.each([
    ["40P01 deadlock", deadlock],
    ["P2034 conflict", conflict],
  ])("a %s mid-body re-runs the whole tx; the write lands exactly once", async (_n, mk) => {
    // The first product write fails: the attempt has already taken its lock and (for a purchase) its lot.
    prisma.product.update.mockRejectedValueOnce(mk());
    const committed = trackRollbacks();

    await writer.call(service);

    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
    expect(committed()).toEqual(writer.clean);
    if (writer.alerts) {
      expect(alerts).toHaveBeenCalledTimes(1);
      expect(alerts).toHaveBeenCalledWith(writer.alerts);
    }
  });

  it("a 40P01 on EVERY attempt is a coded 503 LOCK_UNAVAILABLE; nothing commits, no alerts", async () => {
    prisma.product.update.mockRejectedValue(deadlock());
    const committed = trackRollbacks();

    const err: any = await writer.call(service).catch((e) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getResponse()).toMatchObject({ code: "LOCK_UNAVAILABLE" });
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(3);
    expect(committed()).toEqual({ movement: 0, lot: 0, product: 0 });
    expect(alerts).not.toHaveBeenCalled();
  });

  it("a non-conflict error propagates after ONE attempt and fires no alerts", async () => {
    prisma.product.update.mockRejectedValueOnce(new BadRequestException("nope"));

    await expect(writer.call(service)).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(alerts).not.toHaveBeenCalled();
  });
});
