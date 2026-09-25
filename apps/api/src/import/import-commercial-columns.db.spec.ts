/**
 * B858 + B859 — P16, NEED-DB. An all-columns fixture imported twice against real Postgres proves
 * three properties that can't be trusted from a mocked PrismaService alone (bug-test-plan.md):
 *   1. re-importing the same file is idempotent (run 2 reports updated:0, every row's changes:{})
 *   2. no code path in the import chain ever writes `averageCost` (SA-284 pin — the column must
 *      stay NULL on every product this run touches, on real Postgres column defaults/constraints,
 *      not a mocked resolver)
 *   3. consent audit evidence is written exactly once per channel actually changed, never doubled
 *      by a re-upload
 *
 * NOT part of RT1's engine scope (build-plan.md RT1 / bug-test-plan.md): this file needs a live
 * compose Postgres and is excluded from every engine-run command (red gate, perRound, final). It
 * runs only under `npm run local:test:db` per CLAUDE.md's DB-spec lane. Per project rule
 * ("Builders post NEED-DB first — never run DB specs on the compose stack; the prover owns it")
 * this file is authored but never executed here.
 *
 * Targets the approved `test` tenant only (bug-test-plan.md P16), never a throwaway `qa-*` slug —
 * this fixture exercises the tenant's real billing/addon/plan-flag state as seeded by
 * `local:seed`'s genesis catalog publish, not a synthetic one. `assertTestTenant` still gates the
 * slug (defense in depth: a copy-paste of this file into a script must fail the same way). Rows
 * this run creates are tagged with a unique run marker (SKU / businessName suffix) so `afterAll`
 * deletes precisely what it created and never touches other fixture data living in `test`.
 *
 * Follows the tenant-setup/cleanup pattern of `import-item-tenantid.db.spec.ts` /
 * `import-numbering.db.spec.ts`: real `PrismaService` + `TenantContextService`, real
 * `NumberingService` / `ExternalRefService` (already the pattern for `ImportService`'s existing DB
 * specs), and — new here — real `ProductsService`, `CustomersService`, `AuditService` so the
 * properties above are proven through the actual persistence path FIX2/FIX3 wire up, not a mock
 * boundary. Peripheral collaborators that are not this fixture's concern (storage, addon/plan-flag
 * gating, the realtime gateway, billing/commission/regulated-ledger/email) are stubbed to
 * "everything permitted, no side channel" — P6/P7's gate-refusal behavior is proven elsewhere
 * (`import-commercial-columns.spec.ts`), not here.
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

const RUN_MARKER = `B858DB${randomUUID().slice(0, 8)}`;

describeDb(
  "P16 — import-commercial-columns idempotency, no averageCost, single consent audit (real Postgres)",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let importService: ImportService;
    let tenantId: string;
    const createdProductIds: string[] = [];
    const createdCustomerIds: string[] = [];
    const createdUserIds: string[] = [];

    beforeAll(async () => {
      // Nothing env-dependent may run at collection time (db-lane.db.spec.ts's rule): the real
      // connection is built here, inside a hook, never at module top level.
      requireLocalDatabaseUrl();
      const tenantSlug = assertTestTenant("test", "import-commercial-columns.db.spec.ts");
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();

      const tenant = await prisma.tenant.findFirst({ where: { slug: tenantSlug } });
      if (!tenant) {
        throw new Error(
          `Approved test tenant "${tenantSlug}" not found — run \`npm run local:seed\` first.`,
        );
      }
      tenantId = tenant.id;

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ImportService,
          NumberingService,
          ExternalRefService,
          ProductsService,
          CustomersService,
          AuditService,
          { provide: PrismaService, useValue: prisma },
          { provide: VendorBillsService, useValue: { create: jest.fn(), receive: jest.fn() } },
          // ProductsService peripherals — everything permitted, no side channel. Gate-refusal
          // behavior (P6/P7) is proven against a mocked ProductsService in
          // import-commercial-columns.spec.ts, not here.
          { provide: StorageService, useValue: {} },
          { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(true) } },
          { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
          {
            provide: EntitlementsService,
            useValue: { hasFlag: jest.fn().mockResolvedValue(true) },
          },
          { provide: PlanCatalogService, useValue: { upgradeTargetForFlag: jest.fn() } },
          { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
          // CustomersService peripherals — same "everything permitted" stance.
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
      // Never delete the shared `test` tenant itself — only the rows this run tagged.
      await prisma.auditLog
        .deleteMany({ where: { tenantId, entityId: { in: createdCustomerIds } } })
        .catch(() => {});
      if (createdProductIds.length > 0) {
        await prisma.product
          .deleteMany({ where: { id: { in: createdProductIds } } })
          .catch(() => {});
      }
      if (createdCustomerIds.length > 0) {
        await prisma.customer
          .deleteMany({ where: { id: { in: createdCustomerIds } } })
          .catch(() => {});
      }
      if (createdUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
      }
      await prisma?.$disconnect();
    });

    function productsCsv(): string {
      return (
        "Item Name,SKU,Rate,Units Per Box,Price Tier 2,Barcode,Category,Standard Cost\n" +
        `${RUN_MARKER} Widget,${RUN_MARKER}-SKU,10.5,12,9.5,${RUN_MARKER}-BC,Widgets,5\n`
      );
    }

    function contactsCsv(): string {
      return (
        "Customer Name,Customer ID,Payment Terms,Pricing Tier,Credit Limit,Tax Exempt,Tax ID,SMS Consent\n" +
        `${RUN_MARKER} Customer,${RUN_MARKER}-ZC,Net 30,3,1500,Yes,12-3456789,Yes\n`
      );
    }

    it("re-importing the same products file is idempotent, writes no averageCost, and audits consent once", async () => {
      // Run 1 — creates.
      const run1Products = await tenantCtx.run(tenantId, () =>
        importService.importProducts(Buffer.from(productsCsv()), "user-1"),
      );
      expect(run1Products.imported).toBe(1);

      const created = await prisma.product.findFirst({
        where: { tenantId, sku: `${RUN_MARKER}-SKU` },
      });
      expect(created).not.toBeNull();
      if (created) createdProductIds.push(created.id);
      // SA-284 pin: nothing in the import path writes averageCost, on real Postgres — not a
      // mocked resolver's assumption about the column.
      expect((created as any)?.averageCost ?? null).toBeNull();

      // Run 2 — same file, same tenant: must be a true no-op (no new product, no diff).
      const run2Products = await tenantCtx.run(tenantId, () =>
        importService.importProducts(Buffer.from(productsCsv()), "user-1"),
      );
      expect((run2Products as any).updated ?? 0).toBe(0);
      const rows2 = (run2Products as any).rows ?? [];
      for (const row of rows2) {
        expect(row.changes ?? {}).toEqual({});
      }

      const afterBoth = await prisma.product.findMany({
        where: { tenantId, sku: `${RUN_MARKER}-SKU` },
      });
      expect(afterBoth).toHaveLength(1); // no duplicate row created by the re-upload
    }, 30_000);

    it("re-importing the same contacts file does not duplicate the consent AuditLog row", async () => {
      const run1Contacts = await tenantCtx.run(tenantId, () =>
        importService.importContacts(Buffer.from(contactsCsv()), "user-1"),
      );
      expect(run1Contacts.created).toBe(1);

      const customer = await prisma.customer.findFirst({
        where: { tenantId, zohoContactId: `${RUN_MARKER}-ZC` },
      });
      expect(customer).not.toBeNull();
      if (customer) {
        createdCustomerIds.push(customer.id);
        createdUserIds.push((customer as any).userId);
      }

      // Run 2 — same file: the SMS consent value hasn't changed, so no second AuditLog row.
      await tenantCtx.run(tenantId, () =>
        importService.importContacts(Buffer.from(contactsCsv()), "user-1"),
      );

      const auditRows = customer
        ? await prisma.auditLog.findMany({
            where: {
              tenantId,
              entityId: customer.id,
              action: "customer.consent.import",
            },
          })
        : [];
      expect(auditRows).toHaveLength(1);
    }, 30_000);
  },
);
