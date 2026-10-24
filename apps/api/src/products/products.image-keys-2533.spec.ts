import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ProductsService } from "./products.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { FeatureOverrideService } from "../billing/feature-override.service";
import {
  assertImageKeysReorder,
  isOwnProductImageKey,
  signableImageKeys,
} from "./product-image-keys";

/**
 * #2533 (SECURITY): a product's image keys never name another product's (or tenant's) file.
 * PATCH /products/:id used to store any key list and the server signed whatever was stored, so a
 * tenant could mint a working signed URL for another tenant's logo, payment image or PDF (and
 * `deleteImage` would delete it). Red-first against the pre-fix service.
 */
const P = "11111111-1111-4111-8111-111111111111"; // this tenant's product
const OTHER = "99999999-9999-4999-8999-999999999999"; // a product of ANOTHER tenant
const own = (n: number) => `products/${P}/aaaaaaaa-0000-4000-8000-00000000000${n}.jpg`;
const FOREIGN = `products/${OTHER}/bbbbbbbb-0000-4000-8000-000000000001.jpg`;
const TENANT_LOGO = "tenants/22222222-2222-4222-8222-222222222222/logo.png";
const TRAVERSAL = `products/${P}/../../tenants/22222222-2222-4222-8222-222222222222/logo.png`;

describe("product image keys — the own-prefix rule (#2533)", () => {
  it("accepts only a single segment under products/<thisProductId>/", () => {
    expect(isOwnProductImageKey(P, own(1))).toBe(true);
    expect(isOwnProductImageKey(P, `products/${P}/x-fp30x70.webp`)).toBe(true);
    for (const k of [FOREIGN, TENANT_LOGO, TRAVERSAL, `products/${P}/`, `products/${P}`, "", 42])
      expect(isOwnProductImageKey(P, k)).toBe(false);
    expect(isOwnProductImageKey("", own(1))).toBe(false);
  });

  it("signableImageKeys keeps own keys in order and drops the rest", () => {
    expect(signableImageKeys(P, [own(1), FOREIGN, TENANT_LOGO, own(2)])).toEqual([own(1), own(2)]);
    expect(signableImageKeys(P, null)).toEqual([]);
  });

  it("a PATCH may reorder or drop held own keys — nothing else", () => {
    expect(() => assertImageKeysReorder(P, [own(1), own(2)], [own(2), own(1)])).not.toThrow();
    expect(() => assertImageKeysReorder(P, [own(1), own(2)], [own(2)])).not.toThrow();
    expect(() => assertImageKeysReorder(P, [own(1)], [])).not.toThrow();
    for (const next of [[FOREIGN], [TENANT_LOGO], [TRAVERSAL], [own(3)], [own(1), own(1)]])
      expect(() => assertImageKeysReorder(P, [own(1), own(2)], next)).toThrow(BadRequestException);
  });
});

describe("ProductsService — cross-tenant image keys (#2533)", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const storage = {
    presignedUrl: jest.fn(async (k: string) => `signed:${k}`),
    presignedUrls: jest.fn(async (ks: string[]) => ks.map((k) => `signed:${k}`)),
    delete: jest.fn(async () => undefined),
  };
  const row = (imageKeys: string[]) => ({
    id: P,
    name: "Widget",
    parentProductId: null,
    imageKeys,
    trackedCategoryId: null,
    trackedSubcategoryId: null,
    regItemType: null,
    regUomCase: null,
    regUomUnit: null,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
        { provide: AddonService, useValue: { assertWithinLimit: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements, // #2241
        // #2185: ProductsService reads admin overrides for the forecasting-gate denial body.
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: PlanCatalogService, useValue: { upgradeTargetForFlag: jest.fn() } },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ProductsService);
    prisma.stockAlert.count.mockResolvedValue(0);
  });

  describe("PATCH /products/:id (update)", () => {
    it.each([
      ["another tenant's product image", FOREIGN],
      ["a tenant logo", TENANT_LOGO],
      ["a traversal out of the product prefix", TRAVERSAL],
      ["an own-shaped key the product does not hold (must be uploaded)", own(3)],
    ])("refuses %s with a 400 and writes nothing", async (_label, planted) => {
      prisma.product.findUnique.mockResolvedValue(row([own(1)]));
      await expect(
        service.update(P, { imageKeys: [own(1), planted] } as any, {
          packPrecondition: "internal",
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("a reorder of the product's own images is written as sent", async () => {
      prisma.product.findUnique.mockResolvedValue(row([own(1), own(2)]));
      prisma.product.update.mockResolvedValue(row([own(2), own(1)]));
      await service.update(P, { imageKeys: [own(2), own(1)] } as any, {
        packPrecondition: "internal",
      });
      expect(prisma.product.update.mock.calls[0][0].data.imageKeys).toEqual([own(2), own(1)]);
    });
  });

  describe("reads never sign a key outside the product's prefix (a row poisoned before the fix)", () => {
    it("GET /products/:id signs and returns only own keys, still index-aligned", async () => {
      prisma.product.findUnique.mockResolvedValue(row([own(1), FOREIGN, TENANT_LOGO, own(2)]));
      const p: any = await service.findOne(P);
      const signed = storage.presignedUrls.mock.calls.flat(2);
      expect(signed).toEqual([own(1), own(2)]);
      expect(p.imageKeys).toEqual([own(1), own(2)]);
      expect(p.imageUrls).toEqual([`signed:${own(1)}`, `signed:${own(2)}`]);
      expect(JSON.stringify(p)).not.toContain(OTHER);
    });

    it("the list thumbnail skips a planted first key", async () => {
      prisma.product.findMany.mockResolvedValue([row([FOREIGN, own(1)])]);
      prisma.product.count.mockResolvedValue(1);
      const res: any = await service.findAll({} as any);
      expect(storage.presignedUrl).toHaveBeenCalledWith(own(1));
      expect(storage.presignedUrl).not.toHaveBeenCalledWith(FOREIGN);
      expect(res.data[0].thumbnailUrl).toBe(`signed:${own(1)}`);
    });
  });

  it("deleteImage unlinks a planted foreign key but never deletes the other tenant's file", async () => {
    prisma.product.findUnique.mockResolvedValue(row([own(1), FOREIGN]));
    await service.deleteImage(P, FOREIGN);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(prisma.product.update.mock.calls[0][0].data.imageKeys).toEqual([own(1)]);
  });

  it("deleteImage still deletes the product's own file", async () => {
    prisma.product.findUnique.mockResolvedValue(row([own(1)]));
    await service.deleteImage(P, own(1));
    expect(storage.delete).toHaveBeenCalledWith(own(1));
  });

  // #2728 M1 follow-up (SA-572f, amendment 1 — FINAL): findOne's `images` is a PER-KEY merge over
  // mirrorableImageKeys(product) — a key with a ProductImage row renders ROW, a key with none (a
  // duplicate's second occurrence, or one skipped by the sync's per-key belt) renders LEGACY, in
  // the same list, same order.
  it("findOne merges rows and legacy fallback PER KEY over mirrorableImageKeys (dedup, own-only)", async () => {
    prisma.product.findUnique.mockResolvedValue({
      ...row([own(1), own(1), own(2), FOREIGN]),
      barcode: null,
      unitsPerBox: null,
      barcodes: [],
      images: [
        {
          storageKey: own(1),
          sortOrder: 0,
          isPrimary: true,
          focalX: null,
          focalY: null,
          altText: null,
        },
      ],
    });
    const p: any = await service.findOne(P);
    expect(p.images).toHaveLength(2); // FOREIGN is never in the mirror set; own(1) deduped to one
    expect(p.images[0]).toMatchObject({ storageKey: own(1), origin: "ROW", isPrimary: true });
    expect(p.images[1]).toMatchObject({
      storageKey: own(2),
      origin: "LEGACY",
      sortOrder: 1,
      isPrimary: false,
    });
  });

  it("#2717 M1 (SA-572f): an edit SUCCEEDS while another product's row holds this product's image key; that key is skipped", async () => {
    // Legacy data: k1 is (unexpectedly) already mirrored by ANOTHER product; k2 is free. A price-only
    // PATCH must not 500 on the (tenantId, storageKey) unique: k1 is skipped, k2 mirrors.
    prisma.product.findUnique.mockResolvedValue(row([own(1), own(2)]));
    prisma.product.findFirst.mockResolvedValue(null);
    prisma.product.update.mockResolvedValue({
      ...row([own(1), own(2)]),
      barcode: null,
      unitsPerBox: null,
    });
    prisma.productImage.findMany.mockImplementation(async ({ where }: { where: any }) =>
      "storageKey" in where ? [{ storageKey: own(1) }] : [],
    );
    await expect(
      service.update(P, { pricePerUnit: "9.99" } as any, { packPrecondition: "internal" }),
    ).resolves.toBeDefined();
    const created = prisma.productImage.create.mock.calls.map((c: any[]) => c[0].data.storageKey);
    expect(created).toEqual([own(2)]);
  });

  it("#2717 M1: image rows sync from the value the UPDATE wrote, not the earlier read (a concurrent upload is kept)", async () => {
    // The PATCH carries no imageKeys; between update()'s read ([own(1)]) and its write, a concurrent
    // upload pushed own(2). The UPDATE returns the post-write row, so the rows must follow it.
    prisma.product.findUnique.mockResolvedValue(row([own(1)]));
    prisma.product.findFirst.mockResolvedValue(null);
    prisma.product.update.mockResolvedValue({
      ...row([own(1), own(2)]),
      barcode: null,
      unitsPerBox: null,
    });
    prisma.productImage.findMany.mockResolvedValue([]);
    await service.update(P, { name: "Widget 2" } as any, { packPrecondition: "internal" });
    const created = prisma.productImage.create.mock.calls.map((c: any[]) => c[0].data.storageKey);
    expect(created).toEqual([own(1), own(2)]);
  });
});
