/**
 * SA-603a wiring: the ProductsService writers call the code-release module (archive/deactivate releases,
 * reactivate restores, create/update claim and lazily release an INACTIVE holder), and the create/update 400
 * pre-checks only see ACTIVE holders. The module itself is pinned in product-code-release.spec.ts.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ProductsService } from "./products.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";

const codes = {
  sku: null as string | null,
  barcode: null as string | null,
  unitSku: null as string | null,
  retiredSku: null as string | null,
  retiredBarcode: null as string | null,
  retiredUnitSku: null as string | null,
};
const BASE = {
  id: "prod-1",
  name: "Cherry Tomatoes",
  unit: "punnet",
  pricePerUnit: 4.99,
  unitsPerBox: null,
  isActive: true,
  imageKeys: [] as string[],
  ...codes,
};

describe("ProductsService — code release wiring (SA-603a)", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: {
            presignedUrl: jest.fn().mockResolvedValue("http://mock-url"),
            presignedUrls: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(true) } },
        { provide: PlanCatalogService, useValue: { upgradeTargetForFlag: jest.fn() } },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ProductsService);
  });

  /** findFirst answers the by-id code read with `self`, every other lookup (collision checks) with null. */
  function holderLookup(self: Record<string, unknown>) {
    prisma.product.findFirst.mockImplementation((args: any) =>
      Promise.resolve(args?.where?.id === self.id && args?.where?.tenantId ? self : null),
    );
  }

  it("remove() releases the archived product's codes in the same tx (sku -> retiredSku)", async () => {
    const self = { ...BASE, sku: "S1", barcode: "B1" };
    prisma.product.findUnique.mockResolvedValue(self as any);
    prisma.orderItem.count.mockResolvedValue(0);
    prisma.product.update.mockResolvedValue({ ...self, isActive: false } as any);
    holderLookup(self);

    await service.remove("prod-1");

    const flipped = prisma.product.update.mock.calls.find(([a]: any) => a.data.isActive === false);
    const released = prisma.product.update.mock.calls.find(
      ([a]: any) => a.data.retiredSku === "S1",
    );
    expect(flipped).toBeDefined();
    expect(released?.[0]).toMatchObject({
      where: { id: "prod-1" },
      data: { retiredSku: "S1", sku: null, retiredBarcode: "B1", barcode: null },
    });
  });

  it("update({isActive:false}) on an active product releases its codes after the write", async () => {
    const self = { ...BASE, sku: "S1" };
    prisma.product.findUnique.mockResolvedValue(self as any);
    prisma.product.update.mockResolvedValue({ ...self, isActive: false } as any);
    holderLookup(self);

    await service.update("prod-1", { isActive: false } as any);

    expect(prisma.product.update.mock.calls.some(([a]: any) => a.data.retiredSku === "S1")).toBe(
      true,
    );
  });

  it("update({isActive:true}) on an inactive product restores its retired codes before the write", async () => {
    const self = { ...BASE, isActive: false, retiredSku: "S1" };
    prisma.product.findUnique.mockResolvedValue(self as any);
    prisma.product.update.mockResolvedValue({ ...self, isActive: true, sku: "S1" } as any);
    holderLookup(self);

    await service.update("prod-1", { isActive: true } as any);

    const restore = prisma.product.update.mock.calls.find(([a]: any) => a.data.sku === "S1");
    expect(restore?.[0]).toMatchObject({ data: { sku: "S1", retiredSku: null } });
  });

  it("update() does not release or restore when isActive is not part of the change", async () => {
    const self = { ...BASE, sku: "S1" };
    prisma.product.findUnique.mockResolvedValue(self as any);
    prisma.product.update.mockResolvedValue({ ...self, pricePerUnit: 9 } as any);
    holderLookup(self);

    await service.update("prod-1", { pricePerUnit: 9 } as any);

    expect(prisma.product.update).toHaveBeenCalledTimes(1);
  });

  it("create(): the sku pre-check only counts ACTIVE holders", async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    prisma.product.findMany.mockResolvedValue([]);
    prisma.product.create.mockResolvedValue({ ...BASE, id: "prod-new", sku: "S1" } as any);

    await service.create({ name: "New", sku: "S1", unit: "punnet", pricePerUnit: 1 } as any);

    const skuCheck = prisma.product.findFirst.mock.calls.find(
      ([a]: any) => Array.isArray(a?.where?.OR) && a.where.OR.some((o: any) => o.sku === "S1"),
    );
    expect(skuCheck?.[0].where).toMatchObject({ isActive: true });
  });

  it("create(): an INACTIVE holder of the sku is released (audited) and the create proceeds", async () => {
    prisma.product.findFirst.mockImplementation((args: any) =>
      Promise.resolve(args?.where?.id === "old" && args?.where?.tenantId ? OLD : null),
    );
    const OLD = { ...BASE, id: "old", name: "Old", isActive: false, sku: "S1" };
    prisma.product.findMany.mockResolvedValue([OLD] as any);
    prisma.product.create.mockResolvedValue({ ...BASE, id: "prod-new", sku: "S1" } as any);

    await service.create({ name: "New", sku: "S1", unit: "punnet", pricePerUnit: 1 } as any, {
      actorId: "user-9",
    });

    expect(prisma.product.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "old" }, data: { retiredSku: "S1", sku: null } }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-9",
        action: "product.code_released_on_reuse",
        entityId: "old",
      }),
    });
    expect(prisma.product.create).toHaveBeenCalled();
  });

  it("create(): an ACTIVE holder that appears inside the tx (the race) is a 409 CODE_TAKEN naming it", async () => {
    prisma.product.findFirst.mockResolvedValue(null); // the outside pre-check saw nothing
    prisma.product.findMany.mockResolvedValue([
      { ...BASE, id: "holder", name: "Holder", sku: "S1" },
    ] as any);

    await expect(
      service.create({ name: "New", sku: "S1", unit: "punnet", pricePerUnit: 1 } as any),
    ).rejects.toMatchObject({
      response: { code: "CODE_TAKEN", productId: "holder", productName: "Holder" },
    });
    expect(prisma.product.create).not.toHaveBeenCalled();
  });

  it("update({isActive:true}) against an ACTIVE same-name holder is a 409 NAME_TAKEN naming it; nothing is written", async () => {
    const self = { ...BASE, isActive: false };
    prisma.product.findUnique.mockResolvedValue(self as any);
    prisma.product.findFirst.mockImplementation((args: any) => {
      if (args?.where?.id === "prod-1" && args?.where?.tenantId) return Promise.resolve(self);
      if (args?.where?.isActive === true && args?.where?.name)
        return Promise.resolve({ id: "holder", name: "Cherry Tomatoes" });
      return Promise.resolve(null);
    });

    await expect(service.update("prod-1", { isActive: true } as any)).rejects.toMatchObject({
      response: { code: "NAME_TAKEN", productId: "holder" },
    });
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it("create(): the name pre-check only counts ACTIVE products", async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    prisma.product.findMany.mockResolvedValue([]);
    prisma.product.create.mockResolvedValue({ ...BASE, id: "prod-new" } as any);

    await service.create({ name: "New", unit: "punnet", pricePerUnit: 1 } as any);

    const nameCheck = prisma.product.findFirst.mock.calls.find(([a]: any) => a?.where?.name);
    expect(nameCheck?.[0].where).toMatchObject({ isActive: true });
  });
});
