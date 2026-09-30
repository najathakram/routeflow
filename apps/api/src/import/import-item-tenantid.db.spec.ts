/**
 * T6 — the invoice importer's NESTED InvoiceItem create must stamp `tenantId`. Nested creates
 * bypass the forTenant() extension, so an un-stamped item was written with a NULL tenantId (and
 * is refused outright once the tenantId NOT NULL guard lands). Real Postgres, real importer; every
 * tenant is a throwaway `qa-t6imp-*` slug.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { ImportService } from "./import.service";
import { ProductsService } from "../products/products.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
/** A fresh, policy-approved throwaway tenant slug — never reused across tests in this file. */
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-t6imp-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "import-item-tenantid.db.spec.ts",
  );
}

// Year the real generator derives from `new Date().getFullYear()` (LOCAL time, matching
// import.service.ts:540 exactly).
const YEAR = new Date().getFullYear();

describeDb("T6 importer InvoiceItem tenantId — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let importService: ImportService;
  const createdTenantIds: string[] = [];

  const mockVendorBills = { create: jest.fn(), receive: jest.fn() };
  const mockCustomers = {
    assertCustomerCapNotExceeded: jest.fn().mockResolvedValue(undefined),
    maybeStartCustomerGrace: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    // Nothing env-dependent may run at collection time (db-lane.db.spec.ts's rule): the real
    // connection is built here, inside a hook, never at module top level.
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImportService,
        // ImportService injects ProductsService since B858/B859; this spec imports no products,
        // so a stub suffices.
        {
          provide: ProductsService,
          useValue: {
            assertMsrpAllowed: jest.fn(),
            assertCanFlagTobacco: jest.fn(),
            assertIdentityAvailable: jest.fn(),
            assertReorderAllowed: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            emitCatalogBulkChanged: jest.fn(),
          },
        },
        NumberingService,
        // REAL ExternalRefService: T3c's re-import idempotency is exactly the
        // (source, externalId) → invoice mapping it writes, so it must hit Postgres.
        ExternalRefService,
        { provide: PrismaService, useValue: prisma },
        { provide: VendorBillsService, useValue: mockVendorBills },
        { provide: CustomersService, useValue: mockCustomers },
        {
          provide: SellingRestrictionsService,
          useValue: {
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
          },
        },
      ],
    }).compile();

    importService = module.get(ImportService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask the test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.importExternalRef.deleteMany({ where: { tenantId } });
    await prisma.invoicePayment.deleteMany({ where: { invoice: { tenantId } } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.numberingSequence.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string): Promise<{ id: string; slug: string }> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `T6 ${slug}` } });
    createdTenantIds.push(tenant.id);
    return { id: tenant.id, slug };
  }

  /** businessName is returned verbatim so the CSV's "Customer Name" can match it exactly. */
  async function seedCustomer(tenantId: string, businessName: string): Promise<{ id: string }> {
    const idBase = `${tenantId}-${businessName}`.replace(/[^a-z0-9]+/gi, "_");
    const user = await prisma.user.create({
      data: {
        email: `${idBase}@example.invalid`,
        username: idBase,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName, contactName: businessName, tenantId },
    });
    return { id: customer.id };
  }

  it("every InvoiceItem the importer creates carries the importing tenant's id (with and without a SKU line, and the synthesized 'Services' line)", async () => {
    const tenantA = await seedTenant("items");
    await seedCustomer(tenantA.id, "T6 Import Co");
    const csv =
      "Invoice Number,Customer Name,Total,Invoice Status,Balance Due,Item Name,Quantity,Item Price,Item Total\n" +
      `INV-${YEAR}-9001,T6 Import Co,30,Paid,0,Widget,2,15,30\n` +
      `INV-${YEAR}-9002,T6 Import Co,40,Paid,0,Refund,-1,5,-5\n`; // qty <= 0 is skipped -> the synthesized "Services" line

    const result = await tenantCtx.run(tenantA.id, () =>
      importService.importInvoices(Buffer.from(csv), "user-1"),
    );
    expect(result.imported).toBe(2);

    const items = await prisma.invoiceItem.findMany({
      where: { invoice: { tenantId: tenantA.id } },
      select: { description: true, tenantId: true },
    });
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.map((i) => i.description)).toEqual(expect.arrayContaining(["Widget", "Services"]));
    for (const it of items) expect(it.tenantId).toBe(tenantA.id);
  }, 30_000);
});
