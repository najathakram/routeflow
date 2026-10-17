import { Test } from "@nestjs/testing";
import { ProductsService } from "./products.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";

describe("ProductsService.findAll portalVisible filter", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: { presignedUrl: jest.fn() } },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(true) } },
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        {
          provide: EntitlementsService,
          useValue: {
            hasFlag: jest.fn(async (_t: string, k: string) => k !== "flag.units_prices_v2"),
          },
        },
        { provide: PlanCatalogService, useValue: { upgradeTargetForFlag: jest.fn() } },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ProductsService);
  });

  const whereOf = () => (prisma.product.findMany.mock.calls[0][0] as { where: object }).where;

  const HIDDEN = { OR: [{ portalVisible: false }, { parent: { portalVisible: false } }] };

  it("portalVisible=false = hidden by its OWN flag or through a hidden PARENT (what the badge shows)", async () => {
    await service.findAll({ portalVisible: false } as never);
    expect((whereOf() as { AND: unknown[] }).AND).toContainEqual(HIDDEN);
  });

  it("portalVisible=true = the complement (visible and not under a hidden parent)", async () => {
    await service.findAll({ portalVisible: true } as never);
    expect((whereOf() as { AND: unknown[] }).AND).toContainEqual({ NOT: HIDDEN });
  });

  it("absent = no portalVisible key at all", async () => {
    await service.findAll({} as never);
    expect(Object.keys(whereOf())).not.toContain("portalVisible");
  });
});
