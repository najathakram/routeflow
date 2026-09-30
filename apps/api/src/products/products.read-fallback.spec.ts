import { Test, TestingModule } from "@nestjs/testing";
import { ProductsService } from "./products.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";
import { synthesizeLegacyBarcodes, synthesizeLegacyImages } from "./product-barcode-rules";

/**
 * T14 (#2728 M1 build-plan, SA-572b Q5): findOne's additive read-model fallback. A product with NO
 * ProductBarcode/ProductImage rows synthesizes both from the legacy columns (origin "LEGACY"); a
 * product WITH rows returns the rows (origin ROW/ENTERED/COPIED as stored). Every pre-existing field
 * (barcode, imageKeys, imageUrls) is untouched either way.
 */
const BASE_PRODUCT = {
  id: "prod-1",
  name: "Case of Widgets",
  sku: "WID-001",
  unit: "case",
  pricePerUnit: 24.0,
  category: "Widgets",
  description: null,
  isActive: true,
  imageKeys: ["products/prod-1/a.jpg", "products/prod-1/b-fp30x70.jpg"],
  barcode: "036000291452",
  unitsPerBox: 12,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("ProductsService.findOne — additive read fallback (T14)", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: {
            presignedUrl: jest.fn().mockResolvedValue("http://mock-url"),
            presignedUrls: jest
              .fn()
              .mockImplementation((keys: string[]) =>
                Promise.resolve(keys.map((k) => `signed:${k}`)),
              ),
            upload: jest.fn(),
            delete: jest.fn(),
          },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements,
        // #2185: the reorder gate's deny body reads admin overrides.
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    service = module.get<ProductsService>(ProductsService);
  });

  it("no rows -> barcodes synthesized from the legacy column (origin LEGACY) = planBarcodeRows", async () => {
    prisma.product.findUnique.mockResolvedValue({
      ...BASE_PRODUCT,
      barcodes: [],
      images: [],
    } as any);
    prisma.stockAlert.count.mockResolvedValue(0);

    const result = await service.findOne("prod-1");

    const expected = synthesizeLegacyBarcodes({
      barcode: BASE_PRODUCT.barcode,
      unitsPerBox: BASE_PRODUCT.unitsPerBox,
    });
    expect((result as any).barcodes).toEqual(expected);
    expect((result as any).barcodes.every((b: any) => b.origin === "LEGACY")).toBe(true);
    // Pre-existing fields untouched.
    expect(result.barcode).toBe(BASE_PRODUCT.barcode);
    expect(result.imageKeys).toEqual(BASE_PRODUCT.imageKeys);
  });

  it("no rows -> images synthesized from imageKeys (origin LEGACY), focal parsed", async () => {
    prisma.product.findUnique.mockResolvedValue({
      ...BASE_PRODUCT,
      barcodes: [],
      images: [],
    } as any);
    prisma.stockAlert.count.mockResolvedValue(0);

    const result = await service.findOne("prod-1");

    const expected = synthesizeLegacyImages(BASE_PRODUCT.imageKeys, (k) => `signed:${k}`);
    expect((result as any).images).toEqual(expected);
    expect((result as any).images.every((i: any) => i.origin === "LEGACY")).toBe(true);
    expect((result as any).images[1].focalX).toBe(30);
    expect((result as any).images[1].focalY).toBe(70);
  });

  // #2728 M1 follow-up (SA-572f, amendment 1 — FINAL): images are a PER-KEY merge over
  // mirrorableImageKeys, not an all-or-nothing switch — a mirrorable key with no row (b-fp30x70.jpg
  // here) still renders, via its LEGACY fallback, alongside the keys that DO have a row.
  it("with rows -> rows returned as-is; a mirrorable key with no row still renders via LEGACY", async () => {
    const rows = [
      {
        code: "036000291452",
        level: "BOX",
        symbology: "UPC_A",
        origin: "ENTERED",
        copiedFromLevel: null,
        primaryFor: "BOX",
      },
      {
        code: "036000291452",
        level: "UNIT",
        symbology: "UPC_A",
        origin: "COPIED",
        copiedFromLevel: "BOX",
        primaryFor: "UNIT",
      },
    ];
    const imageRows = [
      {
        storageKey: "products/prod-1/a.jpg",
        focalX: null,
        focalY: null,
        sortOrder: 0,
        isPrimary: true,
        altText: null,
      },
    ];
    prisma.product.findUnique.mockResolvedValue({
      ...BASE_PRODUCT,
      barcodes: rows,
      images: imageRows,
    } as any);
    prisma.stockAlert.count.mockResolvedValue(0);

    const result = await service.findOne("prod-1");

    expect((result as any).barcodes).toEqual(rows);
    expect((result as any).images).toEqual([
      {
        storageKey: "products/prod-1/a.jpg",
        url: "signed:products/prod-1/a.jpg",
        focalX: null,
        focalY: null,
        sortOrder: 0,
        isPrimary: true,
        altText: null,
        origin: "ROW",
      },
      {
        storageKey: "products/prod-1/b-fp30x70.jpg",
        url: "signed:products/prod-1/b-fp30x70.jpg",
        focalX: 30,
        focalY: 70,
        sortOrder: 1,
        isPrimary: false,
        altText: null,
        origin: "LEGACY",
      },
    ]);
  });
});
