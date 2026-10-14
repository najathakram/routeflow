/**
 * Row 510 (ruling #2093, 2026-10-13) - real-Postgres proof that HISTORICAL invoice import is exempt, marked and audited,
 * through the real ImportService.importInvoices and the REAL SellingRestrictionsService (rules, labels, addresses):
 *
 *   - a CSV invoice holding a line the engine would breach today IMPORTS (never refused, never skipped), unchanged;
 *   - that invoice item carries the stamp columns: the fixed `Imported (historical)` reason, the IMPORTING user, a time
 *     and ALL the rules matched at import; the clean item of the same invoice carries none;
 *   - one `selling_restriction.overridden` audit row per marked line (documentType INVOICE, no warning hash) plus the
 *     run-level `invoice.import.restricted_lines` row; the report lists the line in `restrictedLines`;
 *   - a customer in a state the rule does not name is imported with no mark and no audit row;
 *   - there is no tenant switch: no `selling_restrictions.enabled` row exists.
 *
 * Collected only by jest.db.config.js. One throwaway `qa-r510-<run>` tenant (assertTestTenant), purged in afterAll.
 */
import { randomUUID } from "crypto";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { ImportService } from "./import.service";
import { ProductsService } from "../products/products.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { RESTRICTION_OVERRIDE_IMPORTED_REASON } from "../selling-restrictions/override-constants";
import {
  purgeOverrideWorld,
  seedOverrideWorld,
  staffPayload,
  type OverrideWorld,
} from "../../test/restriction-override-fixture";

const RUN = randomUUID().slice(0, 8);
const HEADER = "Invoice Number,Customer Name,Total,SubTotal,Item Name,SKU,Quantity,Item Price\n";

describeDb(
  "row 510: a historical invoice import is exempt, marked and audited — real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let importService: ImportService;
    let w: OverrideWorld;
    const skuOf = { banned: `BAN-${RUN}`, clean: `CLN-${RUN}` };

    const csv = (invNo: string, customer: string) =>
      Buffer.from(
        HEADER +
          `${invNo},${customer},30,30,Gummies,${skuOf.banned},2,10\n` +
          `${invNo},${customer},30,30,Water,${skuOf.clean},1,10\n`,
      );
    const run = (buf: Buffer) =>
      tenantCtx.run(w.tenantId, () => importService.importInvoices(buf, w.operatorId));
    const audits = (invoiceId: string) =>
      raw.auditLog.findMany({
        where: {
          tenantId: w.tenantId,
          action: "selling_restriction.overridden",
          meta: { path: ["documentId"], equals: invoiceId },
        },
      });

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const mod = await Test.createTestingModule({
        providers: [
          ImportService,
          NumberingService,
          ExternalRefService,
          SellingRestrictionsService,
          ProductLabelsService,
          {
            provide: ProductsService,
            useValue: {
              create: jest.fn(),
              update: jest.fn(),
              emitCatalogBulkChanged: jest.fn(),
              assertCanFlagTobacco: jest.fn().mockResolvedValue(undefined),
              assertMsrpAllowed: jest.fn().mockResolvedValue(undefined),
            },
          },
          { provide: PrismaService, useValue: prisma },
          { provide: VendorBillsService, useValue: { create: jest.fn(), receive: jest.fn() } },
          {
            provide: CustomersService,
            useValue: {
              assertCustomerCapNotExceeded: jest.fn().mockResolvedValue(undefined),
              maybeStartCustomerGrace: jest.fn().mockResolvedValue(undefined),
            },
          },
        ],
      }).compile();
      importService = mod.get(ImportService);
      w = await seedOverrideWorld(raw, RUN, "import-restriction-marker.db.spec.ts");
      await raw.product.update({ where: { id: w.banned }, data: { sku: skuOf.banned } });
      await raw.product.update({ where: { id: w.clean }, data: { sku: skuOf.clean } });
    }, 120_000);

    afterAll(async () => {
      if (w?.tenantId) {
        await raw.importExternalRef.deleteMany({ where: { tenantId: w.tenantId } }).catch(() => {});
        await purgeOverrideWorld(pool, w.tenantId);
      }
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    it("setup: the tenant has no selling_restrictions.enabled row and the operator is the importer", async () => {
      expect(await raw.systemConfig.count({ where: { tenantId: w.tenantId } })).toBe(0);
      expect(staffPayload(w).sub).toBe(w.operatorId);
    });

    it("a CA customer's invoice with a banned line IMPORTS, the banned item is MARKED and audited, the clean one is not", async () => {
      const result = await run(csv(`INV-R510-${RUN}-1`, "R510 ca co"));
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.errors).toEqual([]);

      const invoice = await raw.invoice.findFirstOrThrow({
        where: { tenantId: w.tenantId, invoiceNumber: `INV-R510-${RUN}-1` },
        include: { items: true },
      });
      expect(invoice.items).toHaveLength(2); // history is not rewritten: both lines imported
      const bannedItem = invoice.items.find((i) => i.productId === w.banned)!;
      expect(bannedItem).toMatchObject({
        restrictionOverrideReason: RESTRICTION_OVERRIDE_IMPORTED_REASON,
        restrictionOverrideBy: w.operatorId,
        restrictionOverrideRuleIds: [`${w.ruleId}:CA`],
      });
      expect(bannedItem.restrictionOverrideAt).toBeInstanceOf(Date);
      const cleanItem = invoice.items.find((i) => i.productId === w.clean)!;
      expect(cleanItem.restrictionOverrideAt).toBeNull();
      expect(cleanItem.restrictionOverrideReason).toBeNull();

      const rows = await audits(invoice.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId: w.operatorId,
        entityType: "InvoiceItem",
        entityId: bannedItem.id,
      });
      expect(rows[0].meta).toMatchObject({
        documentType: "INVOICE",
        productId: w.banned,
        ruleIds: [`${w.ruleId}:CA`],
        reason: RESTRICTION_OVERRIDE_IMPORTED_REASON,
        warningHash: null,
        basis: "CUSTOMER",
      });
      expect(result.restrictedLines).toEqual([
        expect.objectContaining({
          invoiceNumber: `INV-R510-${RUN}-1`,
          productId: w.banned,
        }),
      ]);
      const runRow = await raw.auditLog.findFirst({
        where: { tenantId: w.tenantId, action: "invoice.import.restricted_lines" },
      });
      expect(runRow?.meta).toMatchObject({
        invoiceNumbers: [`INV-R510-${RUN}-1`],
        productIds: [w.banned],
      });
    });

    it("a customer in a state the rule does not name imports with no mark and no audit row", async () => {
      const result = await run(csv(`INV-R510-${RUN}-2`, "R510 tx co"));
      expect(result.imported).toBe(1);
      expect(result.restrictedLines).toEqual([]);
      const invoice = await raw.invoice.findFirstOrThrow({
        where: { tenantId: w.tenantId, invoiceNumber: `INV-R510-${RUN}-2` },
        include: { items: true },
      });
      expect(invoice.items.every((i) => i.restrictionOverrideAt === null)).toBe(true);
      expect(await audits(invoice.id)).toHaveLength(0);
    });
  },
);
