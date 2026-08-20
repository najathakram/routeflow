import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { ProductAliasService } from "../import/product-alias.service";
import { StorageService } from "../storage/storage.service";
import { InventoryService } from "../inventory/inventory.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * PR-D WP2: `findOne` widens ONLY its own `product` select with
 * `_count.variants` and `parentProductId`, so the bill detail page can show a
 * "Generic — split into variants?" affordance. Additive only — these pin the
 * shape of the request Prisma receives and the fields the response carries
 * through unchanged.
 */
describe("VendorBillsService.findOne — variant hint (PR-D WP2)", () => {
  let service: VendorBillsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorBillsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: DuplicateMatchService, useValue: { findVendorBillDuplicate: jest.fn() } },
        { provide: StorageService, useValue: { upload: jest.fn(), presignedUrl: jest.fn() } },
        {
          provide: InventoryService,
          useValue: { recomputeProductInTx: jest.fn(), fireStockAlerts: jest.fn() },
        },
        ProductAliasService,
      ],
    }).compile();

    service = module.get<VendorBillsService>(VendorBillsService);
  });

  it("requests an ACTIVE-only _count.variants and parentProductId on the line item's product select", async () => {
    prisma.vendorBill.findUnique.mockResolvedValue({
      id: "bill-1",
      items: [
        {
          id: "item-1",
          productId: "prod-generic",
          product: {
            id: "prod-generic",
            name: "Cola 24pk",
            sku: null,
            unit: "case",
            parentProductId: null,
            _count: { variants: 3 },
          },
        },
      ],
    });

    await service.findOne("bill-1");

    const call = prisma.vendorBill.findUnique.mock.calls[0][0];
    const productSelect = call.include.items.include.product.select;
    expect(productSelect).toMatchObject({
      id: true,
      name: true,
      sku: true,
      unit: true,
      parentProductId: true,
      // Deactivated variants can't receive stock, so they must not raise the
      // "split into variants?" badge either.
      _count: { select: { variants: { where: { isActive: true } } } },
    });
  });

  it("returns the variant count on a line whose product has children", async () => {
    prisma.vendorBill.findUnique.mockResolvedValue({
      id: "bill-1",
      items: [
        {
          id: "item-1",
          productId: "prod-generic",
          product: {
            id: "prod-generic",
            name: "Cola 24pk",
            sku: null,
            unit: "case",
            parentProductId: null,
            _count: { variants: 3 },
          },
        },
      ],
    });

    const result = await service.findOne("bill-1");

    expect(result.items[0].product._count.variants).toBe(3);
    expect(result.items[0].product.parentProductId).toBeNull();
  });

  it("returns 0 for a line whose product has no variants", async () => {
    prisma.vendorBill.findUnique.mockResolvedValue({
      id: "bill-1",
      items: [
        {
          id: "item-1",
          productId: "prod-plain",
          product: {
            id: "prod-plain",
            name: "Flour 25lb",
            sku: null,
            unit: "each",
            parentProductId: null,
            _count: { variants: 0 },
          },
        },
      ],
    });

    const result = await service.findOne("bill-1");

    expect(result.items[0].product._count.variants).toBe(0);
  });

  it("throws NotFoundException when the bill does not exist (unchanged behaviour)", async () => {
    prisma.vendorBill.findUnique.mockResolvedValue(null);

    await expect(service.findOne("missing")).rejects.toThrow("Vendor bill not found");
  });
});
