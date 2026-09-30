/**
 * #2190 - real Postgres. An invoice CSV whose Total is present but not a number ("12abc") writes NO
 * invoice and no $0 line: the group is skipped with `Total: not a number`. Throwaway `qa-*` tenant
 * (assertTestTenant); afterAll deletes what it made. Runs on the DB lane.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { Client } from "pg";
import { ImportService } from "./import.service";
import { ProductsService } from "../products/products.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const YEAR = new Date().getFullYear();

describeDb("#2190 invoice import: a bad Total writes nothing (real Postgres)", () => {
  let url: string;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let importService: ImportService;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    url = requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImportService,
        NumberingService,
        ExternalRefService,
        // #2185 (B858/B859): ImportService routes product writes through ProductsService; this
        // suite never reaches a product write, so the stub only satisfies DI.
        {
          provide: ProductsService,
          useValue: {
            create: jest.fn().mockResolvedValue({ id: "prod-1" }),
            update: jest.fn().mockResolvedValue({ id: "prod-1" }),
            emitCatalogBulkChanged: jest.fn(),
            assertCanFlagTobacco: jest.fn().mockResolvedValue(undefined),
            assertMsrpAllowed: jest.fn().mockResolvedValue(undefined),
          },
        },
        // #2093: importInvoices flags banned lines (never blocks); ALLOW keeps this suite's rows unflagged.
        {
          provide: SellingRestrictionsService,
          useValue: {
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
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
    importService = module.get(ImportService);
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      await prisma.importExternalRef.deleteMany({ where: { tenantId } }).catch(() => {});
      await prisma.invoicePayment.deleteMany({ where: { invoice: { tenantId } } }).catch(() => {});
      await prisma.invoiceItem.deleteMany({ where: { invoice: { tenantId } } }).catch(() => {});
      await prisma.invoice.deleteMany({ where: { tenantId } }).catch(() => {});
      await prisma.numberingSequence.deleteMany({ where: { tenantId } }).catch(() => {});
      await prisma.customer.deleteMany({ where: { tenantId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { tenantId } }).catch(() => {});
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    }
    await prisma?.$disconnect();
  });

  async function seed(label: string) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-i2190-${RUN}-${seq}-${label}`,
      "import-invoice-money-2190.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `qa ${slug}` } });
    tenantIds.push(tenant.id);
    const idBase = `${tenant.id}-cust`.replace(/[^a-z0-9]+/gi, "_");
    const user = await prisma.user.create({
      data: {
        email: `${idBase}@example.invalid`,
        username: idBase,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: "QA Import Co",
        contactName: "QA",
        tenantId: tenant.id,
      },
    });
    return { tenantId: tenant.id, customerId: customer.id };
  }

  const importInvoices = (tenantId: string, csv: string) =>
    tenantCtx.run(tenantId, () => importService.importInvoices(Buffer.from(csv), "user-1"));

  const csv = (total: string) =>
    "Invoice Number,Customer Name,Total,Item Name,Quantity,Item Price\n" +
    `INV-${YEAR}-9190,QA Import Co,"${total}",Widget,1,10\n`;

  it("Total '12abc' is skipped with a reason; no invoice, no $0 line", async () => {
    const { tenantId } = await seed("bad-total");
    const r = await importInvoices(tenantId, csv("12abc"));
    expect(r.imported).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.errors).toEqual([expect.stringContaining("Total: not a number")]);
    expect(await prisma.invoice.count({ where: { tenantId } })).toBe(0);
    expect(await prisma.invoiceItem.count({ where: { invoice: { tenantId } } })).toBe(0);
  }, 30_000);

  it("control: a valid Total imports the invoice", async () => {
    const { tenantId } = await seed("ok-total");
    const r = await importInvoices(tenantId, csv("$1,234.50"));
    expect(r.imported).toBe(1);
    const inv = await prisma.invoice.findFirstOrThrow({ where: { tenantId } });
    expect(Number(inv.total)).toBe(1234.5);
  }, 30_000);
});
