import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { ImportService } from "./import.service";
import { PrismaService } from "../prisma/prisma.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { ProductsService } from "../products/products.service";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { PRODUCT_COLUMNS, CUSTOMER_COLUMNS } from "./import-columns";

describe("ImportService.importProducts — formula-led product name (B964-2, preview parity)", () => {
  let service: ImportService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let productsService: {
    create: jest.Mock;
    update: jest.Mock;
    emitCatalogBulkChanged: jest.Mock;
    assertCanFlagTobacco: jest.Mock;
    assertMsrpAllowed: jest.Mock;
    assertIdentityAvailable: jest.Mock;
    assertReorderAllowed: jest.Mock;
  };
  let auditService: { log: jest.Mock };
  let customers: {
    assertCustomerCapNotExceeded: jest.Mock;
    maybeStartCustomerGrace: jest.Mock;
    update: jest.Mock;
    setCustomerConsent: jest.Mock;
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    productsService = {
      create: jest.fn().mockResolvedValue({ id: "prod-new" }),
      update: jest.fn().mockResolvedValue({ id: "prod-existing" }),
      emitCatalogBulkChanged: jest.fn(),
      assertCanFlagTobacco: jest.fn().mockResolvedValue(undefined),
      assertMsrpAllowed: jest.fn().mockResolvedValue(undefined),
      assertIdentityAvailable: jest.fn().mockResolvedValue(undefined),
      assertReorderAllowed: jest.fn().mockResolvedValue(undefined),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    customers = {
      assertCustomerCapNotExceeded: jest.fn().mockResolvedValue(undefined),
      maybeStartCustomerGrace: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue({ id: "cust-existing" }),
      // SA-305 (2): consent + its evidence now go through CustomersService.setCustomerConsent
      // (ONE tenantTransaction), never through applyCustomerCommercialFields -> auditService.log.
      setCustomerConsent: jest.fn().mockResolvedValue(undefined),
    };

    const mod = await Test.createTestingModule({
      providers: [
        {
          provide: SellingRestrictionsService,
          useValue: {
            judgeStaffWrite: jest.fn().mockResolvedValue({
              outcome: "ALLOW",
              reasons: [],
              breaches: [],
              basis: "CUSTOMER",
            }),
          },
        },
        ImportService,
        { provide: PrismaService, useValue: prisma },
        { provide: VendorBillsService, useValue: { create: jest.fn(), receive: jest.fn() } },
        { provide: CustomersService, useValue: customers },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
        {
          provide: ExternalRefService,
          useValue: { findLocalId: jest.fn().mockResolvedValue(null), record: jest.fn() },
        },
        // Not yet consumed by ImportService's constructor (RC1) — wired here so the fix task
        // only has to add these to the constructor, not to every spec that exercises DI.
        { provide: ProductsService, useValue: productsService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();
    service = mod.get(ImportService);
  });

  const NAME_MSG = "Product name can't start with =, +, -, @ or a tab/line break";
  const csv = "Item Name,SKU,Rate\n=HYPERLINK(1),SKU-1,10\n";

  it("a real run skips a formula-led NEW product name with the readable reason and never calls create", async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    const r: any = await service.importProducts(Buffer.from(csv), "user-1");
    expect(r.skipped).toBe(1);
    expect(r.imported).toBe(0);
    expect(productsService.create).not.toHaveBeenCalled();
    expect(r.errors.some((e: string) => e.endsWith(NAME_MSG))).toBe(true);
  });

  it("the DRY RUN agrees: the same row is a skip with the same reason (not a create)", async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    const real: any = await service.importProducts(Buffer.from(csv), "user-1");
    const preview: any = await service.importProducts(Buffer.from(csv), "user-1", { dryRun: true });
    expect(preview.skipped).toBe(1);
    expect(preview.imported).toBe(0);
    expect(preview.errors).toEqual(real.errors);
    expect(productsService.assertIdentityAvailable).not.toHaveBeenCalled();
    const plan = (preview.rowPlans ?? preview.plan ?? []).find((p: any) => p.row === 2);
    if (plan) expect(plan.action).toBe("skip");
  });

  describe("a RENAME of a stored product (the update path)", () => {
    const csvRename = "Item Name,SKU,Price Tier 2\n=HYPERLINK(1),SKU-1,9.5\n";
    const stored = {
      id: "prod-1",
      name: "Widget Pro",
      sku: "SKU-1",
      unitsPerBox: null,
      priceTier2: 5,
    };
    const found = () =>
      prisma.product.findFirst.mockImplementation(async (args: any) =>
        args?.where?.sku === "SKU-1" ? stored : null,
      );

    it("a formula-led NEW name on a matched product is a skip in BOTH modes, with the same reason; update() is never called", async () => {
      found();
      const real: any = await service.importProducts(Buffer.from(csvRename), "user-1");
      expect(real.skipped).toBe(1);
      expect(productsService.update).not.toHaveBeenCalled();
      expect(real.errors.some((e: string) => e.endsWith(NAME_MSG))).toBe(true);

      found();
      const preview: any = await service.importProducts(Buffer.from(csvRename), "user-1", {
        dryRun: true,
      });
      expect(preview.skipped).toBe(1);
      expect(preview.errors).toEqual(real.errors);
      expect(productsService.assertIdentityAvailable).not.toHaveBeenCalled();
    });

    it("change-only: a LEGACY formula-led stored name echoed back unchanged still updates other fields", async () => {
      prisma.product.findFirst.mockImplementation(async (args: any) =>
        args?.where?.sku === "SKU-1" ? { ...stored, name: "=LEGACY" } : null,
      );
      const csv = "Item Name,SKU,Price Tier 2\n=LEGACY,SKU-1,9.5\n";
      const real: any = await service.importProducts(Buffer.from(csv), "user-1");
      expect(real.skipped).toBe(0);
      expect(productsService.update).toHaveBeenCalledTimes(1);
    });
  });

  describe("free-text category cell (B990)", () => {
    const CAT_MSG = "Category can't start with =, +, -, @ or a tab/line break";
    const csvCreate = "Item Name,SKU,Rate,Category\nWidget,SKU-9,10,=HYPERLINK(1)\n";

    it("a NEW product with a formula-led category is a skip in BOTH modes, same reason, create() never called", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      const real: any = await service.importProducts(Buffer.from(csvCreate), "user-1");
      expect(real.skipped).toBe(1);
      expect(productsService.create).not.toHaveBeenCalled();
      expect(real.errors.some((e: string) => e.endsWith(CAT_MSG))).toBe(true);
      const preview: any = await service.importProducts(Buffer.from(csvCreate), "user-1", {
        dryRun: true,
      });
      expect(preview.skipped).toBe(1);
      expect(preview.errors).toEqual(real.errors);
      expect(productsService.assertIdentityAvailable).not.toHaveBeenCalled();
    });

    it("an UPDATE that changes a stored category to a formula-led one is a skip in both modes; an unchanged legacy one is not", async () => {
      const stored = {
        id: "prod-1",
        name: "Widget",
        sku: "SKU-1",
        unitsPerBox: null,
        category: "Tools",
        trackedSubcategoryId: null,
      };
      prisma.product.findFirst.mockImplementation(async (a: any) =>
        a?.where?.sku === "SKU-1" ? stored : null,
      );
      const csv = "Item Name,SKU,Category\nWidget,SKU-1,@evil\n";
      const real: any = await service.importProducts(Buffer.from(csv), "user-1");
      expect(real.skipped).toBe(1);
      expect(productsService.update).not.toHaveBeenCalled();
      const preview: any = await service.importProducts(Buffer.from(csv), "user-1", {
        dryRun: true,
      });
      expect(preview.errors).toEqual(real.errors);

      prisma.product.findFirst.mockImplementation(async (a: any) =>
        a?.where?.sku === "SKU-1" ? { ...stored, category: "=LEGACY" } : null,
      );
      const legacy: any = await service.importProducts(
        Buffer.from("Item Name,SKU,Category,Rate\nWidget,SKU-1,=LEGACY,5\n"),
        "user-1",
      );
      expect(legacy.skipped).toBe(0);
    });
  });

  it("an ordinary name still previews and imports as a create", async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    const ok = "Item Name,SKU,Rate\nWidget Pro,SKU-1,10\n";
    const preview: any = await service.importProducts(Buffer.from(ok), "user-1", { dryRun: true });
    expect(preview.skipped).toBe(0);
    expect(preview.imported).toBe(1);
  });
});
