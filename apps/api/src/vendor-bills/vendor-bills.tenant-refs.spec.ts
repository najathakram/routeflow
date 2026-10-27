import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { ProductAliasService } from "../import/product-alias.service";
import { StorageService } from "../storage/storage.service";
import { InventoryService } from "../inventory/inventory.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("@anthropic-ai/sdk", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("sharp", () => ({ __esModule: true, default: jest.fn() }));

/** What a tenant-scoped read does: only this tenant's own rows come back for an id list. */
const ownRows = (owned: string[]) => async (args: { where: { id: { in: string[] } } }) =>
  args.where.id.in.filter((id) => owned.includes(id)).map((id) => ({ id }));

// 681 (R5-5) site 8: ProductMapping stores the caller's productId (the table is GLOBAL-keyed, so a stray
// foreign id also feeds another tenant's lookup). The writer proves it before the update / create, which
// covers the route caller; the batch-import caller already proves it upstream.
describe("VendorBillsService.saveProductMapping — tenant refs (681 site 8)", () => {
  let service: VendorBillsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.product.findMany.mockImplementation(ownRows(["prod-a"]));
    prisma.productMapping.findFirst.mockResolvedValue(null);
    prisma.productMapping.create.mockResolvedValue({ id: "map-1", productId: "prod-a" });
    prisma.productMapping.update.mockResolvedValue({ id: "map-1", productId: "prod-a" });
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
        { provide: StorageService, useValue: { upload: jest.fn(), presignedUrl: jest.fn() } },
        { provide: InventoryService, useValue: {} },
        ProductAliasService,
      ],
    }).compile();
    service = module.get(VendorBillsService);
  });

  it("another tenant's product is a 404 and no mapping is created", async () => {
    const err = await service.saveProductMapping("Acme Foods", "flour", "prod-b").catch((e) => e);
    expect(prisma.productMapping.create).not.toHaveBeenCalled();
    expect(prisma.productMapping.update).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe("Product not found");
  });

  it("another tenant's product cannot repoint an existing mapping either", async () => {
    prisma.productMapping.findFirst.mockResolvedValue({ id: "map-1", productId: "prod-a" });
    const err = await service.saveProductMapping("Acme Foods", "flour", "prod-b").catch((e) => e);
    expect(prisma.productMapping.update).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(NotFoundException);
  });

  it("control: this tenant's product is mapped", async () => {
    await service.saveProductMapping("Acme Foods", "flour", "prod-a");
    expect(prisma.productMapping.create).toHaveBeenCalledTimes(1);
  });

  it("clearing a mapping (productId null) proves nothing and still writes", async () => {
    prisma.productMapping.findFirst.mockResolvedValue({ id: "map-1", productId: "prod-a" });
    await service.saveProductMapping("Acme Foods", "flour", null);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    expect(prisma.productMapping.update).toHaveBeenCalledTimes(1);
  });
});
