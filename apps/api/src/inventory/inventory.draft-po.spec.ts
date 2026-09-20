import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { StockAlertService } from "../stock-alerts/stock-alert.service";

/**
 * `createDraftPurchaseOrderInTx` — the "raise a PO from a scanned bill" writer
 * (units/PO step 7). Runs in the CALLER's transaction; lines are already in the PO's
 * denomination (pieces, per-piece cost).
 */

const D = (n: number | string) => new Prisma.Decimal(n);

describe("InventoryService.createDraftPurchaseOrderInTx", () => {
  let service: InventoryService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const year = new Date().getFullYear();

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        { provide: StockAlertService, useValue: { fireForProducts: jest.fn() } },
      ],
    }).compile();
    service = module.get(InventoryService);
    prisma.purchaseOrder.create.mockResolvedValue({ id: "po-1", poNumber: "x", status: "DRAFT" });
    prisma.supplier.findUnique.mockResolvedValue({ id: "sup-1" });
    prisma.product.findMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
  });

  const lines = [
    { productId: "p1", qtyOrdered: D(24), unitCost: D("1.25"), sku: "W-24", packSize: 24 },
    { productId: "p2", qtyOrdered: D(10), unitCost: D("2.5") },
  ];

  it("creates a DRAFT PO in the caller's transaction, numbered after the last one, total rounded", async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValue({ poNumber: `PO-${year}-0007` });
    const tx = prisma as never;
    await service.createDraftPurchaseOrderInTx(tx, { supplierId: "sup-1", notes: "Dock 3", lines });

    const data = prisma.purchaseOrder.create.mock.calls[0][0].data as any;
    expect(data.poNumber).toBe(`PO-${year}-0008`);
    expect(data.status).toBe("DRAFT");
    expect(data.supplierId).toBe("sup-1");
    expect(data.notes).toBe("Dock 3");
    expect(data.totalAmount).toBe(55); // 24×1.25 + 10×2.5
    expect(data.items.create).toHaveLength(2);
    expect(data.items.create[0]).toMatchObject({
      productId: "p1",
      totalCost: 30,
      sku: "W-24",
      packSize: 24,
    });
    expect(data.items.create[0].qtyReceived).toBe(0);
    expect(data.items.create[1]).toMatchObject({ productId: "p2", sku: null, packSize: null });
  });

  it("starts at 0001 when the tenant has no PO this year", async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValue(null);
    await service.createDraftPurchaseOrderInTx(prisma as never, { supplierId: "sup-1", lines });
    expect(prisma.purchaseOrder.create.mock.calls[0][0].data.poNumber).toBe(`PO-${year}-0001`);
  });

  it("B571: stamps tenantId explicitly on every nested line", async () => {
    await service.createDraftPurchaseOrderInTx(prisma as never, { supplierId: "sup-1", lines });
    const items = (prisma.purchaseOrder.create.mock.calls[0][0].data as any).items.create;
    expect(items.map((i: any) => i.tenantId)).toEqual(["test-tenant", "test-tenant"]);
  });

  it("refuses an empty line set and writes nothing", async () => {
    await expect(
      service.createDraftPurchaseOrderInTx(prisma as never, { supplierId: "sup-1", lines: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.purchaseOrder.create).not.toHaveBeenCalled();
  });

  it("refuses an unknown supplier and writes nothing", async () => {
    prisma.supplier.findUnique.mockResolvedValue(null);
    await expect(
      service.createDraftPurchaseOrderInTx(prisma as never, { supplierId: "ghost", lines }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.purchaseOrder.create).not.toHaveBeenCalled();
  });

  it("refuses a product that isn't in the tenant (no tenant-stamped line pointing at a foreign product)", async () => {
    prisma.product.findMany.mockResolvedValue([{ id: "p1" }]); // p2 unknown
    await expect(
      service.createDraftPurchaseOrderInTx(prisma as never, { supplierId: "sup-1", lines }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.purchaseOrder.create).not.toHaveBeenCalled();
  });

  it("refuses zero/negative quantity and a negative price (a bill's discount or deposit line)", async () => {
    for (const bad of [
      { productId: "p1", qtyOrdered: D(0), unitCost: D(1) },
      { productId: "p1", qtyOrdered: D(-2), unitCost: D(5) },
      { productId: "p1", qtyOrdered: D(2), unitCost: D(-5) },
    ]) {
      await expect(
        service.createDraftPurchaseOrderInTx(prisma as never, {
          supplierId: "sup-1",
          lines: [lines[0], bad],
        }),
      ).rejects.toThrow(/zero or negative quantity or a negative price/);
    }
    expect(prisma.purchaseOrder.create).not.toHaveBeenCalled();
  });
});
