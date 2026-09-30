/**
 * WS7 I12 (SA-603a), NEED-DB. The importers respect one-ACTIVE-holder-per-code on real Postgres:
 *   1. deactivate A(X) -> importing X CREATES a new product B(X) (never an update of the inactive A)
 *   2. re-importing X UPDATES B and leaves A untouched (A stays inactive, its retired code intact)
 *   3. an import racing a reactivation of A: exactly ONE of {B holds X, A holds X} wins; the loser
 *      is reported with a reason (the import row is skipped, never a raw 500 / P2002, never silent)
 *
 * Authored, never executed on the PC (builders post NEED-DB; the prover owns `npm run local:test:db`).
 * Own throwaway `qa-ws7-<run>` tenant gated by `assertTestTenant`, same harness as
 * import-commercial-columns.db.spec.ts. Deactivate = ProductsService.remove (releases codes),
 * reactivate = ProductsService.update({ isActive: true }) (restores the still-free codes).
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { ImportService } from "./import.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { ProductsService } from "../products/products.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
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

const RUN = `WS7${randomUUID().slice(0, 8)}`;
const X = `${RUN}-X`;

describeDb(
  "WS7 I12 — import respects active-only lookups and released codes (real Postgres)",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let importService: ImportService;
    let productsService: ProductsService;
    let tenantId: string;
    const createdProductIds: string[] = [];

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      const slug = assertTestTenant(`qa-ws7-${RUN.toLowerCase()}`, "import-code-reuse.db.spec.ts");
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const tenant = await prisma.tenant.create({ data: { slug, name: `WS7 ${slug}` } });
      tenantId = tenant.id;

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ImportService,
          NumberingService,
          ExternalRefService,
          ProductsService,
          { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(true) } },
          { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
          CustomersService,
          AuditService,
          { provide: PrismaService, useValue: prisma },
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
            useValue: { hasFlag: jest.fn().mockResolvedValue(true) },
          },
          { provide: PlanCatalogService, useValue: { upgradeTargetForFlag: jest.fn() } },
          { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
          { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
          { provide: MeterService, useValue: { read: jest.fn().mockResolvedValue(0) } },
          { provide: CommissionEngineService, useValue: {} },
          { provide: RegulatedLedgerService, useValue: { reverseInvoiceEntries: jest.fn() } },
          { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue(undefined) } },
        ],
      }).compile();
      importService = module.get(ImportService);
      productsService = module.get(ProductsService);
    });

    afterAll(async () => {
      if (!tenantId) {
        await prisma?.$disconnect();
        return;
      }
      // Tenant-scoped deletes only (an undefined tenantId filter would match every row).
      await prisma.auditLog.deleteMany({ where: { tenantId } }).catch(() => {});
      await prisma.productBarcode.deleteMany({ where: { tenantId } }).catch(() => {});
      if (createdProductIds.length > 0) {
        await prisma.product
          .deleteMany({ where: { id: { in: createdProductIds } } })
          .catch(() => {});
      }
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
      await prisma?.$disconnect();
    });

    const inTenant = <T>(fn: () => Promise<T>): Promise<T> => tenantCtx.run(tenantId, fn);
    const importCsv = (csv: string) =>
      inTenant(() => importService.importProducts(Buffer.from(csv), "user-1"));
    const byName = (name: string) => prisma.product.findFirst({ where: { tenantId, name } });

    it("I12a/b: deactivate A(X); import creates B(X); re-import updates B and leaves A untouched", async () => {
      const a = await inTenant(() =>
        productsService.create({
          name: `${RUN} Old`,
          sku: X,
          pricePerUnit: 3,
          unit: "unit",
        } as any),
      );
      createdProductIds.push(a.id);
      await inTenant(() => productsService.remove(a.id));

      const run1 = await importCsv(`Item Name,SKU,Rate\n${RUN} New,${X},5\n`);
      expect(run1.created).toBe(1);
      expect(run1.updated).toBe(0);
      expect(run1.skippedRows).toEqual([]);
      const b = await byName(`${RUN} New`);
      expect(b).not.toBeNull();
      if (b) createdProductIds.push(b.id);
      expect(b?.sku).toBe(X);
      expect(b?.isActive).toBe(true);

      const aAfter1 = await prisma.product.findUnique({ where: { id: a.id } });
      expect(aAfter1?.isActive).toBe(false);
      expect(aAfter1?.sku).toBeNull();

      const run2 = await importCsv(`Item Name,SKU,Rate\n${RUN} New,${X},7\n`);
      expect(run2.created).toBe(0);
      expect(run2.updated).toBe(1);
      const bAfter = await prisma.product.findUnique({ where: { id: b!.id } });
      expect(Number(bAfter?.pricePerUnit)).toBe(7);
      const aAfter2 = await prisma.product.findUnique({ where: { id: a.id } });
      expect(aAfter2).toMatchObject({
        isActive: false,
        sku: null,
        retiredSku: aAfter1?.retiredSku,
        name: `${RUN} Old`,
      });
      expect(Number(aAfter2?.pricePerUnit)).toBe(3);
    });

    it("I12c: an import racing a reactivation of A -> exactly one holder of the code; the loser row has a reason", async () => {
      const code = `${RUN}-RACE`;
      const a = await inTenant(() =>
        productsService.create({
          name: `${RUN} Racer A`,
          sku: code,
          pricePerUnit: 2,
          unit: "unit",
        } as any),
      );
      createdProductIds.push(a.id);
      await inTenant(() => productsService.remove(a.id));

      const [imp, react] = await Promise.allSettled([
        importCsv(`Item Name,SKU,Rate\n${RUN} Racer B,${code},4\n`),
        inTenant(() => productsService.update(a.id, { isActive: true } as any)),
      ]);
      const b = await byName(`${RUN} Racer B`);
      if (b) createdProductIds.push(b.id);
      const aNow = await prisma.product.findUnique({ where: { id: a.id } });

      const holders = await prisma.product.findMany({
        where: { tenantId, sku: code, isActive: true },
      });
      // The one-active-holder invariant holds no matter who won.
      expect(holders.length).toBeLessThanOrEqual(1);

      const importWon = holders.some((h) => h.id === b?.id);
      const reactivateWon = holders.some((h) => h.id === a.id) && aNow?.isActive === true;
      expect(importWon !== reactivateWon).toBe(true); // exactly one wins

      if (importWon) {
        // The reactivation lost: a readable 409, never a raw error.
        expect(react.status).toBe("rejected");
      } else {
        // The import lost: the import itself resolved (no throw) with the row skipped WITH a reason.
        expect(imp.status).toBe("fulfilled");
        const result = (imp as PromiseFulfilledResult<Awaited<ReturnType<typeof importCsv>>>).value;
        expect(result.skipped).toBe(1);
        expect(result.skippedRows[0]?.reason).toMatch(/already used by an active item/);
        expect(result.errors[0]).toMatch(/already used by an active item/);
      }
    });
  },
);
