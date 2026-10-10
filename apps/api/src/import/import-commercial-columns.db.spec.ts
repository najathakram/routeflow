/**
 * B858 + B859 — P16, NEED-DB. An all-columns fixture imported twice against real Postgres proves
 * three properties that can't be trusted from a mocked PrismaService alone (bug-test-plan.md):
 *   1. re-importing the same file is idempotent (run 2 reports updated:0, every row's changes:{})
 *   2. no code path in the import chain ever writes `averageCost` (SA-284 pin — the column must
 *      stay NULL on every product this run touches, on real Postgres column defaults/constraints,
 *      not a mocked resolver)
 *   3. consent audit evidence is written exactly once per channel actually changed, never doubled
 *      by a re-upload
 *   4. SA-305 (2): consent and its evidence roll back TOGETHER in one real transaction — a failing
 *      evidence insert leaves the flag unchanged; a failing flag update leaves no evidence row
 *
 * R1 (Opus round 2): Reorder Point / Reorder Qty must land on the FIRST create (ProductsService
 * .create writes them in its one create) — run 1 asserts 4 / 48 on the row, and run 2 must then
 * plan no reorder change (`updated` 0, `update` never called).
 *
 * The fixtures carry EVERY registry column (SA-284 pin: "an all-columns fixture run twice; the
 * second run shows no diffs"). Tobacco is "No" so the run never seeds the tenant's Tobacco type.
 *
 * NOT part of RT1's engine scope (build-plan.md RT1 / bug-test-plan.md): this file needs a live
 * compose Postgres and is excluded from every engine-run command (red gate, perRound, final). It
 * runs only under `npm run local:test:db` per CLAUDE.md's DB-spec lane. Per project rule
 * ("Builders post NEED-DB first — never run DB specs on the compose stack; the prover owns it")
 * this file is authored but never executed here.
 *
 * Creates its own throwaway `qa-2185-<run>` tenant in `beforeAll` (CI's db-migrations job runs
 * this lane against a fresh, unseeded database, so it can't depend on `local:seed`'s `test`
 * tenant existing). Every billing/addon/plan-flag/entitlement collaborator below is stubbed to
 * "everything permitted" regardless of tenant state, so the fixture never needs the seeded
 * tenant's real plan/catalog data — only a bare tenant row for the products/customers this run
 * creates to hang off. `assertTestTenant` still gates the slug (defense in depth: a copy-paste of
 * this file into a script must fail the same way). `afterAll` deletes every row this run created,
 * in FK-safe order, then the tenant itself.
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

const RUN_MARKER = `B858DB${randomUUID().slice(0, 8)}`;

describeDb(
  "P16 — import-commercial-columns idempotency, no averageCost, single consent audit (real Postgres)",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let importService: ImportService;
    let productsService: ProductsService;
    let customersService: CustomersService;
    let tenantId: string;
    const createdProductIds: string[] = [];
    const createdCustomerIds: string[] = [];
    const createdUserIds: string[] = [];

    beforeAll(async () => {
      // Nothing env-dependent may run at collection time (db-lane.db.spec.ts's rule): the real
      // connection is built here, inside a hook, never at module top level.
      requireLocalDatabaseUrl();
      const tenantSlug = assertTestTenant(
        `qa-2185-${RUN_MARKER.toLowerCase()}`,
        "import-commercial-columns.db.spec.ts",
      );
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();

      // A bare throwaway tenant — every billing/addon/plan-flag collaborator below is stubbed to
      // "permitted" so this fixture never needs the seeded `test` tenant's real plan/catalog state.
      const tenant = await prisma.tenant.create({
        data: { slug: tenantSlug, name: `B858 ${tenantSlug}` },
      });
      tenantId = tenant.id;

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ImportService,
          NumberingService,
          ExternalRefService,
          ProductsService,
          // flag.forecasting gate for reorder writes (assertReorderAllowed) — permitted here.
          { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(true) } },
          { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
          CustomersService,
          AuditService,
          { provide: PrismaService, useValue: prisma },
          { provide: VendorBillsService, useValue: { create: jest.fn(), receive: jest.fn() } },
          // #2093: importInvoices flags banned lines (never blocks); ALLOW keeps this suite's rows unflagged.
          {
            provide: SellingRestrictionsService,
            useValue: {
              checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
            },
          },
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
      productsService = module.get(ProductsService);
      customersService = module.get(CustomersService);
    });

    afterEach(() => jest.restoreAllMocks());

    afterAll(async () => {
      // This run's own throwaway tenant — delete every row it created, children before the
      // tenant itself (Product/Customer/User/CustomerAddress carry no onDelete: Cascade to
      // Tenant — the FK is an optional scalar that would only SET NULL, leaving orphan rows
      // behind — so each child table is cleared explicitly before `tenant.delete`).
      // Never run a tenant-wide delete without the tenant: Prisma drops an `undefined` filter,
      // so `{ tenantId: undefined }` would match every audit row in the database.
      if (!tenantId) {
        await prisma?.$disconnect();
        return;
      }
      // Every audit row of the throwaway tenant (product and customer events alike) — left
      // behind, tenant.delete would SET NULL them into null-tenant orphans.
      await prisma.auditLog.deleteMany({ where: { tenantId } }).catch(() => {});
      if (createdProductIds.length > 0) {
        await prisma.product
          .deleteMany({ where: { id: { in: createdProductIds } } })
          .catch(() => {});
      }
      if (createdCustomerIds.length > 0) {
        await prisma.customerAddress
          .deleteMany({ where: { customerId: { in: createdCustomerIds } } })
          .catch(() => {});
        await prisma.contactPerson
          .deleteMany({ where: { customerId: { in: createdCustomerIds } } })
          .catch(() => {});
        await prisma.customer
          .deleteMany({ where: { id: { in: createdCustomerIds } } })
          .catch(() => {});
      }
      if (createdUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
      }
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
      await prisma?.$disconnect();
    });

    function productsCsv(): string {
      return (
        "Item Name,SKU,Barcode,Unit,Rate,Price Tier 2,Price Tier 3,Price Tier 4,Price Tier 5," +
        "Units Per Box,Category,Description,Cost,MSRP,Tobacco,Reorder Point,Reorder Qty\n" +
        `${RUN_MARKER} Widget,${RUN_MARKER}-SKU,${RUN_MARKER}-BC,case,10.5,9.5,9.25,9,8.75,` +
        "12,Widgets,All-columns fixture,5.1234,19.99,No,4,48\n"
      );
    }

    function contactsCsv(): string {
      const future = `${new Date().getUTCFullYear() + 2}-06-30`;
      return (
        "Customer Name,Customer ID,Payment Terms,Pricing Tier,Credit Limit,Tax Exempt,Tax ID," +
        "Tobacco Licence No,Tobacco Licence Expiry,Delivery Window Start,Delivery Window End," +
        "SMS Consent,WhatsApp Consent,Notes,Phone,Billing Address,Billing City,Billing State," +
        "Billing Code\n" +
        `${RUN_MARKER} Customer,${RUN_MARKER}-ZC,30,3,1500,Yes,12-3456789,TL-${RUN_MARKER},` +
        `${future},08:00,12:00,Yes,Yes,Fixture notes,555-0100,1 Test Way,Testville,CA,90001\n`
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
      // Every column landed, at its own column precision (cost at 4dp, never cents — M2).
      expect(created).toMatchObject({
        barcode: `${RUN_MARKER}-BC`,
        unit: "case",
        unitsPerBox: 12,
        category: "Widgets",
        description: "All-columns fixture",
        isTobacco: false,
        reorderPoint: 4,
        reorderQty: 48,
      });
      expect(Number(created?.pricePerUnit)).toBe(10.5);
      expect(Number(created?.priceTier5)).toBe(8.75);
      expect(Number(created?.standardCost)).toBe(5.1234);
      expect(Number(created?.msrp)).toBe(19.99);

      // Run 2 — same file, same tenant: must be a true no-op (no new product, no diff, no write).
      const update = jest.spyOn(productsService, "update");
      const create = jest.spyOn(productsService, "create");
      const run2Products = await tenantCtx.run(tenantId, () =>
        importService.importProducts(Buffer.from(productsCsv()), "user-1"),
      );
      expect(run2Products.updated).toBe(0);
      expect(run2Products.unchanged).toBe(1);
      expect(run2Products.skippedRows).toEqual([]);
      expect(run2Products.rows).toEqual([
        expect.objectContaining({ action: "update", changes: {} }),
      ]);
      expect(update).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();

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

      expect(customer).toMatchObject({
        defaultPaymentTerms: "Net 30",
        pricingTier: 3,
        isTaxExempt: true,
        taxId: "12-3456789",
        tobaccoLicenseNo: `TL-${RUN_MARKER}`,
        deliveryWindowStart: "08:00",
        deliveryWindowEnd: "12:00",
        smsConsent: true,
        waConsent: true,
      });
      expect(Number(customer?.creditLimit)).toBe(1500);
      expect(customer?.consentUpdatedAt).not.toBeNull();

      // Run 2 — same file: nothing commercial differs, so no commercial write and no consent
      // write (hence no second AuditLog row).
      const update = jest.spyOn(customersService, "update");
      const consent = jest.spyOn(customersService, "setCustomerConsent");
      const run2Contacts = await tenantCtx.run(tenantId, () =>
        importService.importContacts(Buffer.from(contactsCsv()), "user-1"),
      );
      expect(run2Contacts.skippedRows).toEqual([]);
      expect(run2Contacts.warnings).toEqual([]);
      expect(run2Contacts.rows).toEqual([
        expect.objectContaining({ action: "update", changes: {} }),
      ]);
      expect(update).not.toHaveBeenCalled();
      expect(consent).not.toHaveBeenCalled();

      const auditRows = customer
        ? await prisma.auditLog.findMany({
            where: {
              tenantId,
              entityId: customer.id,
              action: "customer.consent.import",
            },
          })
        : [];
      // One evidence row per channel granted on run 1 (sms + wa), none added by run 2.
      expect(auditRows).toHaveLength(2);
      expect(auditRows.map((r) => (r.meta as any)?.channel).sort()).toEqual(["sms", "wa"]);
      for (const r of auditRows) {
        expect(r.meta).toMatchObject({ source: "import", userId: "user-1", row: 1, value: true });
      }
    }, 30_000);

    /** Runs the NEXT tenantTransaction with one model method replaced by a thrower. */
    function failInsideNextTransaction(model: "auditLog" | "customer", method: string) {
      const original = prisma.tenantTransaction.bind(prisma);
      jest.spyOn(prisma, "tenantTransaction").mockImplementationOnce(((fn: any, opts?: any) =>
        original(
          (tx: any) =>
            fn(
              new Proxy(tx, {
                get(target, prop) {
                  const value = target[prop];
                  if (prop !== model) return value;
                  return new Proxy(value, {
                    get(delegate, m) {
                      if (m === method) {
                        return async () => {
                          throw new Error(`${model}.${method} failed`);
                        };
                      }
                      const fnOrValue = delegate[m];
                      return typeof fnOrValue === "function" ? fnOrValue.bind(delegate) : fnOrValue;
                    },
                  });
                },
              }),
            ),
          opts,
        )) as any);
    }

    it("SA-305 (2): consent and its evidence roll back together on real Postgres (both directions)", async () => {
      const probeCsv =
        "Customer Name,Customer ID\n" + `${RUN_MARKER} Consent Probe,${RUN_MARKER}-CP\n`;
      await tenantCtx.run(tenantId, () =>
        importService.importContacts(Buffer.from(probeCsv), "user-1"),
      );
      const probe = await prisma.customer.findFirst({
        where: { tenantId, zohoContactId: `${RUN_MARKER}-CP` },
      });
      expect(probe).not.toBeNull();
      if (!probe) return;
      createdCustomerIds.push(probe.id);
      createdUserIds.push((probe as any).userId);
      const evidenceCount = () =>
        prisma.auditLog.count({ where: { tenantId, entityId: probe.id } });
      expect(probe.smsConsent).toBe(false);
      expect(await evidenceCount()).toBe(0);

      // Direction 1: the evidence insert fails -> the consent flag write rolls back with it.
      failInsideNextTransaction("auditLog", "create");
      await expect(
        tenantCtx.run(tenantId, () =>
          customersService.setCustomerConsent(
            probe.id,
            { smsConsent: true },
            { userId: "user-1", source: "import" },
          ),
        ),
      ).rejects.toThrow("auditLog.create failed");
      const afterEvidenceFailure = await prisma.customer.findUnique({ where: { id: probe.id } });
      expect(afterEvidenceFailure?.smsConsent).toBe(false);
      expect(afterEvidenceFailure?.consentUpdatedAt ?? null).toBeNull();
      expect(await evidenceCount()).toBe(0);

      // Direction 2: the consent flag update fails -> no evidence row is left behind.
      failInsideNextTransaction("customer", "update");
      await expect(
        tenantCtx.run(tenantId, () =>
          customersService.setCustomerConsent(
            probe.id,
            { smsConsent: true },
            { userId: "user-1", source: "import" },
          ),
        ),
      ).rejects.toThrow("customer.update failed");
      expect(await evidenceCount()).toBe(0);

      // Control: with nothing failing, the flag and one evidence row land together.
      await tenantCtx.run(tenantId, () =>
        customersService.setCustomerConsent(
          probe.id,
          { smsConsent: true },
          { userId: "user-1", source: "import" },
        ),
      );
      const granted = await prisma.customer.findUnique({ where: { id: probe.id } });
      expect(granted?.smsConsent).toBe(true);
      expect(await evidenceCount()).toBe(1);
    }, 30_000);
  },
);
