/**
 * Row 701 (SA-823 PR-2, R7a): a family an import created and then deactivated (every row of that run failed) is
 * REACTIVATED by a re-run of the same file, not skipped as "inactive", and the re-run writes one
 * `product.family.reactivated` audit row. Control: an inactive family that was NOT made by an import still skips.
 * Real Postgres for the family, its audit marks, deactivation and reactivation; the only stub is run 1's per-row
 * write (`ProductsService.assignToParent` rejected once per row), which is how "all rows fail" is forced.
 * Throwaway `qa-fra*` tenant. Collected only by jest.db.config.js.
 */

import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { ImportService } from "./import.service";
import { ProductFamilyImportService } from "./product-family-import.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { ProductsService } from "../products/products.service";
import { ProductFamiliesService } from "../products/product-families.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { AuditService } from "../audit/audit.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { MeterService } from "../billing/meter.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { EmailService } from "../email/email.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = `FRA${randomUUID().slice(0, 8)}`;

describeDb(
  "Row 701: an import re-run reactivates the empty family an earlier run made (real Postgres)",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let importService: ImportService;
    let products: ProductsService;
    let tenantId: string;
    let pricingMode = "off";

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      const slug = assertTestTenant(
        `qa-${RUN.toLowerCase()}`,
        "product-family-reactivate.db.spec.ts",
      );
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      tenantId = (await prisma.tenant.create({ data: { slug, name: `SA-823 ${slug}` } })).id;

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ImportService,
          ProductFamilyImportService,
          ProductFamiliesService,
          NumberingService,
          ExternalRefService,
          ProductsService,
          CustomersService,
          AuditService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: FeatureConfigService,
            useValue: { getEffectiveMode: jest.fn(async () => pricingMode) },
          },
          { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(true) } },
          { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
          { provide: VendorBillsService, useValue: { create: jest.fn(), receive: jest.fn() } },
          {
            provide: SellingRestrictionsService,
            useValue: {
              checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
            },
          },
          { provide: StorageService, useValue: {} },
          { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(true) } },
          { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
          {
            provide: EntitlementsService,
            useValue: {
              hasFlag: jest.fn(async (_t: string, k: string) => k !== "flag.units_prices_v2"),
            },
          },
          { provide: PlanCatalogService, useValue: { upgradeTargetForFlag: jest.fn() } },
          {
            provide: RouteFlowGateway,
            useValue: { emitProductUpdated: jest.fn(), emitCatalogChanged: jest.fn() },
          },
          { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
          { provide: MeterService, useValue: { read: jest.fn().mockResolvedValue(0) } },
          { provide: CommissionEngineService, useValue: {} },
          { provide: RegulatedLedgerService, useValue: { reverseInvoiceEntries: jest.fn() } },
          { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue(undefined) } },
        ],
      }).compile();
      importService = module.get(ImportService);
      products = module.get(ProductsService);
    });

    afterAll(async () => {
      if (tenantId) {
        await prisma.auditLog.deleteMany({ where: { tenantId } }).catch(() => {});
        // variants first (parent FK), then everything else of the throwaway tenant
        await prisma.product
          .deleteMany({ where: { tenantId, parentProductId: { not: null } } })
          .catch(() => {});
        await prisma.product.deleteMany({ where: { tenantId } }).catch(() => {});
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
      }
      await prisma?.$disconnect();
    });

    const seed = (sku: string, name: string, over: Record<string, unknown> = {}) =>
      prisma.product.create({
        data: {
          tenantId,
          name,
          sku,
          unit: "each",
          pricePerUnit: "5.00",
          currentStock: 40,
          ...over,
        } as never,
      });
    const run = (csv: string, dryRun = false) =>
      tenantCtx.run(tenantId, () =>
        importService.importProducts(Buffer.from(csv), "user-1", { dryRun, fileName: "fam.csv" }),
      );

    const famRoots = (name: string) =>
      prisma.product.findMany({ where: { tenantId, name, parentProductId: null } });

    it("REG: run 1 creates Acme Fizz and deactivates it (all rows fail); run 2 of the same file reactivates it", async () => {
      const p1 = await seed(`${RUN}-F1`, `${RUN} Fizz Lemon`);
      const p2 = await seed(`${RUN}-F2`, `${RUN} Fizz Lime`);
      const FAM = `${RUN} Acme Fizz`;
      const file = `Item Name,SKU,Family,Variant Name\n,${RUN}-F1,${FAM},Lemon\n,${RUN}-F2,${FAM},Lime\n`;

      const spy = jest
        .spyOn(products, "assignToParent")
        .mockRejectedValue(new BadRequestException("forced write failure (spec)"));
      const r1: any = await run(file);
      spy.mockRestore();
      expect(r1.skipped).toBe(2);
      expect(r1.families?.deactivated).toEqual([{ name: FAM }]);
      const after1 = await famRoots(FAM);
      expect(after1).toHaveLength(1);
      expect(after1[0]).toMatchObject({ kind: "FAMILY", isActive: false });
      const famId = after1[0].id;
      expect(
        await prisma.auditLog.count({
          where: { tenantId, action: "import.family.created", entityId: famId },
        }),
      ).toBe(1);

      const r2: any = await run(file);
      expect(r2.skipped).toBe(0);
      expect(r2.updated).toBe(2);
      expect((r2.skippedRows ?? []).map((s: any) => s.reason)).toEqual([]);
      const after2 = await famRoots(FAM);
      expect(after2.map((f) => [f.id, f.isActive])).toEqual([[famId, true]]); // the SAME family, reactivated
      const kids = await prisma.product.findMany({ where: { tenantId, parentProductId: famId } });
      expect(kids.map((k) => k.id).sort()).toEqual([p1.id, p2.id].sort());
      expect(
        await prisma.auditLog.count({
          where: { tenantId, action: "product.family.reactivated", entityId: famId },
        }),
      ).toBe(1);
    }, 120_000);

    it("control: an inactive family that was NOT made by an import still skips as inactive", async () => {
      await seed(`${RUN}-H1`, `${RUN} Hand Item`);
      const HAND = `${RUN} Acme Hand`;
      const hand = await prisma.product.create({
        data: {
          tenantId,
          name: HAND,
          kind: "FAMILY",
          unit: "each",
          pricePerUnit: "1.00",
          isActive: false,
        } as never,
      });
      const r: any = await run(`Item Name,SKU,Family,Variant Name\n,${RUN}-H1,${HAND},One\n`);
      expect(r.skipped).toBe(1);
      expect(r.skippedRows[0].reason).toMatch(/inactive/i);
      expect((await prisma.product.findUnique({ where: { id: hand.id } }))?.isActive).toBe(false);
      expect(
        await prisma.auditLog.count({
          where: { tenantId, action: "product.family.reactivated", entityId: hand.id },
        }),
      ).toBe(0);
    }, 120_000);
  },
);
