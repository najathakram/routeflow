import { Test, TestingModule } from "@nestjs/testing";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { StockAlertService } from "../stock-alerts/stock-alert.service";

// P1b: a PO line's product carries its family name so the line reads "<Family> - <Variant>" without the
// active-only catalog; a parent that belongs to ANOTHER tenant is never followed on a read (B1211).
describe("InventoryService.getPurchaseOrder — line product family (P1b)", () => {
  let service: InventoryService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const poWith = (parent: { tenantId: string; name: string } | null) => ({
    id: "po-1",
    poNumber: "PO-1",
    supplierId: "sup-1",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    items: [
      {
        id: "i1",
        productId: "p1",
        qtyReceived: 0,
        product: {
          id: "p1",
          name: "Strawberry",
          unit: "case",
          unitsPerBox: 12,
          currentStock: "30.000",
          parentProductId: "fam-1",
          variantName: "Strawberry",
          parent,
        },
      },
    ],
  });

  beforeEach(async () => {
    prisma = createMockPrisma(); // getTenantId() -> "test-tenant"
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
      ],
    }).compile();
    service = module.get(InventoryService);
    prisma.stockMovement.findMany.mockResolvedValue([]);
  });

  it("returns the parent name for a same-tenant parent, without its tenantId", async () => {
    prisma.purchaseOrder.findUnique.mockResolvedValue(
      poWith({ tenantId: "test-tenant", name: "Acme Vape" }),
    );
    const res: any = await service.getPurchaseOrder("po-1");
    expect(res.items[0].product.parent).toEqual({ name: "Acme Vape" });
    expect(res.items[0].product.currentStock).toBe("30.000");
  });

  it("returns NO parent name for a parent from another tenant", async () => {
    prisma.purchaseOrder.findUnique.mockResolvedValue(
      poWith({ tenantId: "other-tenant", name: "Foreign Family" }),
    );
    const res: any = await service.getPurchaseOrder("po-1");
    expect(res.items[0].product.parent).toBeNull();
  });

  it("selects the family fields from the product", async () => {
    prisma.purchaseOrder.findUnique.mockResolvedValue(poWith(null));
    await service.getPurchaseOrder("po-1");
    const select = (prisma.purchaseOrder.findUnique.mock.calls[0][0] as any).include.items.include
      .product.select;
    expect(select).toMatchObject({
      currentStock: true,
      parentProductId: true,
      variantName: true,
      parent: { select: { tenantId: true, name: true } },
    });
  });
});
