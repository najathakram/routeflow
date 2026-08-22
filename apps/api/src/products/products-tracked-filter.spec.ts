import { Test, TestingModule } from "@nestjs/testing";
import { ProductsService } from "./products.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * Regression pins for the W7 tracked-category exclusion in `findAll`.
 *
 * The original shape — `where.trackedCategoryId = { notIn: [...] }` — looked
 * obviously right and was catastrophically wrong: Prisma's `notIn` never
 * matches NULL rows, so the moment a tenant had ONE `requiresLicense`
 * category, every product with NO tracked category vanished from the buyer
 * catalog too. On a live tenant that hid 1,757 of 1,823 products from every
 * unlicensed buyer ("the shop is empty"), proven by a reversible experiment
 * on the e2e tenant: one license-gated category with ZERO tagged products
 * took the visible catalog from 5 straight to 0.
 *
 * These specs pin the WHERE SHAPE (null explicitly allowed back in), because
 * a unit test against a mocked Prisma cannot observe the SQL NULL semantics
 * that make the bare `notIn` wrong.
 */
describe("ProductsService.findAll — tracked-category exclusion is NULL-safe", () => {
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
          useValue: { presignedUrl: jest.fn(), presignedUrls: jest.fn() },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        { provide: PlanCatalogService, useValue: { upgradeTargetForFlag: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ProductsService);
    prisma.product.findMany.mockResolvedValue([]);
    prisma.product.count.mockResolvedValue(0);
  });

  it("allows NULL-tracked products through when categories are excluded", async () => {
    await service.findAll({ isActive: true, page: 1, limit: 20 } as any, {
      excludeTrackedCategoryIds: ["cat-tobacco", "cat-hydroxy"],
    });

    const where = prisma.product.findMany.mock.calls.at(-1)?.[0].where;
    // The exclusion must be AND-pushed as (NULL OR notIn) — never a bare
    // notIn keyed on the column, which silently drops every NULL row.
    expect(where.trackedCategoryId).toBeUndefined();
    expect(where.AND).toEqual(
      expect.arrayContaining([
        {
          OR: [
            { trackedCategoryId: null },
            { trackedCategoryId: { notIn: ["cat-tobacco", "cat-hydroxy"] } },
          ],
        },
      ]),
    );
  });

  it("adds no tracked filter at all when nothing is excluded", async () => {
    await service.findAll({ isActive: true, page: 1, limit: 20 } as any, undefined);

    const where = prisma.product.findMany.mock.calls.at(-1)?.[0].where;
    expect(where.trackedCategoryId).toBeUndefined();
    expect(where.AND ?? []).toEqual([]);
  });

  it("composes with a search OR instead of clobbering it", async () => {
    await service.findAll({ isActive: true, search: "cola", page: 1, limit: 20 } as any, {
      excludeTrackedCategoryIds: ["cat-tobacco"],
    });

    const where = prisma.product.findMany.mock.calls.at(-1)?.[0].where;
    // The search OR must survive; the exclusion rides in AND.
    expect(where.OR).toBeDefined();
    expect(where.AND).toEqual(
      expect.arrayContaining([
        {
          OR: [{ trackedCategoryId: null }, { trackedCategoryId: { notIn: ["cat-tobacco"] } }],
        },
      ]),
    );
  });
});
