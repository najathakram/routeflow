/**
 * SA-823 PR-2 (row 655), NEED-DB: the Family / Variant name columns of POST /import/products against real Postgres.
 * Proves what the mocked import-family-columns.spec.ts cannot: the real update() reparent branch (label kept, stock and
 * price columns untouched), the REAL `product.family_assigned` audit rows in the same transaction, ONE FAMILY container
 * for N rows, an idempotent rerun, and the per-row APPLY TIME that decides whether apply moves to the background job
 * (SA-823 section 5: > 60 s at the 2,500-row cap, i.e. > 24 ms per row).
 *
 * UNRUN by the builder (needs a Docker host); the lead routes it: `npm run local:test:db -- product-family-import`.
 * Throwaway `qa-*` tenant, every collaborator not under test stubbed to "permitted" like import-commercial-columns.db.spec.ts.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { ImportService } from "./import.service";
import {
  ProductFamilyImportService,
  IMPORT_FAMILY_MAX_ROWS,
} from "./product-family-import.service";
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

const RUN = `FAM${randomUUID().slice(0, 8)}`;

describeDb("SA-823 PR-2: family import columns (real Postgres)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let importService: ImportService;
  let tenantId: string;
  let pricingMode = "off";

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    const slug = assertTestTenant(`qa-${RUN.toLowerCase()}`, "product-family-import.db.spec.ts");
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

  it("R1/R2/R7/R9: regroup by SKU, one FAMILY container, real audit rows, history untouched, idempotent rerun", async () => {
    const p1 = await seed(`${RUN}-A1`, `${RUN} Cola 12oz`);
    const p2 = await seed(`${RUN}-A2`, `${RUN} Cola 1L`, { pricePerUnit: "7.00" });
    const file =
      "Item Name,SKU,Rate,Family,Variant Name\n" +
      `,${RUN}-A1,,${RUN} Cola,12oz\n` +
      `,${RUN}-A2,,${RUN} Cola,1L\n` +
      `${RUN} Cola Zero,${RUN}-A3,4,${RUN} Cola,Zero\n`;

    const preview = await run(file, true);
    expect(preview.families?.familiesToCreate).toEqual([{ name: `${RUN} Cola`, rows: 3 }]);
    expect(await prisma.product.count({ where: { tenantId, kind: "FAMILY" } })).toBe(0);

    const applied = await run(file);
    expect(applied.skipped).toBe(0);
    expect([applied.created, applied.updated]).toEqual([1, 2]);
    expect(applied.rows.map((r) => [r.row, r.action])).toEqual(
      preview.rows.map((r) => [r.row, r.action]),
    );

    const families = await prisma.product.findMany({ where: { tenantId, kind: "FAMILY" } });
    expect(families).toHaveLength(1);
    expect(families[0].name).toBe(`${RUN} Cola`);
    expect(Number(families[0].pricePerUnit)).toBe(4);
    expect(Number(families[0].currentStock)).toBe(0);

    const after = await prisma.product.findMany({ where: { id: { in: [p1.id, p2.id] } } });
    for (const row of after) {
      expect(row.kind).toBe("VARIANT");
      expect(row.parentProductId).toBe(families[0].id);
      expect(Number(row.currentStock)).toBe(40);
    }
    expect(Number(after.find((r) => r.id === p1.id)!.pricePerUnit)).toBe(5);
    expect(after.find((r) => r.id === p1.id)!.name).toBe("12oz");

    const audits = await prisma.auditLog.findMany({
      where: { tenantId, action: "product.family_assigned" },
    });
    expect(audits).toHaveLength(3);
    expect(audits.every((a) => (a.meta as { via?: string }).via === "import")).toBe(true);
    expect(
      await prisma.auditLog.count({ where: { tenantId, action: "import.products.applied" } }),
    ).toBe(1);

    const again = await run(file);
    expect([again.created, again.updated, again.unchanged]).toEqual([0, 0, 3]);
    expect(await prisma.product.count({ where: { tenantId, kind: "FAMILY" } })).toBe(1);

    // R7: a move to another family carries from / to in the audit row
    const moveFile = `Item Name,SKU,Family,Variant Name\n,${RUN}-A1,${RUN} Cola Max,12oz\n`;
    const moved = await run(moveFile);
    expect(moved.families?.moves).toBe(1); // lead ruling: a move = the product leaves a previous family, new target or not
    const move = await prisma.auditLog.findFirst({
      where: { tenantId, action: "product.family_assigned", entityId: p1.id },
      orderBy: { createdAt: "desc" },
    });
    expect((move!.meta as { fromParentId: string }).fromParentId).toBe(families[0].id);
  });

  it("R6: family pricing (mixed_packs) ON refuses the whole file and writes nothing", async () => {
    pricingMode = "on";
    try {
      const before = await prisma.product.count({ where: { tenantId } });
      await expect(run(`Item Name,SKU,Family\n,${RUN}-A1,${RUN} Other\n`)).rejects.toMatchObject({
        status: 409,
      });
      expect(await prisma.product.count({ where: { tenantId } })).toBe(before);
    } finally {
      pricingMode = "off";
    }
  });

  it("MEASURE: apply time per regrouped row (decides the 60 s background-job question at the 2,500-row cap)", async () => {
    const N = 200;
    const lines: string[] = [];
    for (let i = 0; i < N; i++) {
      await seed(`${RUN}-B${i}`, `${RUN} Bulk ${i}`);
      lines.push(`,${RUN}-B${i},,${RUN} Bulk,V${i}`);
    }
    const file = `Item Name,SKU,Rate,Family,Variant Name\n${lines.join("\n")}\n`;
    const t0 = Date.now();
    const r = await run(file);
    const ms = Date.now() - t0;
    const perRow = ms / N;
    // eslint-disable-next-line no-console
    console.log(
      `family import apply: ${N} rows in ${ms} ms = ${perRow.toFixed(1)} ms/row -> ${IMPORT_FAMILY_MAX_ROWS} rows ~ ${((perRow * IMPORT_FAMILY_MAX_ROWS) / 1000).toFixed(0)} s (limit 60 s)`,
    );
    expect(r.skipped).toBe(0);
    expect(r.updated).toBe(N);
  }, 300_000);
});
