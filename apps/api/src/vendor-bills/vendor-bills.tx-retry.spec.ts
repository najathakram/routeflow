import { Test, TestingModule } from "@nestjs/testing";
import { ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { ProductAliasService } from "../import/product-alias.service";
import { StorageService } from "../storage/storage.service";
import { InventoryService } from "../inventory/inventory.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("@anthropic-ai/sdk", () => ({ __esModule: true, default: jest.fn(() => ({})) }));
jest.mock("sharp", () => ({ __esModule: true, default: jest.fn(() => ({})) }));

/**
 * SA-767 L-1 (B908): the vendor-bill stock txs (receive, revertToDraft, voidBill's reversal) run
 * inside retryStockTx. A 40P01 / P2034 mid-body (after some writes) re-runs the WHOLE tx:
 * the failed attempt's writes are rolled back by Postgres, so exactly one attempt's stock / cost
 * writes commit; a non-conflict error propagates after ONE attempt; a conflict on EVERY attempt is a
 * coded 503 LOCK_UNAVAILABLE with nothing committed (SA-767 Nit 6).
 */
const D = (n: number | string) => new Prisma.Decimal(n);
const item = {
  id: "item-1",
  productId: "prod-1",
  description: "Flour 25lb",
  qty: D(5),
  unitCost: D(3.5),
  product: { id: "prod-1", name: "Flour 25lb", currentStock: D(10), averageCost: D(2) },
};
const pending = () => ({
  id: "bill-1",
  billNumber: "BILL-2026-0001",
  supplierId: "sup-1",
  status: "DRAFT",
  billDate: new Date("2026-06-01"),
  items: [item],
  supplier: { id: "sup-1", name: "Acme Foods" },
});
const received = () => ({
  ...pending(),
  status: "RECEIVED",
  receivedDate: new Date("2026-06-02"),
});

const deadlock = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });
const conflict = () => Object.assign(new Error("write conflict"), { code: "P2034" });

describe("vendor-bill stock txs retry on a conflict (SA-767 L-1)", () => {
  let service: VendorBillsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const inventory = {
    recomputeProductInTx: jest.fn(),
    lockProducts: jest.fn(),
    fireStockAlerts: jest.fn(),
  };

  beforeEach(async () => {
    inventory.recomputeProductInTx.mockReset();
    inventory.lockProducts.mockReset();
    inventory.fireStockAlerts.mockReset();
    prisma = createMockPrisma();
    prisma.vendorBill.findUnique.mockImplementation(
      () =>
        prisma.vendorBill.findUnique.mock.results.filter((r) => r.type === "return").at(-1)?.value,
    );
    prisma.product.findFirst.mockResolvedValue({
      currentStock: D(15),
      averageCost: D(2.5),
      costingMethod: "AVCO",
      kind: "STANDARD",
      name: "Flour 25lb",
    });
    prisma.stockLot.findMany.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorBillsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: PlatformConfigService,
          useValue: { resolveAnthropicKey: jest.fn(), recordAiUsage: jest.fn() },
        },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: DuplicateMatchService, useValue: {} },
        { provide: StorageService, useValue: {} },
        { provide: InventoryService, useValue: inventory },
        ProductAliasService,
      ],
    }).compile();
    service = module.get(VendorBillsService);
  });

  const writes = () => ({
    movement: prisma.stockMovement.create.mock.calls.length,
    lot: prisma.stockLot.create.mock.calls.length,
    product: prisma.product.update.mock.calls.length,
  });

  /**
   * Makes the FIRST `product.update` throw `err` (so the attempt has already written its movement /
   * lot), and tallies the writes of every attempt that threw: those are rolled back by Postgres,
   * so `committed()` is what a real database would keep.
   */
  function failFirstProductWrite(err: unknown) {
    prisma.product.update.mockRejectedValueOnce(err);
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
      const total = writes();
      return {
        movement: total.movement - rolledBack.movement,
        lot: total.lot - rolledBack.lot,
        product: total.product - rolledBack.product,
      };
    };
  }

  it.each([
    ["40P01 deadlock", deadlock],
    ["P2034 conflict", conflict],
  ])("receive: a %s mid-body re-runs the whole tx; one attempt's writes commit", async (_n, mk) => {
    prisma.vendorBill.findUnique.mockResolvedValueOnce(pending());
    const committed = failFirstProductWrite(mk());

    await service.receive("bill-1", undefined, "user-1");

    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
    expect(committed()).toEqual({ movement: 1, lot: 1, product: 1 });
    expect(inventory.fireStockAlerts).toHaveBeenCalledTimes(1);
    expect(inventory.fireStockAlerts).toHaveBeenCalledWith(["prod-1"]);
  });

  it("revertToDraft: a deadlock mid-body re-runs the whole tx; one reversal commits", async () => {
    prisma.vendorBill.findUnique.mockResolvedValueOnce(received());
    const committed = failFirstProductWrite(deadlock());

    await service.revertToDraft("bill-1");

    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
    expect(committed().product).toBe(1);
  });

  it("voidBill (reversal): a deadlock mid-body re-runs the whole tx; one reversal commits", async () => {
    prisma.vendorBill.findUnique.mockResolvedValueOnce(received());
    const committed = failFirstProductWrite(deadlock());

    await service.voidBill("bill-1", "user-1");

    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
    expect(committed()).toMatchObject({ movement: 1, product: 1 });
  });

  it.each([
    ["receive", () => service.receive("bill-1", undefined, "user-1"), pending],
    ["revertToDraft", () => service.revertToDraft("bill-1"), received],
    ["voidBill", () => service.voidBill("bill-1", "user-1"), received],
  ])(
    "%s: a 40P01 on EVERY attempt is a coded 503 LOCK_UNAVAILABLE; nothing commits, no alerts",
    async (_n, call, mk) => {
      prisma.vendorBill.findUnique.mockResolvedValue(mk());
      prisma.product.update.mockRejectedValue(deadlock());
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

      const err: any = await call().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(err.getResponse()).toMatchObject({ code: "LOCK_UNAVAILABLE" });
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(3);
      const t = writes();
      expect({
        movement: t.movement - rolledBack.movement,
        lot: t.lot - rolledBack.lot,
        product: t.product - rolledBack.product,
      }).toEqual({ movement: 0, lot: 0, product: 0 });
      expect(inventory.fireStockAlerts).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["receive", () => service.receive("bill-1", undefined, "user-1"), pending],
    ["revertToDraft", () => service.revertToDraft("bill-1"), received],
    ["voidBill", () => service.voidBill("bill-1", "user-1"), received],
  ])("%s: a non-conflict error propagates after ONE attempt", async (_n, call, mk) => {
    prisma.vendorBill.findUnique.mockResolvedValueOnce(mk());
    prisma.product.update.mockRejectedValueOnce(new Error("boom"));

    await expect(call()).rejects.toThrow("boom");

    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(inventory.fireStockAlerts).not.toHaveBeenCalled();
  });
});
