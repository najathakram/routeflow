/**
 * B1213: a variant is only as live as its family. Deactivating a family that still has ACTIVE variants first
 * answers a coded 409 (FAMILY_HAS_ACTIVE_VARIANTS, with the variant count); `confirmCascade: true` deactivates
 * those variants in the same transaction under the same code-release rules as a single deactivate. Reactivating
 * a variant whose parent family is inactive is a coded 409 (VARIANT_PARENT_INACTIVE).
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { ProductsService } from "./products.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { API_ERROR_CODES } from "../common/api-error-codes";

const TENANT = "t-1";

type Row = {
  id: string;
  name: string;
  isActive: boolean;
  kind: string;
  parentProductId: string | null;
  sku: string | null;
  barcode: string | null;
  unitSku: string | null;
};
const row = (over: Partial<Row> & { id: string }): Row => ({
  name: `Product ${over.id}`,
  isActive: true,
  kind: "STANDARD",
  parentProductId: null,
  sku: null,
  barcode: null,
  unitSku: null,
  ...over,
});

describe("ProductsService: family and variant activity (B1213)", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let rows: Row[];
  let locks: string[];

  beforeEach(async () => {
    prisma = createMockPrisma();
    locks = [];
    rows = [];
    const byId = (id?: string) => rows.find((r) => r.id === id) ?? null;
    prisma.product.findUnique.mockImplementation(async (a: { where: { id: string } }) => {
      const r = byId(a.where.id);
      return r ? { ...r, variants: [], barcodes: [], images: [], imageKeys: [] } : null;
    });
    prisma.product.findFirst.mockImplementation(
      async (a: { where?: { id?: string }; select?: unknown }) => {
        const r = byId(a?.where?.id);
        return r
          ? {
              ...r,
              unitsPerBox: null,
              retiredSku: null,
              retiredBarcode: null,
              retiredUnitSku: null,
            }
          : null;
      },
    );
    prisma.product.findMany.mockImplementation(
      async (a: { where?: { parentProductId?: string; isActive?: boolean } }) =>
        rows.filter(
          (r) =>
            a?.where?.parentProductId !== undefined &&
            r.parentProductId === a.where.parentProductId &&
            (a.where.isActive === undefined || r.isActive === a.where.isActive),
        ),
    );
    prisma.product.update.mockImplementation(
      async (a: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = byId(a.where.id);
        if (r) Object.assign(r, a.data);
        return { ...(r ?? {}), barcode: null, unitsPerBox: null, imageKeys: [] };
      },
    );
    prisma.product.updateMany.mockImplementation(
      async (a: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
        for (const r of rows) if (a.where.id.in.includes(r.id)) Object.assign(r, a.data);
        return { count: a.where.id.in.length };
      },
    );
    prisma.recipe.findFirst.mockResolvedValue(null);
    prisma.recipe.findMany.mockResolvedValue([]);
    (prisma as unknown as { tenantTransaction: jest.Mock }).tenantTransaction = jest.fn(
      (fn: (tx: unknown) => unknown) =>
        fn({
          ...prisma,
          $executeRaw: jest.fn((_s: TemplateStringsArray, ...v: unknown[]) => {
            if (v[0] === "product-barcode") locks.push(String(v[1]).split(":")[1]);
            return Promise.resolve(0);
          }),
          $queryRaw: jest.fn().mockResolvedValue([]),
        }),
    );
    (prisma as unknown as { getTenantId: jest.Mock }).getTenantId = jest
      .fn()
      .mockReturnValue(TENANT);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: { presignedUrl: jest.fn(), presignedUrls: jest.fn(), upload: jest.fn() },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    service = module.get(ProductsService);
  });

  const bodyOf = async (p: Promise<unknown>) => {
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    return (err as ConflictException).getResponse() as Record<string, unknown>;
  };
  const familyWithVariants = () => {
    rows = [
      row({ id: "fam", kind: "FAMILY" }),
      row({ id: "v1", kind: "VARIANT", parentProductId: "fam", sku: "V1-SKU" }),
      row({ id: "v2", kind: "VARIANT", parentProductId: "fam", barcode: "000111" }),
      row({ id: "v3", kind: "VARIANT", parentProductId: "fam", isActive: false }),
    ];
  };

  describe("deactivating a family (PATCH isActive: false)", () => {
    it("with active variants and no confirmation: coded 409 carrying the count; nothing is written", async () => {
      familyWithVariants();
      const body = await bodyOf(
        service.update("fam", { isActive: false } as never, { packPrecondition: "internal" }),
      );
      expect(body).toMatchObject({
        code: API_ERROR_CODES.FAMILY_HAS_ACTIVE_VARIANTS,
        variantCount: 2,
      });
      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(prisma.product.updateMany).not.toHaveBeenCalled();
      expect(rows.find((r) => r.id === "fam")?.isActive).toBe(true);
    });

    it("confirmCascade deactivates the family AND its active variants, releasing the variants' codes first", async () => {
      familyWithVariants();
      await service.update("fam", { isActive: false, confirmCascade: true } as never, {
        packPrecondition: "internal",
      });
      expect(rows.map((r) => [r.id, r.isActive])).toEqual([
        ["fam", false],
        ["v1", false],
        ["v2", false],
        ["v3", false],
      ]);
      // The variants' codes were locked in ONE sorted batch before any write (house lock order), and the
      // cascade flag is not a column.
      const first: string[] = [];
      for (const k of locks) {
        if (first.length && k <= first[first.length - 1]) break;
        first.push(k);
      }
      expect(first).toEqual(expect.arrayContaining(["000111", "V1-SKU"]));
      for (const k of locks) expect(first).toContain(k);
      for (const call of prisma.product.update.mock.calls) {
        expect(call[0].data).not.toHaveProperty("confirmCascade");
      }
    });

    it("a family whose variants are all inactive deactivates without any confirmation", async () => {
      rows = [
        row({ id: "fam", kind: "FAMILY" }),
        row({ id: "v1", kind: "VARIANT", parentProductId: "fam", isActive: false }),
      ];
      await service.update("fam", { isActive: false } as never, { packPrecondition: "internal" });
      expect(rows[0].isActive).toBe(false);
      expect(prisma.product.updateMany).not.toHaveBeenCalled();
    });

    it("an echo (no isActive change) or an unrelated edit never asks for confirmation", async () => {
      familyWithVariants();
      await service.update("fam", { description: "x" } as never, { packPrecondition: "internal" });
      await service.update("fam", { isActive: true } as never, { packPrecondition: "internal" });
      expect(prisma.product.updateMany).not.toHaveBeenCalled();
    });

    it("DELETE /products/:id on a family with active variants answers the same coded 409", async () => {
      familyWithVariants();
      const body = await bodyOf(service.remove("fam"));
      expect(body).toMatchObject({
        code: API_ERROR_CODES.FAMILY_HAS_ACTIVE_VARIANTS,
        variantCount: 2,
      });
      expect(rows.find((r) => r.id === "fam")?.isActive).toBe(true);
    });

    it("DELETE with confirmCascade archives the family and its variants", async () => {
      familyWithVariants();
      await service.remove("fam", { confirmCascade: true });
      expect(rows.every((r) => !r.isActive)).toBe(true);
    });
  });

  describe("reactivating a variant", () => {
    it("is a coded 409 while its parent family is inactive; nothing is written", async () => {
      rows = [
        row({ id: "fam", kind: "FAMILY", isActive: false }),
        row({ id: "v1", kind: "VARIANT", parentProductId: "fam", isActive: false }),
      ];
      const body = await bodyOf(
        service.update("v1", { isActive: true } as never, { packPrecondition: "internal" }),
      );
      expect(body).toMatchObject({ code: API_ERROR_CODES.VARIANT_PARENT_INACTIVE });
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("works when the parent family is active", async () => {
      rows = [
        row({ id: "fam", kind: "FAMILY" }),
        row({ id: "v1", kind: "VARIANT", parentProductId: "fam", isActive: false }),
      ];
      await service.update("v1", { isActive: true } as never, { packPrecondition: "internal" });
      expect(rows[1].isActive).toBe(true);
    });

    it("a standalone product reactivates as before", async () => {
      rows = [row({ id: "solo", isActive: false })];
      await service.update("solo", { isActive: true } as never, { packPrecondition: "internal" });
      expect(rows[0].isActive).toBe(true);
    });
  });
});
